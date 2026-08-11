import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import type { Authenticator, AuthUser, Permission, SessionAccess } from '@moxxy/companion-contracts';
import type { Role } from '@moxxy/companion-types';
import { StatusError, type RbacReader } from '@moxxy/companion-core/server';
import { readRegularTextFile } from '@moxxy/companion-services';
import type {
  AccountInfo,
  ApiTokenCapability,
  ApiTokenRecord,
  AuthProvider,
  CreateApiTokenResponse,
  MfaChallenge,
  SessionInfo,
  SessionRecord,
  UserRecord,
} from '../contract/index.js';
import type { Mfa } from './mfa.js';
import type { UsersStore } from './users-store.js';
import type { SessionsStore } from './sessions-store.js';
import type { ApiTokensStore } from './api-tokens-store.js';
import type { SettingsStore } from './settings-store.js';
import type { RolesService } from './roles-service.js';
import { hashPassword, passwordNeedsRehash, verifyPassword } from './passwords.js';

/** The capability the install must never lose: without it nobody can fix roles. */
const MANAGE_USERS = 'users:manage' as Permission;

/** Absolute session lifetime: a session ends this long after sign-in, full
 *  stop. Use never renews it (there is no sliding window). The opt-in idle
 *  timeout (core config `idleTimeoutMinutes`) can only end a session sooner. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
/** last_seen_at write throttle: one UPDATE per session per minute, so activity
 *  tracking costs nothing measurable on the per-request hot path. */
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const API_TOKEN_TOUCH_INTERVAL_MS = 5 * 60_000;
const MAX_API_TOKENS_PER_USER = 50;
const TOKEN_MANAGEMENT_PERMISSIONS = new Set<Permission>(['tokens:manage', 'tokens:admin']);
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_KEYS = 10_000;
/** A pending second factor is a pause in one sign-in, not a parking space. */
const MFA_PENDING_TTL_MS = 5 * 60_000;
const MAX_PENDING_MFA = 10_000;

/** A legacy `.env` account, seeded once into an empty user store. */
export interface SeedUser {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly role: Role;
}

/** Extends the kernel's StatusError so the router forwards its 401/403 (only
 *  framework errors status-map; a GitHubError's upstream status becomes a 500). */
/** The account a trusted local installation acts through. */
const LOCAL_ADMIN = 'admin';
/** Removed in the passwordless local flow; cleared when an older home boots. */
const LEGACY_LOCAL_SEED_KEY = 'auth.localSeedPassword';

export class AuthError extends StatusError {
  constructor(
    message: string,
    status: 401 | 403 | 429 | 503,
    readonly retryAfter?: number,
  ) {
    super(status, message);
  }
}

/**
 * Credential + session + account authority. Accounts live in the users table
 * (scrypt hashes); a clean install has none and runs first-boot onboarding.
 * Sessions are DB rows keyed by the SHA-256 of the bearer token. RBAC checks
 * read the live effective grid (assembled from the enabled modules) via `rbac`.
 */
export class Auth implements Authenticator {
  private readonly loginThrottle = new LoginThrottle();
  private bootstrapDigest: Buffer | null = null;
  private bootstrapFile: string | null = null;
  /** Password-verified logins awaiting their second factor, keyed by token hash. */
  private readonly pendingMfa = new Map<string, { username: string; expiresAt: number }>();

  constructor(
    private readonly users: UsersStore,
    private readonly sessions: SessionsStore,
    private readonly apiTokens: ApiTokensStore,
    private readonly settings: SettingsStore,
    private readonly rbac: RbacReader,
    private readonly roles: RolesService,
    private readonly mfa: Mfa | null = null,
    /** Live idle bound in ms; 0 disables. A thunk so config edits apply without restart. */
    private readonly idleTimeoutMs: () => number = () => 0,
  ) {
    this.sessions.pruneExpired();
    this.apiTokens.pruneExpired();
  }

  // ---------- external identity providers ----------

  /**
   * Registered by identity modules in `onEnable` and dropped in `onDisable`, so
   * the set follows the module lifecycle with no kernel involvement.
   *
   * Note what is NOT pluggable: `verify()`. Token verification runs on every
   * request and an SSO module does not want to own it; what it needs to
   * contribute is how a user PROVES who they are the first time, after which
   * Companion mints an ordinary session. Keeping the split here is why adding
   * SSO touches no hot path.
   */
  private readonly authProviders = new Map<string, AuthProvider>();

  registerProvider(provider: AuthProvider): () => void {
    this.authProviders.set(provider.id, provider);
    return () => void this.authProviders.delete(provider.id);
  }

  providers(): AuthProvider[] {
    return [...this.authProviders.values()];
  }

  /**
   * Complete an external sign-in. The caller has already verified the assertion:
   * it is in-process module code, the same trust boundary as everything else the
   * kernel loads, so this does not re-check a protocol it does not understand.
   *
   * Provisioning is off by default and never creates an administrator. An SSO
   * misconfiguration should lock people out, not silently hand the instance to
   * whoever authenticates first.
   */
  signInExternal(
    input: { username: string; email?: string; displayName?: string },
    policy: { provision: boolean; role: Role },
  ): { token: string; user: AuthUser; expiresAt: number } {
    const existing = this.users.get(input.username);
    if (existing) {
      if (existing.disabled) throw new AuthError('account is disabled', 403);
      return this.startSession(existing, SESSION_TTL_MS);
    }
    if (!policy.provision) {
      throw new AuthError(`no account for '${input.username}' and just-in-time provisioning is off`, 403);
    }
    if (this.rbac.has(policy.role, MANAGE_USERS)) {
      throw new AuthError(`refusing to provision '${input.username}' into '${policy.role}': it can manage users`, 403);
    }
    if (input.email && this.users.getByEmail(input.email)) {
      throw new AuthError(
        `refusing to provision '${input.username}': email ${input.email} already belongs to another account`,
        403,
      );
    }
    this.users.insert({
      username: input.username,
      displayName: input.displayName?.trim() ?? '',
      email: input.email ?? '',
      // No local password: a random one nobody holds, so the account can only be
      // reached through the provider that created it until an admin resets it.
      passwordHash: hashPassword(randomBytes(32).toString('hex')),
      role: policy.role,
    });
    return this.startSession(this.users.get(input.username)!, SESSION_TTL_MS);
  }

  /** One-time import of legacy accounts into an EMPTY users table. */
  seedFromEnv(users: readonly SeedUser[]): void {
    if (this.users.count() > 0 || users.length === 0) return;
    for (const u of users) {
      this.users.insert({ username: u.username, email: u.email, passwordHash: hashPassword(u.password), role: u.role });
    }
  }

  /** Oldest enabled admin — the local operator identity used for one-machine
   * integrations such as adopting the active gh CLI account at daemon boot. */
  primaryAdminUsername(): string | null {
    return this.users.list().find((user) => user.role === 'admin' && !user.disabled)?.username ?? null;
  }

  setupNeeded(): boolean {
    return this.users.count() === 0;
  }

  /** Arm first-account creation with an operator-held, one-time capability. */
  prepareBootstrap(configuredToken: string | null, file: string): 'environment' | 'file' | null {
    if (!this.setupNeeded()) {
      rmSync(file, { force: true });
      this.bootstrapDigest = null;
      this.bootstrapFile = null;
      return null;
    }
    const token = configuredToken?.trim() || readOrCreateBootstrapToken(file);
    if (token.length < 32) {
      throw new Error('COMPANION_BOOTSTRAP_TOKEN must contain at least 32 characters');
    }
    this.bootstrapDigest = digestBootstrap(token);
    this.bootstrapFile = configuredToken?.trim() ? null : file;
    if (configuredToken?.trim()) rmSync(file, { force: true });
    return configuredToken?.trim() ? 'environment' : 'file';
  }

  /** Ensure local mode always has a real superadmin identity. The password is
   * deliberately unknowable: browser admission happens by minting an ordinary
   * session at the loopback-only route, never by exposing a reusable secret. */
  seedLocalAdmin(): string | null {
    const existing = this.primaryAdminUsername();
    if (existing) {
      this.settings.delete(LEGACY_LOCAL_SEED_KEY);
      return null;
    }
    if (this.users.get(LOCAL_ADMIN)) {
      throw new AuthError(`local admin username '${LOCAL_ADMIN}' is already assigned to a non-admin account`, 403);
    }
    const password = randomBytes(32).toString('base64url');
    this.users.insert({
      username: LOCAL_ADMIN,
      email: `${LOCAL_ADMIN}@localhost`,
      passwordHash: hashPassword(password),
      role: 'admin',
    });
    this.settings.delete(LEGACY_LOCAL_SEED_KEY);
    return LOCAL_ADMIN;
  }

  /** Local mode still gets a normal, expiring, revocable full session. */
  localSession(): { token: string; user: AuthUser; expiresAt: number } {
    const username = this.primaryAdminUsername();
    if (!username) throw new AuthError('local admin is unavailable', 403);
    const account = this.users.get(username);
    if (!account || account.disabled) throw new AuthError('local admin is unavailable', 403);
    return this.startSession(account, SESSION_TTL_MS);
  }

  setup(
    username: string,
    email: string,
    password: string,
    bootstrapToken: string,
  ): { token: string; user: AuthUser; expiresAt: number } {
    if (!this.setupNeeded()) throw new AuthError('setup already completed', 403);
    const presented = digestBootstrap(bootstrapToken);
    if (!this.bootstrapDigest || !timingSafeEqual(presented, this.bootstrapDigest)) {
      throw new AuthError('invalid bootstrap token', 403);
    }
    this.users.insert({ username, email, passwordHash: hashPassword(password), role: 'admin' });
    this.bootstrapDigest = null;
    if (this.bootstrapFile) rmSync(this.bootstrapFile, { force: true });
    this.bootstrapFile = null;
    return this.startSession(this.users.get(username)!, SESSION_TTL_MS);
  }

  login(
    identifier: string,
    password: string,
    clientAddress = 'unknown',
  ): { token: string; user: AuthUser; expiresAt: number } | MfaChallenge {
    const throttleKey = `${clientAddress}\0${createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex')}`;
    this.loginThrottle.assertAllowed(throttleKey, clientAddress);
    const account = this.users.get(identifier) ?? this.users.getByEmail(identifier);
    // Do one real scrypt operation even for an unknown/disabled account. That
    // keeps the response from becoming a username enumeration oracle. The MFA
    // branch below runs only AFTER this refusal, so a wrong-password attempt is
    // byte-identical whether or not the account has a second factor.
    const valid = verifyPassword(password, account?.passwordHash ?? dummyPasswordHash());
    if (!account || account.disabled || !valid) {
      this.loginThrottle.failed(throttleKey, clientAddress);
      throw new AuthError('invalid username or password', 401);
    }
    this.loginThrottle.succeeded(throttleKey);
    if (passwordNeedsRehash(account.passwordHash)) {
      this.users.update(account.username, { passwordHash: hashPassword(password) });
    }
    if (account.mfaEnabled && this.mfa) return this.beginMfaChallenge(account.username);
    return this.startSession(account, SESSION_TTL_MS);
  }

  /**
   * Trade a pending login plus a TOTP/recovery code for the real session. The
   * pending token is single-use and expires in minutes; code guesses share the
   * login throttle so the second factor cannot be brute-forced faster than the
   * first.
   */
  completeMfaLogin(
    mfaToken: string,
    code: string,
    clientAddress = 'unknown',
  ): { token: string; user: AuthUser; expiresAt: number } {
    const pending = this.pendingMfa.get(hashToken(mfaToken));
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new AuthError('sign-in expired; enter your password again', 401);
    }
    const throttleKey = `${clientAddress}\0mfa\0${createHash('sha256').update(pending.username).digest('hex')}`;
    this.loginThrottle.assertAllowed(throttleKey, clientAddress);
    const account = this.users.get(pending.username);
    if (!account || account.disabled || !this.mfa?.verifyCode(pending.username, code)) {
      this.loginThrottle.failed(throttleKey, clientAddress);
      throw new AuthError('invalid verification code', 401);
    }
    this.loginThrottle.succeeded(throttleKey);
    this.pendingMfa.delete(hashToken(mfaToken));
    return this.startSession(account, SESSION_TTL_MS);
  }

  private beginMfaChallenge(username: string): MfaChallenge {
    const now = Date.now();
    for (const [key, pending] of this.pendingMfa) {
      if (pending.expiresAt <= now) this.pendingMfa.delete(key);
    }
    // Same overflow stance as the throttle: forgetting the oldest pending
    // logins under pressure fails toward re-entering a password.
    if (this.pendingMfa.size >= MAX_PENDING_MFA) {
      const oldest = [...this.pendingMfa.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [key] of oldest.slice(0, this.pendingMfa.size - MAX_PENDING_MFA + 1)) this.pendingMfa.delete(key);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + MFA_PENDING_TTL_MS;
    this.pendingMfa.set(hashToken(token), { username, expiresAt });
    return { mfaRequired: true, mfaToken: token, expiresAt };
  }

  logout(token: string): void {
    this.sessions.delete(hashToken(token));
  }

  // ---------- session inventory -----------------------------------------------

  /** A user's live sessions, flagging the one behind `currentToken`. Hashes stay inside. */
  listSessions(username: string, currentToken: string | null): SessionRecord[] {
    const currentHash = currentToken ? hashToken(currentToken) : null;
    return this.sessions.listForUser(username).map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      access: session.access,
      current: session.tokenHash === currentHash,
    }));
  }

  /** Revoke one of your own sessions. Revoking the current one logs you out; that is allowed. */
  revokeOwnSession(username: string, id: string): boolean {
    return this.sessions.deleteByIdForUser(username, id);
  }

  /** users:manage "sign out everywhere": the same internal revoke-all a password change runs. */
  revokeAllSessions(username: string): number {
    return this.sessions.deleteForUser(username);
  }

  /** Mint for a trusted internal consumer; access is explicit to avoid an accidental full delegate. */
  mintSession(username: string, ttlMs: number, access: SessionAccess): { token: string; expiresAt: number } {
    const account = this.users.get(username);
    if (!account || account.disabled) throw new AuthError('unknown or disabled account', 403);
    const { token, expiresAt } = this.startSession(account, ttlMs, access);
    return { token, expiresAt };
  }

  // ---------- managed API tokens ---------------------------------------------

  /** Capabilities this account can safely delegate right now. */
  apiTokenCapabilities(user: AuthUser): ApiTokenCapability[] {
    const held = new Set(this.rbac.permissionsFor(user.role));
    return this.rbac
      .catalog()
      .filter((capability) => held.has(capability.id) && !TOKEN_MANAGEMENT_PERMISSIONS.has(capability.id))
      .map(({ id, title, owner }) => ({ id, title, owner }))
      .sort((a, b) => a.owner.localeCompare(b.owner) || a.title.localeCompare(b.title));
  }

  listApiTokens(username: string): ApiTokenRecord[] {
    return this.apiTokens.listForUser(username);
  }

  listAllApiTokens(opts: { readonly limit: number; readonly offset: number }): {
    readonly tokens: ApiTokenRecord[];
    readonly total: number;
  } {
    return this.apiTokens.listAll(opts);
  }

  pruneExpiredApiTokens(): number {
    return this.apiTokens.pruneExpired();
  }

  createApiToken(
    user: AuthUser,
    input: { readonly name: string; readonly permissions: readonly Permission[]; readonly expiresInDays: number },
  ): CreateApiTokenResponse {
    this.apiTokens.pruneExpired();
    if (this.apiTokens.countForUser(user.username) >= MAX_API_TOKENS_PER_USER) {
      throw new StatusError(409, `at most ${MAX_API_TOKENS_PER_USER} active API tokens are allowed per user`);
    }
    const available = new Set(this.apiTokenCapabilities(user).map((capability) => capability.id));
    const permissions = [...new Set(input.permissions)];
    const unavailable = permissions.find((permission) => !available.has(permission));
    if (unavailable) throw new AuthError(`cannot delegate ${unavailable}`, 403);

    const now = Date.now();
    const secret = `cmp_${randomBytes(32).toString('base64url')}`;
    const record: ApiTokenRecord = {
      id: `tok-${randomUUID().slice(0, 12)}`,
      username: user.username,
      name: input.name.trim(),
      permissions,
      createdAt: now,
      expiresAt: now + input.expiresInDays * DAY_MS,
      lastUsedAt: null,
    };
    this.apiTokens.insert({ ...record, tokenHash: hashToken(secret) });
    return { token: secret, record };
  }

  revokeOwnApiToken(username: string, id: string): ApiTokenRecord | null {
    const record = this.apiTokens.get(id);
    if (!record || record.username !== username) return null;
    this.apiTokens.delete(id);
    return record;
  }

  revokeApiToken(id: string): ApiTokenRecord | null {
    const record = this.apiTokens.get(id);
    if (!record) return null;
    this.apiTokens.delete(id);
    return record;
  }

  private startSession(
    account: UserRecord,
    ttlMs: number,
    access: SessionAccess = 'full',
  ): { token: string; user: AuthUser; expiresAt: number } {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    this.sessions.insert({
      id: `ses-${randomUUID().slice(0, 12)}`,
      tokenHash: hashToken(token),
      username: account.username,
      role: account.role,
      access,
      createdAt: Date.now(),
      expiresAt,
    });
    return {
      token,
      user: {
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        ...(access === 'read-only' ? { sessionAccess: access } : {}),
      },
      expiresAt,
    };
  }

  /** Resolve a bearer token to its user, or null. Role reads live from the account. */
  verify(token: string | null): AuthUser | null {
    if (!token) return null;
    const now = Date.now();
    const tokenHash = hashToken(token);
    const session = this.sessions.get(tokenHash);
    if (session && session.expiresAt <= now) {
      this.sessions.delete(session.tokenHash);
      return null;
    }
    // Idle bound on top of the absolute lifetime: a session unused for longer
    // than the configured window is signed out. Creation counts as activity.
    const lastSeen = session ? (session.lastSeenAt ?? session.createdAt) : 0;
    if (session) {
      const idleMs = this.idleTimeoutMs();
      if (idleMs > 0 && lastSeen <= now - idleMs) {
        this.sessions.delete(session.tokenHash);
        return null;
      }
    }
    const apiToken = session ? null : this.apiTokens.getByHash(tokenHash);
    if (!session && !apiToken) return null;
    if (apiToken && apiToken.expiresAt <= now) {
      this.apiTokens.deleteByHash(tokenHash);
      return null;
    }
    const username = session?.username ?? apiToken!.username;
    const account = this.users.get(username);
    if (!account || account.disabled) {
      if (session) this.sessions.delete(session.tokenHash);
      else this.apiTokens.deleteByHash(tokenHash);
      return null;
    }
    // Activity stamps are throttled to one write per minute per credential:
    // cheap enough for the hot path, precise enough for idle timeout and UI.
    if (session && lastSeen <= now - SESSION_TOUCH_INTERVAL_MS) {
      this.sessions.touch(tokenHash, now);
    }
    if (apiToken && (apiToken.lastUsedAt === null || apiToken.lastUsedAt < now - API_TOKEN_TOUCH_INTERVAL_MS)) {
      this.apiTokens.touch(tokenHash, now);
    }
    return {
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      ...(session?.access === 'read-only' ? { sessionAccess: session.access } : {}),
      ...(apiToken ? { permissionScope: apiToken.permissions } : {}),
    };
  }

  /** Throw 401/403 unless the user holds the permission (against the live grid). */
  require(user: AuthUser | null, permission: Permission): AuthUser {
    if (!user) throw new AuthError('authentication required', 401);
    if (!this.rbac.allows(user, permission)) throw new AuthError(`requires ${permission}`, 403);
    return user;
  }

  /** The role of an account (for cross-module visibility scoping); undefined if unknown. */
  userRole(username: string): Role | undefined {
    return this.users.get(username)?.role;
  }

  /**
   * Role an unattended job may still act under. Disabled identities are not
   * automation service accounts: revoking sign-in must revoke their scheduled
   * and webhook authority at the same moment.
   */
  activeUserRole(username: string): Role | undefined {
    const user = this.users.get(username);
    return user && !user.disabled ? user.role : undefined;
  }

  sessionInfo(user: AuthUser): SessionInfo {
    const rolePermissions = this.rbac.permissionsFor(user.role);
    const permissionScope = user.permissionScope;
    return {
      user,
      permissions: permissionScope === undefined
        ? rolePermissions
        : rolePermissions.filter((permission) => permissionScope.includes(permission)),
      notificationScope: this.settings.resolveNotificationScope(user.username),
      navOverrides: this.settings.userNavOverrides(user.username),
      navPerspective: this.settings.userNavPerspective(user.username),
    };
  }

  // ---------- self-service account (any signed-in user) -----------------------

  ownAccount(username: string): AccountInfo {
    const account = this.users.get(username);
    if (!account) throw new AuthError(`user ${username} not found`, 403);
    return {
      username: account.username,
      displayName: account.displayName,
      email: account.email,
      role: account.role,
      mfaEnabled: account.mfaEnabled,
    };
  }

  updateOwnAccount(
    username: string,
    fields: { displayName?: string; email?: string; currentPassword?: string; newPassword?: string },
  ): AccountInfo {
    const account = this.users.get(username);
    if (!account) throw new AuthError(`user ${username} not found`, 403);
    if (fields.newPassword !== undefined) {
      if (!fields.currentPassword || !verifyPassword(fields.currentPassword, account.passwordHash)) {
        throw new AuthError('current password is incorrect', 403);
      }
    }
    this.requireEmailAvailable(fields.email, username);
    this.users.update(username, {
      displayName: fields.displayName?.trim(),
      email: fields.email,
      passwordHash: fields.newPassword ? hashPassword(fields.newPassword) : undefined,
    });
    if (fields.newPassword !== undefined) {
      this.sessions.deleteForUser(username);
      this.apiTokens.deleteForUser(username);
    }
    return this.ownAccount(username);
  }

  // ---------- user management (admin) -----------------------------------------

  searchUsers(opts: { q?: string; role?: string; limit?: number; offset?: number }): {
    users: UserRecord[];
    total: number;
  } {
    return this.users.search(opts);
  }

  createUser(input: { username: string; displayName?: string; email?: string; password: string; role: Role }): UserRecord {
    if (this.users.get(input.username)) throw new AuthError(`user ${input.username} already exists`, 403);
    this.requireEmailAvailable(input.email);
    this.users.insert({
      username: input.username,
      displayName: input.displayName?.trim() ?? '',
      email: input.email ?? '',
      passwordHash: hashPassword(input.password),
      role: input.role,
    });
    return sanitize(this.users.get(input.username)!);
  }

  updateUser(
    username: string,
    fields: { displayName?: string; email?: string; password?: string; role?: Role; disabled?: boolean },
    actor?: AuthUser,
  ): UserRecord {
    const existing = this.users.get(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    if (actor?.username === username && fields.role !== undefined && fields.role !== existing.role) {
      throw new AuthError('you cannot change your own role', 403);
    }
    this.requireEmailAvailable(fields.email, username);
    this.guardLastAdmin(existing, fields.role, fields.disabled);
    this.users.update(username, {
      displayName: fields.displayName?.trim(),
      email: fields.email,
      passwordHash: fields.password ? hashPassword(fields.password) : undefined,
      role: fields.role,
      disabled: fields.disabled,
    });
    if (fields.role !== undefined || fields.disabled === true || fields.password !== undefined) {
      this.sessions.deleteForUser(username);
      this.apiTokens.deleteForUser(username);
    }
    return sanitize(this.users.get(username)!);
  }

  /** Admin recovery for a lost authenticator; audited by the router like every user mutation. */
  resetUserMfa(username: string): UserRecord {
    const existing = this.users.get(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    this.mfa?.reset(username);
    return sanitize(this.users.get(username)!);
  }

  deleteUser(username: string, actor: AuthUser): void {
    const existing = this.users.get(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    if (actor.username === username) throw new AuthError('you cannot delete your own account', 403);
    this.guardLastAdmin(existing, undefined, true);
    this.users.delete(username);
    this.apiTokens.deleteForUser(username);
    this.mfa?.reset(username);
  }

  /** The unique index would refuse a duplicate as a raw constraint failure;
   *  answer with a 400 the caller can act on instead. '' is the no-email
   *  sentinel and stays shareable. */
  private requireEmailAvailable(email: string | undefined, exceptUsername?: string): void {
    if (!email) return;
    const holder = this.users.getByEmail(email);
    if (holder && holder.username !== exceptUsername) {
      throw new StatusError(400, `email ${email} is already in use by another account`);
    }
  }

  /**
   * The invariant that actually matters, now that roles are open: at least one
   * enabled account must be able to manage users. "Keep one admin" was a proxy
   * for it that stops being true once a custom role can hold `users:manage` and
   * a built-in one can have it revoked.
   */
  private guardLastAdmin(existing: UserRecord, nextRole?: Role, nextDisabled?: boolean): void {
    if (!this.rbac.has(existing.role, MANAGE_USERS) || existing.disabled) return;
    const stillManages =
      nextDisabled !== true && this.rbac.has(nextRole ?? existing.role, MANAGE_USERS);
    if (stillManages) return;
    if (this.roles.usersHolding(MANAGE_USERS) <= 1) {
      throw new AuthError('cannot remove the last account that can manage users', 403);
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function digestBootstrap(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

let dummyHash: string | null = null;
function dummyPasswordHash(): string {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

function readOrCreateBootstrapToken(file: string): string {
  try {
    const token = readRegularTextFile(file, { maxBytes: 4_096, mode: 0o600 }).trim();
    if (token.length < 32) throw new Error(`bootstrap token file is invalid: ${file}`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    // Another boot process may have won the create race before the instance
    // lock was acquired. Read the winner rather than replacing its capability.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readOrCreateBootstrapToken(file);
    throw error;
  }
}

interface LoginBucket {
  attempts: number[];
  touchedAt: number;
}

/** Process-local fixed-window limiter. Login remains correct behind one proxy:
 * the coarse address bucket becomes stricter, never weaker. */
class LoginThrottle {
  private readonly buckets = new Map<string, LoginBucket>();

  assertAllowed(principalKey: string, address: string): void {
    const now = Date.now();
    const principalWait = this.waitFor(principalKey, 5, now);
    const addressWait = this.waitFor(`address:${address}`, 30, now);
    const retryAfter = Math.max(principalWait, addressWait);
    if (retryAfter > 0) {
      throw new AuthError('too many sign-in attempts; try again later', 429, retryAfter);
    }
  }

  failed(principalKey: string, address: string): void {
    const now = Date.now();
    this.add(principalKey, now);
    this.add(`address:${address}`, now);
    this.prune(now);
  }

  succeeded(principalKey: string): void {
    this.buckets.delete(principalKey);
  }

  private waitFor(key: string, limit: number, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    bucket.attempts = bucket.attempts.filter((at) => at > now - LOGIN_WINDOW_MS);
    bucket.touchedAt = now;
    if (bucket.attempts.length < limit) return 0;
    return Math.max(1, Math.ceil((bucket.attempts[0]! + LOGIN_WINDOW_MS - now) / 1000));
  }

  private add(key: string, now: number): void {
    const bucket = this.buckets.get(key) ?? { attempts: [], touchedAt: now };
    bucket.attempts = bucket.attempts.filter((at) => at > now - LOGIN_WINDOW_MS);
    bucket.attempts.push(now);
    bucket.touchedAt = now;
    this.buckets.set(key, bucket);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt <= now - LOGIN_WINDOW_MS) this.buckets.delete(key);
    }
    if (this.buckets.size <= MAX_LOGIN_KEYS) return;
    const oldest = [...this.buckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key] of oldest.slice(0, this.buckets.size - MAX_LOGIN_KEYS)) this.buckets.delete(key);
  }
}

/** Hashes never leave the process — strip before returning API-bound records. */
function sanitize(user: UserRecord & { passwordHash: string }): UserRecord {
  const { passwordHash: _ph, ...record } = user;
  return record;
}

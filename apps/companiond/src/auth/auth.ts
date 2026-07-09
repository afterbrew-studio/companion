import { createHash, randomBytes } from 'node:crypto';
import {
  hasPermission,
  ROLE_PERMISSIONS,
  type AccountInfo,
  type AuthUser,
  type Permission,
  type Role,
  type SessionInfo,
  type UserRecord,
} from '@companion/contract';
import type { UserCredential } from '../config.js';
import type { Store } from '../store/db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { log } from '../log.js';

/** Sliding session lifetime. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

/**
 * Credential + session + account authority. Accounts live in the users table
 * (scrypt hashes); a clean install has none and runs first-boot onboarding
 * (`setupNeeded` → `setup`). Legacy .env credentials are imported once into
 * an empty users table, then the DB is authoritative. Sessions are DB rows
 * keyed by the SHA-256 of the bearer token.
 */
export class Auth {
  constructor(private readonly store: Store) {
    this.store.sessions.pruneExpired();
  }

  /** One-time import of .env accounts into an EMPTY users table. */
  seedFromEnv(users: readonly UserCredential[]): void {
    if (this.store.users.count() > 0 || users.length === 0) return;
    for (const u of users) {
      this.store.users.insert({
        username: u.username,
        email: '',
        passwordHash: hashPassword(u.password),
        role: u.role,
      });
    }
    log.info(`seeded ${users.length} account(s) from .env into the user store`);
  }

  /** Clean install (no accounts): the SPA must run onboarding first. */
  setupNeeded(): boolean {
    return this.store.users.count() === 0;
  }

  /** First-boot onboarding: create the admin account and sign it in. */
  setup(username: string, email: string, password: string): { token: string; user: AuthUser; expiresAt: number } {
    if (!this.setupNeeded()) throw new AuthError('setup already completed', 403);
    this.store.users.insert({ username, email, passwordHash: hashPassword(password), role: 'admin' });
    log.info('onboarding complete — admin account created', { username });
    return this.login(username, password);
  }

  /** Sign in with username OR email. */
  login(identifier: string, password: string): { token: string; user: AuthUser; expiresAt: number } {
    const account = this.store.users.get(identifier) ?? this.store.users.getByEmail(identifier);
    if (!account || account.disabled || !verifyPassword(password, account.passwordHash)) {
      log.warn('login rejected', { identifier });
      throw new AuthError('invalid username or password', 401);
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.store.sessions.insert({
      tokenHash: hashToken(token),
      username: account.username,
      role: account.role,
      createdAt: Date.now(),
      expiresAt,
    });
    log.info('login', { username: account.username, role: account.role });
    return {
      token,
      user: { username: account.username, displayName: account.displayName, role: account.role },
      expiresAt,
    };
  }

  logout(token: string): void {
    this.store.sessions.delete(hashToken(token));
  }

  /**
   * Mint a session token for a trusted internal consumer (the AI Help
   * assistant acting as the user). Same session store as logins — verify()
   * re-reads role and disabled state on every request, so the token can never
   * outlive or outrank the account.
   */
  mintSession(username: string, ttlMs: number): { token: string; expiresAt: number } {
    const account = this.store.users.get(username);
    if (!account || account.disabled) throw new AuthError('unknown or disabled account', 403);
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    this.store.sessions.insert({
      tokenHash: hashToken(token),
      username: account.username,
      role: account.role,
      createdAt: Date.now(),
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** Resolve a bearer token to its user, or null. Role reads live from the account. */
  verify(token: string | null): AuthUser | null {
    if (!token) return null;
    const session = this.store.sessions.get(hashToken(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.store.sessions.delete(session.tokenHash);
      return null;
    }
    const account = this.store.users.get(session.username);
    if (!account || account.disabled) {
      this.store.sessions.delete(session.tokenHash);
      return null;
    }
    return { username: account.username, displayName: account.displayName, role: account.role };
  }

  /** Throw 401/403 unless the user holds the permission. */
  require(user: AuthUser | null, permission: Permission): AuthUser {
    if (!user) throw new AuthError('authentication required', 401);
    if (!hasPermission(user.role, permission)) {
      throw new AuthError(`requires ${permission}`, 403);
    }
    return user;
  }

  sessionInfo(user: AuthUser): SessionInfo {
    return {
      user,
      permissions: ROLE_PERMISSIONS[user.role],
      notificationScope: this.store.settings.resolveNotificationScope(user.username),
    };
  }

  // ---------- self-service account (any signed-in user) -----------------------

  /** The caller's own account — never includes the password hash. */
  ownAccount(username: string): AccountInfo {
    const account = this.store.users.get(username);
    if (!account) throw new AuthError(`user ${username} not found`, 403);
    return { username: account.username, displayName: account.displayName, email: account.email, role: account.role };
  }

  /**
   * A user editing their own account: display name and email apply directly;
   * a new password requires the current one. Role/disabled are off-limits here
   * (that stays admin-only). The current session survives a password change.
   */
  updateOwnAccount(
    username: string,
    fields: { displayName?: string; email?: string; currentPassword?: string; newPassword?: string },
  ): AccountInfo {
    const account = this.store.users.get(username);
    if (!account) throw new AuthError(`user ${username} not found`, 403);
    if (fields.newPassword !== undefined) {
      if (!fields.currentPassword || !verifyPassword(fields.currentPassword, account.passwordHash)) {
        throw new AuthError('current password is incorrect', 403);
      }
    }
    this.store.users.update(username, {
      displayName: fields.displayName?.trim(),
      email: fields.email,
      passwordHash: fields.newPassword ? hashPassword(fields.newPassword) : undefined,
    });
    log.info('account updated', { username, password: fields.newPassword !== undefined });
    return this.ownAccount(username);
  }

  // ---------- user management (admin) -----------------------------------------

  listUsers(): UserRecord[] {
    return this.store.users.list();
  }

  createUser(input: {
    username: string;
    displayName?: string;
    email?: string;
    password: string;
    role: Role;
  }): UserRecord {
    if (this.store.users.get(input.username)) throw new AuthError(`user ${input.username} already exists`, 403);
    this.store.users.insert({
      username: input.username,
      displayName: input.displayName?.trim() ?? '',
      email: input.email ?? '',
      passwordHash: hashPassword(input.password),
      role: input.role,
    });
    log.info('user created', { username: input.username, role: input.role });
    return sanitize(this.store.users.get(input.username)!);
  }

  updateUser(
    username: string,
    fields: { displayName?: string; email?: string; password?: string; role?: Role; disabled?: boolean },
    actor?: AuthUser,
  ): UserRecord {
    const existing = this.store.users.get(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    // Nobody demotes (or otherwise reassigns) themselves — a second admin has
    // to do it, which also keeps the install from locking itself out.
    if (actor?.username === username && fields.role !== undefined && fields.role !== existing.role) {
      throw new AuthError('you cannot change your own role', 403);
    }
    this.guardLastAdmin(existing, fields.role, fields.disabled);
    this.store.users.update(username, {
      displayName: fields.displayName?.trim(),
      email: fields.email,
      passwordHash: fields.password ? hashPassword(fields.password) : undefined,
      role: fields.role,
      disabled: fields.disabled,
    });
    // Role change / disable must not ride old sessions.
    if (fields.role !== undefined || fields.disabled === true || fields.password !== undefined) {
      this.store.sessions.deleteForUser(username);
    }
    return sanitize(this.store.users.get(username)!);
  }

  deleteUser(username: string, actor: AuthUser): void {
    const existing = this.store.users.get(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    if (actor.username === username) throw new AuthError('you cannot delete your own account', 403);
    this.guardLastAdmin(existing, 'business', undefined);
    this.store.users.delete(username);
    log.info('user deleted', { username });
  }

  /** The install must always keep at least one enabled admin. */
  private guardLastAdmin(existing: UserRecord, nextRole?: Role, nextDisabled?: boolean): void {
    const losesAdmin =
      existing.role === 'admin' &&
      !existing.disabled &&
      ((nextRole !== undefined && nextRole !== 'admin') || nextDisabled === true);
    if (losesAdmin && this.store.users.countActiveAdmins() <= 1) {
      throw new AuthError('cannot remove the last enabled admin', 403);
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Hashes never leave the process — strip before returning API-bound records. */
function sanitize(user: UserRecord & { passwordHash: string }): UserRecord {
  const { passwordHash: _ph, ...record } = user;
  return record;
}

import { createHash, randomBytes } from 'node:crypto';
import type { Authenticator, AuthUser, Permission } from '@companion/contracts';
import type { Role } from '@companion/types';
import { StatusError, type RbacReader } from '@companion/core/server';
import type { AccountInfo, SessionInfo, UserRecord } from '../contract/index.js';
import type { UsersStore } from './users-store.js';
import type { SessionsStore } from './sessions-store.js';
import type { SettingsStore } from './settings-store.js';
import { hashPassword, verifyPassword } from './passwords.js';

/** Sliding session lifetime. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

/** A legacy `.env` account, seeded once into an empty user store. */
export interface SeedUser {
  readonly username: string;
  readonly password: string;
  readonly role: Role;
}

/** Extends the kernel's StatusError so the router forwards its 401/403 (only
 *  framework errors status-map; a GitHubError's upstream status becomes a 500). */
export class AuthError extends StatusError {
  constructor(message: string, status: 401 | 403) {
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
  constructor(
    private readonly users: UsersStore,
    private readonly sessions: SessionsStore,
    private readonly settings: SettingsStore,
    private readonly rbac: RbacReader,
  ) {
    this.sessions.pruneExpired();
  }

  /** One-time import of legacy accounts into an EMPTY users table. */
  seedFromEnv(users: readonly SeedUser[]): void {
    if (this.users.count() > 0 || users.length === 0) return;
    for (const u of users) {
      this.users.insert({ username: u.username, email: '', passwordHash: hashPassword(u.password), role: u.role });
    }
  }

  setupNeeded(): boolean {
    return this.users.count() === 0;
  }

  setup(username: string, email: string, password: string): { token: string; user: AuthUser; expiresAt: number } {
    if (!this.setupNeeded()) throw new AuthError('setup already completed', 403);
    this.users.insert({ username, email, passwordHash: hashPassword(password), role: 'admin' });
    return this.login(username, password);
  }

  login(identifier: string, password: string): { token: string; user: AuthUser; expiresAt: number } {
    const account = this.users.get(identifier) ?? this.users.getByEmail(identifier);
    if (!account || account.disabled || !verifyPassword(password, account.passwordHash)) {
      throw new AuthError('invalid username or password', 401);
    }
    return this.startSession(account, SESSION_TTL_MS);
  }

  logout(token: string): void {
    this.sessions.delete(hashToken(token));
  }

  /** Mint a session for a trusted internal consumer (AI Help acting as the user). */
  mintSession(username: string, ttlMs: number): { token: string; expiresAt: number } {
    const account = this.users.get(username);
    if (!account || account.disabled) throw new AuthError('unknown or disabled account', 403);
    const { token, expiresAt } = this.startSession(account, ttlMs);
    return { token, expiresAt };
  }

  private startSession(
    account: UserRecord,
    ttlMs: number,
  ): { token: string; user: AuthUser; expiresAt: number } {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    this.sessions.insert({
      tokenHash: hashToken(token),
      username: account.username,
      role: account.role,
      createdAt: Date.now(),
      expiresAt,
    });
    return { token, user: { username: account.username, displayName: account.displayName, role: account.role }, expiresAt };
  }

  /** Resolve a bearer token to its user, or null. Role reads live from the account. */
  verify(token: string | null): AuthUser | null {
    if (!token) return null;
    const session = this.sessions.get(hashToken(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(session.tokenHash);
      return null;
    }
    const account = this.users.get(session.username);
    if (!account || account.disabled) {
      this.sessions.delete(session.tokenHash);
      return null;
    }
    return { username: account.username, displayName: account.displayName, role: account.role };
  }

  /** Throw 401/403 unless the user holds the permission (against the live grid). */
  require(user: AuthUser | null, permission: Permission): AuthUser {
    if (!user) throw new AuthError('authentication required', 401);
    if (!this.rbac.has(user.role, permission)) throw new AuthError(`requires ${permission}`, 403);
    return user;
  }

  /** The role of an account (for cross-module visibility scoping); undefined if unknown. */
  userRole(username: string): Role | undefined {
    return this.users.get(username)?.role;
  }

  sessionInfo(user: AuthUser): SessionInfo {
    return {
      user,
      permissions: this.rbac.permissionsFor(user.role),
      notificationScope: this.settings.resolveNotificationScope(user.username),
    };
  }

  // ---------- self-service account (any signed-in user) -----------------------

  ownAccount(username: string): AccountInfo {
    const account = this.users.get(username);
    if (!account) throw new AuthError(`user ${username} not found`, 403);
    return { username: account.username, displayName: account.displayName, email: account.email, role: account.role };
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
    this.users.update(username, {
      displayName: fields.displayName?.trim(),
      email: fields.email,
      passwordHash: fields.newPassword ? hashPassword(fields.newPassword) : undefined,
    });
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
    }
    return sanitize(this.users.get(username)!);
  }

  deleteUser(username: string, actor: AuthUser): void {
    const existing = this.users.get(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    if (actor.username === username) throw new AuthError('you cannot delete your own account', 403);
    this.guardLastAdmin(existing, 'business', undefined);
    this.users.delete(username);
  }

  /** The install must always keep at least one enabled admin. */
  private guardLastAdmin(existing: UserRecord, nextRole?: Role, nextDisabled?: boolean): void {
    const losesAdmin =
      existing.role === 'admin' &&
      !existing.disabled &&
      ((nextRole !== undefined && nextRole !== 'admin') || nextDisabled === true);
    if (losesAdmin && this.users.countActiveAdmins() <= 1) {
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

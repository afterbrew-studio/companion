import { createHash, randomBytes } from 'node:crypto';
import {
  hasPermission,
  ROLE_PERMISSIONS,
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
    this.store.pruneExpiredSessions();
  }

  /** One-time import of .env accounts into an EMPTY users table. */
  seedFromEnv(users: readonly UserCredential[]): void {
    if (this.store.countUsers() > 0 || users.length === 0) return;
    for (const u of users) {
      this.store.insertUser({
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
    return this.store.countUsers() === 0;
  }

  /** First-boot onboarding: create the admin account and sign it in. */
  setup(username: string, email: string, password: string): { token: string; user: AuthUser; expiresAt: number } {
    if (!this.setupNeeded()) throw new AuthError('setup already completed', 403);
    this.store.insertUser({ username, email, passwordHash: hashPassword(password), role: 'admin' });
    log.info('onboarding complete — admin account created', { username });
    return this.login(username, password);
  }

  /** Sign in with username OR email. */
  login(identifier: string, password: string): { token: string; user: AuthUser; expiresAt: number } {
    const account = this.store.getUser(identifier) ?? this.store.getUserByEmail(identifier);
    if (!account || account.disabled || !verifyPassword(password, account.passwordHash)) {
      log.warn('login rejected', { identifier });
      throw new AuthError('invalid username or password', 401);
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.store.insertSession({
      tokenHash: hashToken(token),
      username: account.username,
      role: account.role,
      createdAt: Date.now(),
      expiresAt,
    });
    log.info('login', { username: account.username, role: account.role });
    return { token, user: { username: account.username, role: account.role }, expiresAt };
  }

  logout(token: string): void {
    this.store.deleteSession(hashToken(token));
  }

  /** Resolve a bearer token to its user, or null. Role reads live from the account. */
  verify(token: string | null): AuthUser | null {
    if (!token) return null;
    const session = this.store.getSession(hashToken(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.store.deleteSession(session.tokenHash);
      return null;
    }
    const account = this.store.getUser(session.username);
    if (!account || account.disabled) {
      this.store.deleteSession(session.tokenHash);
      return null;
    }
    return { username: account.username, role: account.role };
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
    return { user, permissions: ROLE_PERMISSIONS[user.role] };
  }

  // ---------- user management (admin) -----------------------------------------

  listUsers(): UserRecord[] {
    return this.store.listUsers();
  }

  createUser(input: { username: string; email?: string; password: string; role: Role }): UserRecord {
    if (this.store.getUser(input.username)) throw new AuthError(`user ${input.username} already exists`, 403);
    this.store.insertUser({
      username: input.username,
      email: input.email ?? '',
      passwordHash: hashPassword(input.password),
      role: input.role,
    });
    log.info('user created', { username: input.username, role: input.role });
    return sanitize(this.store.getUser(input.username)!);
  }

  updateUser(
    username: string,
    fields: { email?: string; password?: string; role?: Role; disabled?: boolean },
    actor?: AuthUser,
  ): UserRecord {
    const existing = this.store.getUser(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    // Nobody demotes (or otherwise reassigns) themselves — a second admin has
    // to do it, which also keeps the install from locking itself out.
    if (actor?.username === username && fields.role !== undefined && fields.role !== existing.role) {
      throw new AuthError('you cannot change your own role', 403);
    }
    this.guardLastAdmin(existing, fields.role, fields.disabled);
    this.store.updateUser(username, {
      email: fields.email,
      passwordHash: fields.password ? hashPassword(fields.password) : undefined,
      role: fields.role,
      disabled: fields.disabled,
    });
    // Role change / disable must not ride old sessions.
    if (fields.role !== undefined || fields.disabled === true || fields.password !== undefined) {
      this.store.deleteSessionsForUser(username);
    }
    return sanitize(this.store.getUser(username)!);
  }

  deleteUser(username: string, actor: AuthUser): void {
    const existing = this.store.getUser(username);
    if (!existing) throw new AuthError(`user ${username} not found`, 403);
    if (actor.username === username) throw new AuthError('you cannot delete your own account', 403);
    this.guardLastAdmin(existing, 'business', undefined);
    this.store.deleteUser(username);
    log.info('user deleted', { username });
  }

  /** The install must always keep at least one enabled admin. */
  private guardLastAdmin(existing: UserRecord, nextRole?: Role, nextDisabled?: boolean): void {
    const losesAdmin =
      existing.role === 'admin' &&
      !existing.disabled &&
      ((nextRole !== undefined && nextRole !== 'admin') || nextDisabled === true);
    if (losesAdmin && this.store.countActiveAdmins() <= 1) {
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

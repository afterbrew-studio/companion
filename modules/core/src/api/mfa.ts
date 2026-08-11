import { createHash, randomBytes } from 'node:crypto';
import { StatusError, type ModuleSecrets } from '@moxxy/companion-core/server';
import type { MfaEnrollment } from '../contract/index.js';
import type { MfaStore } from './mfa-store.js';
import type { UsersStore } from './users-store.js';
import { base32Decode, base32Encode, verifyTotp } from './totp.js';

/** 160-bit secret, RFC 4226's recommended size. */
const SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 10;

/**
 * TOTP second factor for local accounts. Secrets live in the module secret
 * store (AES-256-GCM at rest via the SecretStore seam), keyed per user; the
 * users table only carries the enabled flag. Auth owns the login flow and asks
 * this service whether a presented code is good.
 */
export class Mfa {
  /**
   * Last accepted TOTP step per user (RFC 6238 §5.2: a validated code must not
   * be accepted twice). Process-local on purpose: a restart forgets at most one
   * 30-second window, and a replay there still needs the password.
   */
  private readonly acceptedSteps = new Map<string, number>();

  constructor(
    private readonly secrets: ModuleSecrets,
    private readonly codes: MfaStore,
    private readonly users: UsersStore,
  ) {}

  enabled(username: string): boolean {
    return this.users.get(username)?.mfaEnabled === true;
  }

  /**
   * Self-service enrollment, step 1: provision a secret. Nothing is enforced
   * until the user proves possession by confirming a code, so re-provisioning
   * before that simply replaces the pending secret.
   */
  beginEnrollment(username: string, issuer: string): MfaEnrollment {
    if (this.enabled(username)) {
      throw new StatusError(409, 'MFA is already enabled; turn it off first or ask an admin to reset it');
    }
    const secret = base32Encode(randomBytes(SECRET_BYTES));
    this.secrets.set(pendingKey(username), secret);
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
    return {
      secret,
      otpauthUri:
        `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
        `&algorithm=SHA1&digits=6&period=30`,
    };
  }

  /** Step 2: a valid code against the pending secret turns MFA on. */
  confirmEnrollment(username: string, code: string): readonly string[] {
    const secret = this.secrets.get(pendingKey(username));
    if (!secret) throw new StatusError(409, 'no enrollment in progress');
    const step = this.acceptTotp(username, secret, code.replace(/[\s-]/g, ''));
    if (step === null) throw new StatusError(403, 'invalid verification code');
    this.secrets.set(secretKey(username), secret);
    this.secrets.delete(pendingKey(username));
    this.users.setMfaEnabled(username, true);
    return this.issueRecoveryCodes(username);
  }

  /**
   * True when `code` (a TOTP or a recovery code) proves the second factor.
   * Recovery codes are consumed atomically, so each one signs in exactly once.
   */
  verifyCode(username: string, code: string): boolean {
    const secret = this.secrets.get(secretKey(username));
    if (!secret || !this.enabled(username)) return false;
    const normalized = code.replace(/[\s-]/g, '');
    if (/^\d{6}$/.test(normalized)) return this.acceptTotp(username, secret, normalized) !== null;
    return this.codes.consume(username, hashRecoveryCode(normalized));
  }

  /** Regenerate, invalidating the whole previous set. */
  regenerateRecoveryCodes(username: string, code: string): readonly string[] {
    if (!this.verifyCode(username, code)) throw new StatusError(403, 'invalid verification code');
    return this.issueRecoveryCodes(username);
  }

  /** Self-service off switch; proving a current code keeps a stolen session from doing it. */
  disable(username: string, code: string): void {
    if (!this.verifyCode(username, code)) throw new StatusError(403, 'invalid verification code');
    this.reset(username);
  }

  /** Admin recovery (users:manage): no code, the operator is the proof. */
  reset(username: string): void {
    this.secrets.delete(secretKey(username));
    this.secrets.delete(pendingKey(username));
    this.codes.deleteForUser(username);
    this.users.setMfaEnabled(username, false);
    this.acceptedSteps.delete(username);
  }

  private acceptTotp(username: string, secret: string, code: string): number | null {
    const step = verifyTotp(base32Decode(secret), code);
    if (step === null) return null;
    const last = this.acceptedSteps.get(username);
    if (last !== undefined && step <= last) return null;
    this.acceptedSteps.set(username, step);
    return step;
  }

  private issueRecoveryCodes(username: string): readonly string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = randomBytes(16).toString('hex');
      return `${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16, 24)}-${raw.slice(24)}`;
    });
    this.codes.replaceAll(
      username,
      codes.map((code) => hashRecoveryCode(code.replaceAll('-', ''))),
    );
    return codes;
  }
}

const secretKey = (username: string): string => `mfa.totp:${username}`;
const pendingKey = (username: string): string => `mfa.totp.pending:${username}`;

// A single unsalted SHA-256 is deliberate: recovery codes are 128-bit random
// values, so brute-forcing the digest is a 2^128 search and rainbow tables do
// not apply. scrypt's cost exists for low-entropy human passwords.
function hashRecoveryCode(normalized: string): string {
  return createHash('sha256').update(normalized.toLowerCase()).digest('hex');
}

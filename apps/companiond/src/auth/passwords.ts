import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing: scrypt (N=16384, r=8, p=1) with a per-password random
 * salt, serialized as `s2$<salt b64url>$<hash b64url>`. Node-native — no
 * dependency, safe defaults, constant-time verify.
 */

const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `s2$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 's2') return false;
  try {
    const salt = Buffer.from(parts[1]!, 'base64url');
    const expected = Buffer.from(parts[2]!, 'base64url');
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

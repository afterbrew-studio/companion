import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing: the OWASP scrypt profile N=2^15, r=8, p=3 with a random
 * salt. Parameters are serialized so a future profile can rehash on login.
 * Legacy `s2` hashes (Node's old N=2^14, r=8, p=1 defaults) remain verifiable
 * only long enough to migrate after a successful sign-in.
 */

const KEYLEN = 32;
const N = 1 << 15;
const R = 8;
const P = 3;
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `s3$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  try {
    const profile = passwordProfile(parts);
    if (!profile) return false;
    const expected = Buffer.from(profile.hash, 'base64url');
    if (expected.length !== KEYLEN) return false;
    const actual = scryptSync(password, Buffer.from(profile.salt, 'base64url'), expected.length, {
      N: profile.N,
      r: profile.r,
      p: profile.p,
      maxmem: Math.max(MAXMEM, 128 * profile.N * profile.r + 1024 * 1024),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function passwordNeedsRehash(stored: string): boolean {
  const profile = passwordProfile(stored.split('$'));
  return !profile || profile.version !== 's3' || profile.N !== N || profile.r !== R || profile.p !== P;
}

function passwordProfile(parts: readonly string[]): {
  version: 's2' | 's3';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
} | null {
  if (parts.length === 3 && parts[0] === 's2') {
    return { version: 's2', N: 1 << 14, r: 8, p: 1, salt: parts[1]!, hash: parts[2]! };
  }
  if (parts.length !== 6 || parts[0] !== 's3') return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) return null;
  // Refuse attacker-controlled hash parameters that could turn verification
  // into a memory/CPU denial of service after database corruption.
  if (n! > (1 << 18) || r! > 16 || p! > 8) return null;
  return { version: 's3', N: n!, r: r!, p: p!, salt: parts[4]!, hash: parts[5]! };
}

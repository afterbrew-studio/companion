import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP over node:crypto: SHA-1, 30-second step, 6 digits, the profile
 * every authenticator app defaults to. Hand-rolled because the whole algorithm
 * is one HMAC plus dynamic truncation; a dependency would be larger than it.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** ±1 step of clock skew, the RFC's recommended transmission-delay window. */
const SKEW_STEPS = 1;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Unpadded RFC 4648 base32, the alphabet otpauth secrets use. */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = B32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpStep(at: number): number {
  return Math.floor(at / 1000 / STEP_SECONDS);
}

/** RFC 4226 HOTP with RFC 6238's time step as the counter. */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Verify a code within ±1 step and return the step it matched, or null. The
 * caller records the accepted step so the same code cannot be replayed (RFC
 * 6238 §5.2). Comparison is constant-time per candidate; the candidate count
 * is fixed, so timing reveals nothing about which step matched.
 */
export function verifyTotp(secret: Buffer, code: string, at = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const presented = Buffer.from(code, 'utf8');
  const current = totpStep(at);
  let matched: number | null = null;
  for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step), 'utf8'), presented) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

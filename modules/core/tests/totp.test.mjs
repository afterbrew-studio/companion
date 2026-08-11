import assert from 'node:assert/strict';
import test from 'node:test';
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../dist/api/totp.js';

/**
 * RFC 6238 Appendix B test vectors for SHA-1, adjusted from the appendix's
 * 8 digits to the 6 digits Companion issues: a 6-digit HOTP value is the
 * 8-digit value mod 10^6, i.e. its last six digits.
 */
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const STEP_SECONDS = 30;
const VECTORS = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

test('RFC 6238 appendix B vectors (SHA-1, 6 digits)', () => {
  for (const [t, code] of VECTORS) {
    const step = Math.floor(t / STEP_SECONDS);
    assert.equal(totpCode(SECRET, step), code, `T=${t}`);
    assert.equal(verifyTotp(SECRET, code, t * 1000), step, `verify T=${t}`);
  }
});

test('verification accepts one step of clock skew each way, no more', () => {
  const at = 1111111111 * 1000;
  const step = Math.floor(1111111111 / STEP_SECONDS);
  assert.equal(verifyTotp(SECRET, totpCode(SECRET, step - 1), at), step - 1);
  assert.equal(verifyTotp(SECRET, totpCode(SECRET, step + 1), at), step + 1);
  assert.equal(verifyTotp(SECRET, totpCode(SECRET, step - 2), at), null);
  assert.equal(verifyTotp(SECRET, totpCode(SECRET, step + 2), at), null);
});

test('malformed codes are refused without throwing', () => {
  const at = 1111111111 * 1000;
  for (const code of ['', '12345', '1234567', 'abcdef', '00000o']) {
    assert.equal(verifyTotp(SECRET, code, at), null, JSON.stringify(code));
  }
});

test('base32 round-trips every length and tolerates lowercase and spacing', () => {
  for (let n = 1; n <= 20; n++) {
    const data = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) % 256));
    const encoded = base32Encode(data);
    assert.match(encoded, /^[A-Z2-7]+$/, 'unpadded RFC 4648 alphabet');
    assert.deepEqual(base32Decode(encoded), data);
    assert.deepEqual(base32Decode(encoded.toLowerCase()), data);
    assert.deepEqual(base32Decode(`${encoded.slice(0, 3)} ${encoded.slice(3)}`), data);
  }
  assert.throws(() => base32Decode('01'), /base32/);
});

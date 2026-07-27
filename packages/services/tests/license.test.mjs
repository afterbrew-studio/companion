import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entitlements, readLicense } from '../dist/license.js';

/**
 * The gate must FAIL CLOSED in every direction that is not "a valid signature
 * from this build's issuer, granting this feature, not yet expired". Each case
 * below is one way an install could otherwise be handed an entitlement it did
 * not buy, or be denied one it did.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519').privateKey;

const issue = (payload, key = privateKey) => {
  const body = Buffer.from(JSON.stringify(payload));
  return `${body.toString('base64url')}.${sign(null, body, key).toString('base64url')}`;
};

const valid = { customer: 'ACME', features: ['pro'], expiresAt: Date.now() + 86_400_000 };

/** Each case runs against its own COMPANION_HOME so nothing leaks between them. */
function withHome(license, key, fn) {
  const home = mkdtempSync(join(tmpdir(), 'companion-license-'));
  const prevHome = process.env.COMPANION_HOME;
  const prevKey = process.env.COMPANION_LICENSE_KEY;
  process.env.COMPANION_HOME = home;
  if (key === null) delete process.env.COMPANION_LICENSE_KEY;
  else process.env.COMPANION_LICENSE_KEY = key;
  if (license !== null) writeFileSync(join(home, 'license.jwt'), license);
  try {
    return fn();
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = prevHome;
    if (prevKey === undefined) delete process.env.COMPANION_LICENSE_KEY;
    else process.env.COMPANION_LICENSE_KEY = prevKey;
  }
}

test('a valid licence from this build\'s issuer grants its features', () => {
  withHome(issue(valid), pem, () => {
    const state = readLicense();
    assert.equal(state.status, 'valid');
    assert.equal(state.license.customer, 'ACME');
    assert.equal(new Entitlements().has('pro'), true);
  });
});

test('a licence granting another feature does not grant this one', () => {
  withHome(issue({ ...valid, features: ['something-else'] }), pem, () => {
    assert.equal(readLicense().status, 'valid');
    assert.equal(new Entitlements().has('pro'), false);
  });
});

test('an expired licence satisfies nothing', () => {
  withHome(issue({ ...valid, expiresAt: Date.now() - 1000 }), pem, () => {
    assert.equal(readLicense().status, 'expired');
    assert.equal(new Entitlements().has('pro'), false);
  });
});

test('a licence signed by anyone else is unverifiable', () => {
  withHome(issue(valid, other), pem, () => {
    const state = readLicense();
    assert.equal(state.status, 'unverifiable');
    assert.match(state.reason, /signature/);
    assert.equal(new Entitlements().has('pro'), false);
  });
});

test('a tampered payload is unverifiable even with a real signature attached', () => {
  const [, signature] = issue(valid).split('.');
  const forged = Buffer.from(JSON.stringify({ ...valid, features: ['pro', 'stolen'] })).toString('base64url');
  withHome(`${forged}.${signature}`, pem, () => {
    assert.equal(readLicense().status, 'unverifiable');
    assert.equal(new Entitlements().has('stolen'), false);
  });
});

test('a build with no issuer key satisfies nothing, even holding a valid licence', () => {
  // The OSS build. It must not pretend it verified something it cannot verify.
  withHome(issue(valid), null, () => {
    const state = readLicense();
    assert.equal(state.status, 'unverifiable');
    assert.match(state.reason, /public key/);
    assert.equal(new Entitlements().has('pro'), false);
  });
});

test('no licence file is "none", not an error', () => {
  withHome(null, pem, () => {
    assert.equal(readLicense().status, 'none');
    assert.equal(new Entitlements().has('pro'), false);
  });
});

test('a malformed file is unverifiable rather than throwing', () => {
  for (const junk of ['', 'not-a-licence', 'a.b.c', `${Buffer.from('{').toString('base64url')}.zz`]) {
    withHome(junk, pem, () => {
      assert.equal(readLicense().status, 'unverifiable', `for ${JSON.stringify(junk)}`);
    });
  }
});

test('a payload missing required fields is unverifiable', () => {
  withHome(issue({ customer: 'ACME' }), pem, () => {
    const state = readLicense();
    assert.equal(state.status, 'unverifiable');
    assert.match(state.reason, /features or expiresAt/);
  });
});

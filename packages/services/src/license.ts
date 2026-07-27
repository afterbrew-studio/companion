import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { paths } from './config.js';
import { log } from './lib/log.js';

/**
 * What a licence grants. Deliberately small: everything here is checked at
 * enable time and once a day, never on a request path.
 */
export interface License {
  /** Who it was issued to, for support and the admin surface. */
  readonly customer: string;
  /** Entitlement ids this licence unlocks; a module declares one to be gated. */
  readonly features: readonly string[];
  /** Epoch ms. Past this the licence stops satisfying entitlements. */
  readonly expiresAt: number;
  /** Informational: seat count the contract covers. Never enforced in software. */
  readonly seats?: number;
}

export type LicenseState =
  | { readonly status: 'none' }
  | { readonly status: 'unverifiable'; readonly reason: string }
  | { readonly status: 'expired'; readonly license: License }
  | { readonly status: 'valid'; readonly license: License };

/**
 * The issuer's Ed25519 public key, SPKI PEM. An OSS build has none, which is
 * correct: it contains no entitled module, and a build that cannot verify a
 * licence must not pretend it can. The enterprise build supplies it.
 */
const publicKey = (): string | null => process.env.COMPANION_LICENSE_KEY?.trim() || null;

/**
 * Read and verify `$COMPANION_HOME/license.jwt`.
 *
 * **Offline by construction.** Air-gapped installs are a hard requirement in the
 * segments that buy this, so there is no licence server, no activation call and
 * no phone-home: a detached Ed25519 signature over the payload is the whole
 * mechanism.
 *
 * Format: `base64url(payloadJson).base64url(signature)`.
 *
 * This is a contractual control with a technical speed bump, not a security
 * boundary. Anyone holding the source can remove it. It exists so an honest
 * customer stays compliant and an auditor can see what was licensed.
 */
export function readLicense(): LicenseState {
  const file = paths.license();
  if (!existsSync(file)) return { status: 'none' };
  const key = publicKey();
  if (!key) return { status: 'unverifiable', reason: 'this build carries no licence public key' };

  let license: License;
  try {
    const [payload, signature] = readFileSync(file, 'utf8').trim().split('.');
    if (!payload || !signature) throw new Error('expected payload.signature');
    const bytes = Buffer.from(payload, 'base64url');
    if (!verify(null, bytes, key, Buffer.from(signature, 'base64url'))) {
      return { status: 'unverifiable', reason: 'signature does not match this build\'s issuer key' };
    }
    license = JSON.parse(bytes.toString('utf8')) as License;
  } catch (err) {
    return { status: 'unverifiable', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!Array.isArray(license.features) || typeof license.expiresAt !== 'number') {
    return { status: 'unverifiable', reason: 'payload is missing features or expiresAt' };
  }
  return license.expiresAt <= Date.now() ? { status: 'expired', license } : { status: 'valid', license };
}

/** Human-readable one-liner for logs and the admin surface. */
export function describeLicense(state: LicenseState): string {
  switch (state.status) {
    case 'none':
      return 'no licence installed';
    case 'unverifiable':
      return `licence could not be verified: ${state.reason}`;
    case 'expired':
      return `licence for ${state.license.customer} expired ${new Date(state.license.expiresAt).toISOString().slice(0, 10)}`;
    case 'valid':
      return `licensed to ${state.license.customer} until ${new Date(state.license.expiresAt).toISOString().slice(0, 10)}`;
  }
}

/**
 * The live entitlement check. Cached for a day because a licence cannot change
 * without someone touching the filesystem, and because this must never become a
 * per-request cost.
 */
export class Entitlements {
  private state: LicenseState = { status: 'none' };
  private checkedAt = 0;

  constructor(private readonly ttlMs = 24 * 60 * 60_000) {
    this.refresh();
  }

  refresh(): LicenseState {
    this.state = readLicense();
    this.checkedAt = Date.now();
    log.info(describeLicense(this.state));
    return this.state;
  }

  current(): LicenseState {
    if (Date.now() - this.checkedAt >= this.ttlMs) this.refresh();
    return this.state;
  }

  /** True when `feature` is unlocked. An unlicensed build fails closed. */
  has(feature: string): boolean {
    const state = this.current();
    return state.status === 'valid' && state.license.features.includes(feature);
  }
}

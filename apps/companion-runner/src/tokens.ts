import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';

/**
 * The bearer tokens a controlling Companion may present.
 *
 * Several at once, and only their hashes on disk. Both parts exist for the same
 * reason: a machine wired into somebody's Companion cannot afford a credential
 * change that means downtime, so rotating is "issue a second one, move the
 * instance over, revoke the first", which needs more than one to be valid at a
 * time. Storing hashes means the file that survives on the laptop is not itself
 * a credential; the secret is shown once, when it is minted.
 *
 * The file is re-read whenever it changes, so `companion-runner token new` in
 * another terminal takes effect on the very next request rather than on the
 * next restart of a machine that is currently running work.
 */
export interface RunnerToken {
  readonly id: string;
  readonly label: string;
  /** sha256 of the secret, hex. The secret itself is never written down here. */
  readonly hash: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

interface TokenFile {
  readonly version: 1;
  readonly tokens: readonly RunnerToken[];
}

/** How often a token's "last used" is allowed to hit the disk. */
const USE_FLUSH_MS = 60_000;

export class RunnerTokens {
  private tokens: RunnerToken[] = [];
  private loadedMtimeMs = -1;
  private lastFlush = 0;
  private dirty = false;

  constructor(
    private readonly home: string,
    /**
     * `COMPANION_RUNNER_TOKEN`. Always valid and never stored: a container
     * configured by environment must not depend on a writable data root, and a
     * value the operator supplies is theirs to rotate wherever they set it.
     */
    private readonly envToken: string | null,
  ) {
    this.load();
    this.adoptLegacyFile();
  }

  private get file(): string {
    return join(this.home, 'tokens.json');
  }

  /**
   * Which token this request presented, or null.
   *
   * Every candidate is compared, in constant time, even after a match: bailing
   * out early would make the wall clock depend on how many tokens are
   * configured and on where in the list the right one sits.
   */
  verify(presented: string | null): RunnerToken | 'env' | null {
    if (!presented) return null;
    if (this.envToken && constantTimeEquals(this.envToken, presented)) return 'env';
    this.reloadIfChanged();
    const digest = sha256(presented);
    let matched: RunnerToken | null = null;
    for (const token of this.tokens) {
      const hit = token.revokedAt === null && constantTimeEquals(token.hash, digest);
      if (hit && !matched) matched = token;
    }
    if (matched) this.noteUse(matched.id);
    return matched;
  }

  list(): readonly RunnerToken[] {
    this.reloadIfChanged();
    return this.tokens;
  }

  /** Whether anything at all could authenticate right now. */
  get usable(): boolean {
    return this.envToken !== null || this.list().some((token) => token.revokedAt === null);
  }

  /** Mint one, returning the secret: the only time it exists in the clear. */
  issue(label: string): { token: RunnerToken; secret: string } {
    this.reloadIfChanged();
    const secret = randomBytes(32).toString('hex');
    const token: RunnerToken = {
      id: `rt-${randomBytes(4).toString('hex')}`,
      label: label.trim().slice(0, 60) || 'runner token',
      hash: sha256(secret),
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.tokens = [...this.tokens, token];
    this.save();
    return { token, secret };
  }

  /** Revoke by id or by exact label. Returns what was actually revoked. */
  revoke(idOrLabel: string): RunnerToken | null {
    this.reloadIfChanged();
    const target = this.tokens.find(
      (token) => token.revokedAt === null && (token.id === idOrLabel || token.label === idOrLabel),
    );
    if (!target) return null;
    const revoked = { ...target, revokedAt: Date.now() };
    this.tokens = this.tokens.map((token) => (token.id === target.id ? revoked : token));
    this.save();
    return revoked;
  }

  /** Revoke everything except `keepId`; the destructive half of a rotation. */
  revokeOthers(keepId: string): number {
    this.reloadIfChanged();
    const now = Date.now();
    let count = 0;
    this.tokens = this.tokens.map((token) => {
      if (token.id === keepId || token.revokedAt !== null) return token;
      count += 1;
      return { ...token, revokedAt: now };
    });
    if (count > 0) this.save();
    return count;
  }

  /** Drop revoked entries so the file does not grow forever. */
  prune(): number {
    this.reloadIfChanged();
    const kept = this.tokens.filter((token) => token.revokedAt === null);
    const removed = this.tokens.length - kept.length;
    if (removed > 0) {
      // Written directly rather than through the merge: forgetting an entry is
      // the one operation whose whole point is that the file's copy loses.
      this.tokens = kept;
      this.writeFile(kept);
    }
    return removed;
  }

  private noteUse(id: string): void {
    const now = Date.now();
    this.tokens = this.tokens.map((token) => (token.id === id ? { ...token, lastUsedAt: now } : token));
    this.dirty = true;
    // Bounded write amplification: a busy runner would otherwise rewrite this
    // file on every single request to record a field nobody reads that often.
    if (now - this.lastFlush >= USE_FLUSH_MS) this.save();
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.tokens = [];
      this.loadedMtimeMs = -1;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as TokenFile;
      this.tokens = Array.isArray(parsed.tokens) ? parsed.tokens.filter(isToken) : [];
      this.loadedMtimeMs = statSync(this.file).mtimeMs;
    } catch (err) {
      // A corrupt store must not silently authenticate nobody OR everybody: it
      // reads as empty, which refuses every request and says why in the log.
      // The mtime is recorded anyway, so a machine under load complains once
      // rather than re-parsing and re-logging the same broken file per request.
      this.tokens = [];
      try {
        this.loadedMtimeMs = statSync(this.file).mtimeMs;
      } catch {
        this.loadedMtimeMs = -1;
      }
      log.error(`could not read ${this.file}; no stored token will authenticate until it is fixed`, err);
    }
  }

  private reloadIfChanged(): void {
    try {
      if (!existsSync(this.file)) {
        if (this.loadedMtimeMs !== -1) this.load();
        return;
      }
      if (statSync(this.file).mtimeMs !== this.loadedMtimeMs) this.load();
    } catch {
      // A stat that fails is not a reason to drop the tokens already loaded.
    }
  }

  /**
   * Write the store, merged with whatever is on disk.
   *
   * Two processes legitimately write this file: the agent recording that a
   * token was used, and a CLI issuing or revoking one while the agent runs.
   * A plain overwrite would let the agent's lazy timestamp flush drop a token
   * minted a second earlier, which is a credential silently disappearing.
   */
  private save(): void {
    const merged = this.merged();
    this.tokens = merged;
    this.writeFile(merged);
  }

  private writeFile(tokens: readonly RunnerToken[]): void {
    const body: TokenFile = { version: 1, tokens };
    const tmp = `${this.file}.tmp`;
    // Written whole and renamed: a half-written token file is a machine nobody
    // can reach, and the process doing the writing may be a CLI that is about
    // to exit.
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.loadedMtimeMs = statSync(this.file).mtimeMs;
    this.lastFlush = Date.now();
    this.dirty = false;
  }

  /**
   * This process's view unioned with the file's, entry by entry. Revocation
   * wins over its absence, and the later `lastUsedAt` wins, so the merge is
   * order-independent and neither writer can undo the other.
   */
  private merged(): RunnerToken[] {
    let onDisk: RunnerToken[] = [];
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as TokenFile;
        onDisk = Array.isArray(parsed.tokens) ? parsed.tokens.filter(isToken) : [];
      }
    } catch {
      // An unreadable file is replaced by what this process holds, which is the
      // only recoverable outcome: refusing to write would strand the machine.
    }
    const byId = new Map<string, RunnerToken>();
    for (const token of [...onDisk, ...this.tokens]) {
      const existing = byId.get(token.id);
      byId.set(
        token.id,
        existing
          ? {
              ...token,
              revokedAt: existing.revokedAt ?? token.revokedAt,
              lastUsedAt: Math.max(existing.lastUsedAt ?? 0, token.lastUsedAt ?? 0) || null,
            }
          : token,
      );
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Flush a pending "last used" on the way out. */
  close(): void {
    if (this.dirty) {
      try {
        this.save();
      } catch {
        // Losing a last-used timestamp on shutdown is not worth a failed exit.
      }
    }
  }

  /**
   * The single plaintext token earlier versions wrote to `<home>/token`.
   *
   * Adopted by hash so the machine keeps working across the upgrade, then
   * removed: leaving it would keep a credential in the clear on disk AND make
   * revoking it appear to do nothing, since the file it came from would still
   * be sitting there looking authoritative.
   */
  private adoptLegacyFile(): void {
    const legacy = join(this.home, 'token');
    if (!existsSync(legacy)) return;
    try {
      const secret = readFileSync(legacy, 'utf8').trim();
      if (!secret) return;
      const hash = sha256(secret);
      if (!this.tokens.some((token) => token.hash === hash)) {
        this.tokens = [
          ...this.tokens,
          {
            id: `rt-${randomBytes(4).toString('hex')}`,
            label: 'adopted from <home>/token',
            hash,
            createdAt: Date.now(),
            lastUsedAt: null,
            revokedAt: null,
          },
        ];
        this.save();
      }
      unlinkSync(legacy);
      log.info('adopted the token from <home>/token into the token store and removed the plaintext file');
    } catch (err) {
      log.warn('could not adopt the legacy token file', { err: String(err) });
    }
  }
}

function isToken(value: unknown): value is RunnerToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.id === 'string' &&
    typeof token.label === 'string' &&
    typeof token.hash === 'string' &&
    typeof token.createdAt === 'number'
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hash first so the lengths always match and the compare stays constant-time. */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

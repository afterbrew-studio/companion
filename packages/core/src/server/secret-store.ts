import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Database } from '@moxxy/companion-services';
import type { SecretStore } from './capabilities.js';

/**
 * The default SecretStore keeps ciphertext in `module_config`. AES-256-GCM
 * authenticates both the value and its `(module,key)` location, so copying a
 * row under another key fails closed. Legacy JSON strings are rewritten on
 * first read; ModuleConfigStore eagerly reads every known secret at boot.
 */
export class SqliteSecretStore implements SecretStore {
  constructor(
    private readonly db: Database,
    private readonly isSecret: (moduleId: string, key: string) => boolean,
    private readonly encryptionKey: Buffer,
  ) {
    if (encryptionKey.byteLength !== 32) throw new Error('secret encryption key must be exactly 32 bytes');
  }

  get(moduleId: string, key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM module_config WHERE module_id = ? AND key = ?`)
      .get(moduleId, key) as { value: string } | undefined;
    if (!row) return null;
    let stored: unknown;
    try {
      stored = JSON.parse(row.value) as unknown;
    } catch {
      throw new Error(`secret ${moduleId}:${key} is corrupt`);
    }
    if (typeof stored === 'string') {
      // Pre-encryption row. Rewrite before returning so a successful boot
      // removes plaintext from SQLite without a destructive schema migration.
      this.set(moduleId, key, stored);
      return stored;
    }
    if (!isEnvelope(stored)) throw new Error(`secret ${moduleId}:${key} has an unsupported envelope`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(stored.nonce, 'base64url'));
      decipher.setAAD(Buffer.from(`${moduleId}\0${key}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(`secret ${moduleId}:${key} could not be decrypted`);
    }
  }

  set(moduleId: string, key: string, value: string): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`${moduleId}\0${key}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const envelope: SecretEnvelope = {
      version: 1,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
    this.db
      .prepare(
        `INSERT INTO module_config (module_id, key, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(module_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(moduleId, key, JSON.stringify(envelope), Date.now());
  }

  delete(moduleId: string, key: string): void {
    this.db.prepare(`DELETE FROM module_config WHERE module_id = ? AND key = ?`).run(moduleId, key);
  }

  keys(moduleId: string): readonly string[] {
    const rows = this.db.prepare(`SELECT key FROM module_config WHERE module_id = ?`).all(moduleId) as {
      key: string;
    }[];
    return rows.map((r) => r.key).filter((k) => this.isSecret(moduleId, k));
  }

  deleteAll(moduleId: string): void {
    for (const key of this.keys(moduleId)) this.delete(moduleId, key);
  }
}

interface SecretEnvelope {
  readonly version: 1;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function isEnvelope(value: unknown): value is SecretEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<SecretEnvelope>;
  return envelope.version === 1
    && typeof envelope.nonce === 'string'
    && typeof envelope.ciphertext === 'string'
    && typeof envelope.tag === 'string';
}

import { z } from 'zod';
import type { Database } from '@moxxy/companion-services';
import type { ModuleConfigAccessor, ModuleConfigField, ModuleConfigValue } from '../module-config.js';
import { HttpError } from './router.js';
import type { ModuleSecrets, SecretStore } from './capabilities.js';
import { RUNTIME_SECRET_PREFIX } from './kernel.js';
import { SqliteSecretStore } from './secret-store.js';

/**
 * Kernel-owned storage + validation for per-module configuration. Values live in
 * the bootstrap `module_config` table (JSON-encoded so string/number/boolean
 * round-trip), keyed (module_id, key). Constructed directly on the DB handle —
 * like the MigrationRunner, NOT through the service registry — so config is
 * readable/writable for modules that are not (yet) loaded.
 */
export class ModuleConfigStore {
  /** Swapped by `provideSecrets`; the default keeps secrets in `module_config`. */
  private secrets: SecretStore;

  constructor(
    private readonly db: Database,
    encryptionKey: Buffer,
    private readonly isSecret: (moduleId: string, key: string) => boolean = () => false,
  ) {
    this.secrets = new SqliteSecretStore(db, isSecret, encryptionKey);
  }

  /** Eagerly migrate pre-encryption rows and fail boot on a bad key/ciphertext. */
  migrateSecrets(moduleIds: readonly string[]): number {
    let migrated = 0;
    for (const moduleId of moduleIds) {
      for (const key of this.secrets.keys(moduleId)) {
        if (this.secrets.get(moduleId, key) !== null) migrated++;
      }
    }
    return migrated;
  }

  /**
   * Hand secret storage to a module-provided backend, carrying existing values
   * across. Without the move, enabling a Vault module would leave every secret
   * behind in SQLite and every module reading as unconfigured; without the
   * delete, the plaintext would stay in the file the swap was meant to empty.
   */
  useSecretStore(
    next: SecretStore,
    moduleIds: readonly string[],
    retainedModuleId?: string,
    onMoved?: (n: number) => void,
  ): void {
    const previous = this.secrets;
    let moved = 0;
    for (const moduleId of moduleIds) {
      if (moduleId === retainedModuleId) continue;
      for (const key of previous.keys(moduleId)) {
        const value = previous.get(moduleId, key);
        if (value === null) continue;
        next.set(moduleId, key, value);
        previous.delete(moduleId, key);
        moved++;
      }
    }
    this.secrets = retainedModuleId ? new RetainedSecretStore(retainedModuleId, previous, next) : next;
    if (moved) onMoved?.(moved);
  }

  /**
   * The module's own secret storage under run-time keys, scoped to `moduleId`.
   *
   * These keys are not in any manifest, so `getConfig` (which walks the declared
   * field list) never reports them and they cannot reach a client through the
   * config surface at all. `useSecretStore` still carries them across a backend
   * swap, because it iterates stored keys rather than declared ones.
   */
  secretsFor(moduleId: string): ModuleSecrets {
    // The prefix is applied here and stripped on the way back, so a module deals
    // in its own plain key names and never learns the convention. That keeps it
    // off the SDK surface, and makes a run-time key structurally incapable of
    // colliding with a declared `kind: 'secret'` config field.
    const full = (key: string): string => `${RUNTIME_SECRET_PREFIX}${key}`;
    return {
      get: (key) => this.secrets.get(moduleId, full(key)),
      set: (key, value) => this.secrets.set(moduleId, full(key), value),
      delete: (key) => this.secrets.delete(moduleId, full(key)),
      keys: () =>
        this.secrets
          .keys(moduleId)
          .filter((k) => k.startsWith(RUNTIME_SECRET_PREFIX))
          .map((k) => k.slice(RUNTIME_SECRET_PREFIX.length)),
    };
  }

  /** Stored values for one module (no defaults merged). */
  valuesFor(moduleId: string): Record<string, ModuleConfigValue> {
    const rows = this.db
      .prepare(`SELECT key, value FROM module_config WHERE module_id = ?`)
      .all(moduleId) as { key: string; value: string }[];
    const out: Record<string, ModuleConfigValue> = {};
    for (const r of rows) {
      if (this.isSecret(moduleId, r.key)) continue;
      const v: unknown = JSON.parse(r.value);
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[r.key] = v;
    }
    for (const key of this.secrets.keys(moduleId)) {
      // Run-time keys are a separate namespace reached through `ctx.secrets`;
      // letting them surface here would put them in `moduleConfig.values()`
      // alongside declared fields, which is not what a module asked for.
      if (key.startsWith(RUNTIME_SECRET_PREFIX)) continue;
      const v = this.secrets.get(moduleId, key);
      if (v !== null) out[key] = v;
    }
    return out;
  }

  /** One scan of stored keys per module — for moduleList()'s configured-ness check. */
  keysByModule(moduleIds: readonly string[]): Map<string, Set<string>> {
    const rows = this.db.prepare(`SELECT module_id, key FROM module_config`).all() as {
      module_id: string;
      key: string;
    }[];
    const map = new Map<string, Set<string>>();
    const setFor = (id: string): Set<string> => {
      let set = map.get(id);
      if (!set) map.set(id, (set = new Set()));
      return set;
    };
    for (const r of rows) if (!this.isSecret(r.module_id, r.key)) setFor(r.module_id).add(r.key);
    for (const id of moduleIds)
      for (const key of this.secrets.keys(id)) {
        // Configured-ness is about DECLARED fields; a run-time key must not
        // make a module look configured.
        if (!key.startsWith(RUNTIME_SECRET_PREFIX)) setFor(id).add(key);
      }
    return map;
  }

  setMany(moduleId: string, entries: Readonly<Record<string, ModuleConfigValue>>): void {
    const upsert = this.db.prepare(
      `INSERT INTO module_config (module_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(module_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const plain = Object.entries(entries).filter(([key]) => !this.isSecret(moduleId, key));
    this.db.transaction(() => {
      const now = Date.now();
      for (const [key, value] of plain) upsert.run(moduleId, key, JSON.stringify(value), now);
    })();
    // Outside the transaction: an external store is not in it, and a rolled-back
    // write it never saw would be a lie either way.
    for (const [key, value] of Object.entries(entries)) {
      if (this.isSecret(moduleId, key)) this.secrets.set(moduleId, key, String(value));
    }
  }

  deleteKey(moduleId: string, key: string): void {
    if (this.isSecret(moduleId, key)) return this.secrets.delete(moduleId, key);
    this.db.prepare(`DELETE FROM module_config WHERE module_id = ? AND key = ?`).run(moduleId, key);
  }

  /** Uninstall's clean slate — wipe everything the user configured for the module. */
  deleteAll(moduleId: string): void {
    this.secrets.deleteAll(moduleId);
    this.db.prepare(`DELETE FROM module_config WHERE module_id = ?`).run(moduleId);
  }

  /** The read-only, live view a module gets as `ctx.moduleConfig` (defaults merged). */
  accessorFor(moduleId: string, fields: readonly ModuleConfigField[]): ModuleConfigAccessor {
    const defaults: Record<string, ModuleConfigValue> = {};
    for (const f of fields) if (f.default !== undefined) defaults[f.key] = f.default;
    return {
      values: () => ({ ...defaults, ...this.valuesFor(moduleId) }),
      get: (key) => this.valuesFor(moduleId)[key] ?? defaults[key] ?? null,
    };
  }
}

/** A secret backend cannot contain the credential needed to reach itself. */
class RetainedSecretStore implements SecretStore {
  constructor(
    private readonly retainedModuleId: string,
    private readonly local: SecretStore,
    private readonly external: SecretStore,
  ) {}

  private store(moduleId: string): SecretStore {
    return moduleId === this.retainedModuleId ? this.local : this.external;
  }

  get(moduleId: string, key: string): string | null {
    return this.store(moduleId).get(moduleId, key);
  }
  set(moduleId: string, key: string, value: string): void {
    this.store(moduleId).set(moduleId, key, value);
  }
  delete(moduleId: string, key: string): void {
    this.store(moduleId).delete(moduleId, key);
  }
  keys(moduleId: string): readonly string[] {
    return this.store(moduleId).keys(moduleId);
  }
  deleteAll(moduleId: string): void {
    this.store(moduleId).deleteAll(moduleId);
  }
}

/** The zod validator one declared field derives to (`undefined` input = "not provided"). */
export function fieldSchema(field: ModuleConfigField): z.ZodType<ModuleConfigValue> {
  switch (field.kind) {
    case 'text': {
      let s = z.string();
      if (field.min !== undefined) s = s.min(field.min);
      if (field.max !== undefined) s = s.max(field.max);
      if (field.pattern !== undefined) s = s.regex(new RegExp(field.pattern));
      return s;
    }
    case 'secret': {
      // Never `''`: an untouched blank password input must not wipe a stored
      // secret — clearing is the explicit `null`. Defaults are rejected because
      // the field spec is public via GET /api/modules.
      if (field.default !== undefined) throw new Error(`secret field '${field.key}' must not declare a default`);
      let s = z.string().min(Math.max(1, field.min ?? 1));
      if (field.max !== undefined) s = s.max(field.max);
      return s;
    }
    case 'number': {
      let s = z.number().int();
      if (field.min !== undefined) s = s.min(field.min);
      if (field.max !== undefined) s = s.max(field.max);
      return s;
    }
    case 'boolean':
      return z.boolean();
    case 'select': {
      const values = (field.options ?? []).map((o) => o.value);
      if (!values.length) throw new Error(`select field '${field.key}' declares no options`);
      return z.enum(values as [string, ...string[]]);
    }
  }
}

/**
 * Validate a config patch against a module's declared fields. Unknown keys are
 * rejected; `null` means "delete the stored value" and passes through; anything
 * else must satisfy the field's derived schema. Throws HttpError(400) with the
 * zod issues so the route edge surfaces them like a body-schema failure.
 */
export function validatePatch(
  fields: readonly ModuleConfigField[],
  patch: Readonly<Record<string, unknown>>,
): { set: Record<string, ModuleConfigValue>; clear: string[] } {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const set: Record<string, ModuleConfigValue> = {};
  const clear: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field) throw new HttpError(400, `unknown config key: ${key}`);
    if (value === undefined) continue;
    if (value === null) {
      clear.push(key);
      continue;
    }
    const parsed = fieldSchema(field).safeParse(value);
    if (!parsed.success) {
      throw new HttpError(400, `invalid value for '${key}': ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    set[key] = parsed.data;
  }
  return { set, clear };
}

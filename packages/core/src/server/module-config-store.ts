import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ModuleConfigAccessor, ModuleConfigField, ModuleConfigValue } from '../module-config.js';
import { HttpError } from './router.js';

/**
 * Kernel-owned storage + validation for per-module configuration. Values live in
 * the bootstrap `module_config` table (JSON-encoded so string/number/boolean
 * round-trip), keyed (module_id, key). Constructed directly on the DB handle —
 * like the MigrationRunner, NOT through the service registry — so config is
 * readable/writable for modules that are not (yet) loaded.
 */
export class ModuleConfigStore {
  constructor(private readonly db: Database.Database) {}

  /** Stored values for one module (no defaults merged). */
  valuesFor(moduleId: string): Record<string, ModuleConfigValue> {
    const rows = this.db
      .prepare(`SELECT key, value FROM module_config WHERE module_id = ?`)
      .all(moduleId) as { key: string; value: string }[];
    const out: Record<string, ModuleConfigValue> = {};
    for (const r of rows) {
      const v: unknown = JSON.parse(r.value);
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[r.key] = v;
    }
    return out;
  }

  /** One scan of stored keys per module — for moduleList()'s configured-ness check. */
  keysByModule(): Map<string, Set<string>> {
    const rows = this.db.prepare(`SELECT module_id, key FROM module_config`).all() as {
      module_id: string;
      key: string;
    }[];
    const map = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = map.get(r.module_id);
      if (!set) map.set(r.module_id, (set = new Set()));
      set.add(r.key);
    }
    return map;
  }

  setMany(moduleId: string, entries: Readonly<Record<string, ModuleConfigValue>>): void {
    const upsert = this.db.prepare(
      `INSERT INTO module_config (module_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(module_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      const now = Date.now();
      for (const [key, value] of Object.entries(entries)) upsert.run(moduleId, key, JSON.stringify(value), now);
    })();
  }

  deleteKey(moduleId: string, key: string): void {
    this.db.prepare(`DELETE FROM module_config WHERE module_id = ? AND key = ?`).run(moduleId, key);
  }

  /** Uninstall's clean slate — wipe everything the user configured for the module. */
  deleteAll(moduleId: string): void {
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

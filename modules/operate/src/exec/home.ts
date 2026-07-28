import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log, paths } from '@moxxy/companion-services';

/**
 * Bootstrap of Companion's isolated MOXXY_HOME (`~/.companion/moxxy-home`).
 *
 * Credential files are SYMLINKED to the user's daily `~/.moxxy`, not copied:
 * OAuth refresh tokens rotate on every use, so two divergent copies burn each
 * other (the classic "refresh token has already been used" 401 — whichever
 * home refreshes first invalidates the other). Sharing the file keeps one
 * rotating token that moxxy's own locking already coordinates. config.yaml
 * stays a copy so Companion can diverge on provider config safely.
 */

/** Credential files shared (symlinked) with the daily home — rotation must be shared. */
const LINK_FILES = ['providers.json', 'vault.json', 'vault.key'] as const;
/** Config copied as a labeled copy; re-import refreshes it. */
const COPY_FILES = ['config.yaml'] as const;

export interface HomeStatus {
  readonly homeDir: string;
  /** True once the home dir skeleton exists (created by loadDaemonConfig). */
  readonly homeReady: boolean;
  /** True when at least config.yaml or providers.json was imported/copied. */
  readonly providersImported: boolean;
}

export function homeStatus(): HomeStatus {
  const home = paths.moxxyHome();
  return {
    homeDir: home,
    homeReady: existsSync(home),
    providersImported:
      existsSync(join(home, 'config.yaml')) || existsSync(join(home, 'providers.json')),
  };
}

/**
 * Import provider config + credentials from the user's daily moxxy home.
 * Credentials are symlinked (shared rotation — see module comment); config is
 * copied. Re-running the import heals older installs that still hold stale
 * credential copies by replacing them with links.
 */
export function importProvidersFromDailyMoxxy(sourceHome?: string): {
  imported: string[];
  missing: string[];
} {
  const source = sourceHome ?? join(homedir(), '.moxxy');
  const target = paths.moxxyHome();
  const imported: string[] = [];
  const missing: string[] = [];
  for (const name of COPY_FILES) {
    const from = join(source, name);
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }
    copyFileSync(from, join(target, name));
    imported.push(name);
  }
  for (const name of LINK_FILES) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }
    try {
      // Replace any previous copy/stale link; lstat so a dangling link counts.
      try {
        lstatSync(to);
        rmSync(to);
      } catch {
        // nothing to replace
      }
      symlinkSync(from, to);
      imported.push(`${name} (linked)`);
    } catch (err) {
      // Filesystems without symlink support fall back to the old copy behavior.
      log.warn('symlink failed, copying credential file instead', { name, err: String(err) });
      copyFileSync(from, to);
      imported.push(name);
    }
  }
  log.info('provider import complete', { imported, missing });
  return { imported, missing };
}

/**
 * Boot-time heal for installs that imported before credentials were shared:
 * a regular-file providers.json copy means burned-refresh-token 401s, so
 * re-run the import (which now links) when the daily home is available.
 */
export function healCredentialLinks(): void {
  const source = join(homedir(), '.moxxy');
  // Whichever credential file this moxxy version uses (providers.json on older
  // ones, vault.json/vault.key on current ones): if the source exists and our
  // copy is a regular file, re-import to replace it with a shared link.
  for (const name of LINK_FILES) {
    if (!existsSync(join(source, name))) continue;
    const target = join(paths.moxxyHome(), name);
    try {
      if (lstatSync(target).isSymbolicLink()) continue; // already shared
    } catch {
      continue; // never imported — the user opts in from Settings
    }
    log.info('replacing stale provider credential copies with links to ~/.moxxy (shared token rotation)');
    importProvidersFromDailyMoxxy();
    return;
  }
}

/**
 * Seed deny rules for unattended agent runs. moxxy's permission policy reads
 * `permissions.json` from its home; goal mode auto-approves everything EXCEPT
 * user deny rules, so this file is the hard fence for fix runs: agents never
 * push — companiond pushes after the human approved the diff.
 */
export function seedPermissionDenyRules(): void {
  const file = join(paths.moxxyHome(), 'permissions.json');
  if (existsSync(file)) return; // user-owned once created; don't clobber edits
  // moxxy PermissionPolicy shape: name = tool-name glob, inputMatches = field → unanchored regex.
  const rules = {
    allow: [],
    deny: [
      {
        name: 'bash',
        inputMatches: { command: 'git\\s+push' },
        reason: 'Companion pushes after the human approved the diff',
      },
    ],
  };
  writeFileSync(file, JSON.stringify(rules, null, 2) + '\n');
}

/** Read a file from the companion moxxy home if present (helper for status endpoints). */
export function readHomeFile(name: string): string | null {
  const file = join(paths.moxxyHome(), name);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Provider names configured in THIS moxxy home, read from disk (no live
 * gateway needed): providers.json on older moxxy versions, config.yaml
 * (plugins.provider.items + default) on current ones. Powers the Settings
 * provider list and the capability set runners advertise in their health.
 */
export function configuredProviderNames(): string[] {
  const names = new Set<string>();
  try {
    const raw = readHomeFile('providers.json');
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const name = (entry as { name?: unknown; provider?: unknown }).name ?? (entry as { provider?: unknown }).provider;
        if (typeof name === 'string') names.add(name);
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(parsed as Record<string, unknown>)) names.add(key);
    }
  } catch {
    // unreadable providers.json — config.yaml below still contributes
  }
  for (const name of providerNamesFromConfigYaml(readHomeFile('config.yaml'))) names.add(name);
  return [...names].sort();
}

export interface ProviderDefaults {
  readonly name: string;
  readonly model: string | null;
}

interface ProviderConfigScan {
  readonly names: Set<string>;
  readonly explicitName: string | null;
  readonly explicitModel: string | null;
  readonly pluginDefault: string | null;
}

/**
 * Active provider defaults from moxxy's config without a YAML dependency.
 * moxxy writes both block YAML and flow maps (`provider: { name: … }`), so the
 * narrow parser accepts exactly those stable provider shapes and ignores the
 * rest of the document.
 */
export function providerDefaultsFromConfigYaml(yaml: string | null): ProviderDefaults | null {
  if (!yaml) return null;
  const scan = scanProviderConfig(yaml);
  const name = scan.explicitName ?? scan.pluginDefault;
  return name ? { name, model: scan.explicitName ? scan.explicitModel : null } : null;
}

/**
 * Provider names from moxxy config.yaml: the active provider, plugin default,
 * and keys under `plugins.provider.items`. Unknown YAML stays a safe no-op.
 */
export function providerNamesFromConfigYaml(yaml: string | null): string[] {
  if (!yaml) return [];
  return [...scanProviderConfig(yaml).names].sort();
}

function scanProviderConfig(yaml: string): ProviderConfigScan {
  const names = new Set<string>();
  let explicitName: string | null = null;
  let explicitModel: string | null = null;
  let pluginDefault: string | null = null;

  // Flow maps are self-contained, including when the surrounding document is
  // itself a flow-style object spread over several lines.
  for (const match of yaml.matchAll(/\bprovider\s*:\s*\{([^{}]*)\}/g)) {
    const body = match[1] ?? '';
    const name = flowField(body, 'name');
    const model = flowField(body, 'model');
    const fallback = flowField(body, 'default');
    if (name) {
      explicitName ??= name;
      explicitModel ??= model;
      names.add(name);
    }
    if (fallback) {
      pluginDefault ??= fallback;
      names.add(fallback);
    }
  }

  const lines = yaml.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!/^\s*provider:\s*$/.test(line)) continue;
    const providerIndent = indentation(line);
    let childIndent: number | null = null;
    let itemsIndent: number | null = null;
    let itemIndent: number | null = null;
    for (let inner = index + 1; inner < lines.length; inner++) {
      const child = lines[inner]!;
      const trimmed = child.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = indentation(child);
      if (indent <= providerIndent) break;
      childIndent ??= indent;

      if (itemsIndent !== null && indent > itemsIndent) {
        itemIndent ??= indent;
        if (indent === itemIndent) {
          const item = yamlKey(trimmed);
          if (item) names.add(item);
        }
        continue;
      }
      if (indent !== childIndent) continue;

      const name = blockField(trimmed, 'name');
      const model = blockField(trimmed, 'model');
      const fallback = blockField(trimmed, 'default');
      if (name) {
        explicitName ??= name;
        names.add(name);
      }
      if (model) explicitModel ??= model;
      if (fallback) {
        pluginDefault ??= fallback;
        names.add(fallback);
      }
      if (/^items:\s*$/.test(trimmed)) itemsIndent = indent;
    }
  }

  return { names, explicitName, explicitModel, pluginDefault };
}

function flowField(body: string, field: string): string | null {
  const match = new RegExp(`(?:^|,)\\s*${field}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^,}]+)`).exec(body);
  return yamlScalar(match?.[1]);
}

function blockField(line: string, field: string): string | null {
  const match = new RegExp(`^${field}\\s*:\\s*(.+)$`).exec(line);
  return yamlScalar(match?.[1]);
}

function yamlScalar(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/,$/, '').trim();
  if (!value || value === 'null' || value === '~') return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' && parsed ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'") || null;
  return value;
}

function yamlKey(line: string): string | null {
  const match = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:#][^:]*):/.exec(line);
  return yamlScalar(match?.[1]);
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

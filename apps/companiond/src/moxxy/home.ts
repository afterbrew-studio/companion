import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.js';
import { paths } from '../config.js';

/**
 * Bootstrap of Companion's isolated MOXXY_HOME (`~/.companion/moxxy-home`).
 *
 * Providers/vault are a one-time COPY from the user's daily `~/.moxxy` — never a
 * live sync. Re-running the import overwrites the copies with fresh ones (e.g.
 * after the user rotates a key in daily moxxy).
 */

/** Files that carry provider credentials + config in a moxxy home. */
const IMPORT_FILES = ['config.yaml', 'providers.json', 'vault.json', 'vault.key'] as const;

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
 * Copy provider config + vault from the user's daily moxxy home. Copies are
 * labeled copies: a later key rotation in ~/.moxxy does NOT propagate until
 * the user re-runs the import.
 */
export function importProvidersFromDailyMoxxy(sourceHome?: string): {
  imported: string[];
  missing: string[];
} {
  const source = sourceHome ?? join(homedir(), '.moxxy');
  const target = paths.moxxyHome();
  const imported: string[] = [];
  const missing: string[] = [];
  for (const name of IMPORT_FILES) {
    const from = join(source, name);
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }
    copyFileSync(from, join(target, name));
    imported.push(name);
  }
  log.info('provider import complete', { imported, missing });
  return { imported, missing };
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

import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.js';
import { paths } from '../config.js';

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

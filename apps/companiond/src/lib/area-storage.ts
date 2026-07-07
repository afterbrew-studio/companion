import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Repo-backed storage for knowledge areas (Specifications, Documentation).
 * Repo-backed items mirror into markdown files inside the Companion-owned
 * clone under the workspace-configured directory, where every agent that runs
 * against the clone can read them.
 */

/** Directories that are never sensible storage targets. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target']);

/** Top-level directories of a clone — the candidates offered by the setup UI. */
export function listTopLevelDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) return false;
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** `Reports CSV export` → `reports-csv-export.md`-ready slug. */
export function slugForTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'untitled';
}

/** A configured directory name must stay a simple relative path. */
export function assertSafeDir(dir: string): void {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(dir) || dir.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('directory must be a simple relative path (letters, digits, ., -, _)');
  }
}

/** Absolute path for a repo-relative file, refusing escapes from the clone. */
function safePath(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`path escapes the clone: ${relPath}`);
  return abs;
}

export function writeRepoFile(root: string, relPath: string, content: string): void {
  const abs = safePath(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`);
}

export function removeRepoFile(root: string, relPath: string): void {
  rmSync(safePath(root, relPath), { force: true });
}

/** Markdown files under `<root>/<dir>` (a few levels deep), repo-relative. */
export function listMarkdownIn(root: string, dir: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (abs: string, depth: number): void => {
    if (depth > maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const path = join(abs, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (/\.(md|mdx)$/i.test(name) && stat.size > 0) found.push(relative(root, path));
    }
  };
  walk(safePath(root, dir), 0);
  return found.sort();
}

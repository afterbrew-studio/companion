import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { SpaServerMessage } from '@companion/contracts';
import { log, paths, extractModelJson } from '@companion/services';
import type {
  AreaStorage,
  AreaStorageConfig,
  AreaStorageState,
  DocRecord,
  DocSearchHit,
  RepoDocFile,
} from '../contract/index.js';
import type { PlanStore } from './plan-store.js';
import type { Checkouts, Orchestrator } from './cross-types.js';
import {
  assertSafeDir,
  listMarkdownIn,
  listTopLevelDirs,
  removeRepoFile,
  slugForTitle,
  writeRepoFile,
} from './area-storage.js';

const draftSchema = z.object({
  title: z.string().min(3).max(200),
  content: z.string().min(40),
});

/** Directories that never hold documentation worth indexing. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'vendor', 'target', '.next']);
const MAX_IMPORT_BYTES = 512 * 1024;
const MAX_IMPORT_FILES = 500;

/**
 * Documentation: workspace knowledge (architecture, business context,
 * runbooks) chunked and indexed for retrieval. The built-in embedder is
 * lexical BM25 over SQLite FTS5 — zero external calls, good enough for
 * grounding agents; the DocRecord.embedder field leaves room for vector
 * embedders later. Docs arrive by hand, by import from a repo clone's
 * markdown, or drafted by a read-only agent.
 */
export class Docs {
  constructor(
    private readonly store: PlanStore,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  list(workspaceId: string): DocRecord[] {
    return this.store.docs.listWorkspace(workspaceId);
  }

  get(id: string): DocRecord | undefined {
    return this.store.docs.get(id);
  }

  search(workspaceId: string, query: string, limit = 8): DocSearchHit[] {
    return this.store.docs.searchChunks(workspaceId, query, limit);
  }

  // ---------- storage configuration -------------------------------------------

  private configKey(workspaceId: string): string {
    return `docs:config:${workspaceId}`;
  }

  /** null until the workspace made its first-visit choice. */
  configFor(workspaceId: string): AreaStorageConfig | null {
    const raw = this.store.settings.get(this.configKey(workspaceId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AreaStorageConfig;
    } catch {
      return null;
    }
  }

  storageState(workspaceId: string): AreaStorageState {
    const dirs = new Set<string>();
    for (const repo of this.store.repos.listByWorkspace(workspaceId)) {
      if (!this.checkouts.hasClone(repo.full_name)) continue;
      for (const dir of listTopLevelDirs(this.checkouts.cloneDir(repo.full_name))) dirs.add(dir);
    }
    return { config: this.configFor(workspaceId), dirs: [...dirs].sort() };
  }

  /**
   * First-visit choice (or a later change): repo directory vs virtual-only.
   * Picking a directory adopts and indexes the markdown already living there.
   */
  configure(workspaceId: string, dir: string | null): { config: AreaStorageConfig; imported: number } {
    if (dir !== null) assertSafeDir(dir);
    const config: AreaStorageConfig = { dir };
    this.store.settings.set(this.configKey(workspaceId), JSON.stringify(config));
    let imported = 0;
    if (dir !== null) {
      for (const repo of this.store.repos.listByWorkspace(workspaceId)) {
        if (!this.checkouts.hasClone(repo.full_name)) continue;
        const root = this.checkouts.cloneDir(repo.full_name);
        imported += this.importFromRepo(workspaceId, repo.full_name, listMarkdownIn(root, dir)).length;
      }
    }
    this.broadcast({ t: 'docs.changed' });
    return { config, imported };
  }

  /** Requested storage against config; repo storage needs a repo AND a dir. */
  private resolveStorage(
    workspaceId: string,
    repo: string | null,
    requested?: AreaStorage,
  ): { storage: AreaStorage; dir: string | null } {
    const dir = this.configFor(workspaceId)?.dir ?? null;
    const storage = requested ?? (dir && repo ? 'repo' : 'virtual');
    if (storage === 'repo' && !repo) throw new Error('repo storage needs the doc to be about a repo');
    if (storage === 'repo' && !dir) {
      throw new Error('repo storage needs a configured docs directory — set it in the Documentation module first');
    }
    return { storage, dir };
  }

  /** A fresh `<dir>/<slug>.md` path no other doc of this repo claims. */
  private freshPath(workspaceId: string, repo: string, dir: string, title: string): string {
    const taken = new Set(
      this.store.docs
        .listWorkspace(workspaceId)
        .filter((d) => d.repo === repo && d.path)
        .map((d) => d.path),
    );
    const slug = slugForTitle(title);
    let path = `${dir}/${slug}.md`;
    for (let n = 2; taken.has(path); n++) path = `${dir}/${slug}-${n}.md`;
    return path;
  }

  /** Mirror a repo-backed doc into its clone file (best-effort on missing clone). */
  private syncFile(doc: DocRecord): void {
    if (doc.storage !== 'repo' || !doc.path || !doc.repo) return;
    if (!this.checkouts.hasClone(doc.repo)) return;
    try {
      writeRepoFile(this.checkouts.cloneDir(doc.repo), doc.path, doc.content);
    } catch (err) {
      log.warn('doc file sync failed', { id: doc.id, path: doc.path, err: String(err) });
    }
  }

  // ---------- lifecycle ---------------------------------------------------------

  create(
    workspaceId: string,
    fields: { repo?: string | null; title: string; content: string; storage?: AreaStorage; path?: string | null },
    source: DocRecord['source'] = 'manual',
  ): DocRecord {
    const repo = fields.repo ?? null;
    // An explicit path (imports) pins repo storage at that exact file.
    const resolved = fields.path
      ? { storage: 'repo' as const, dir: null }
      : this.resolveStorage(workspaceId, repo, fields.storage);
    const doc: DocRecord = {
      id: `doc-${randomUUID().slice(0, 12)}`,
      workspaceId,
      repo,
      title: fields.title,
      content: fields.content,
      source,
      storage: resolved.storage,
      path:
        fields.path ??
        (resolved.storage === 'repo' ? this.freshPath(workspaceId, repo!, resolved.dir!, fields.title) : null),
      embedder: 'local-bm25',
      chunkCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.docs.insert(doc);
    this.store.docs.setChunks(doc.id, workspaceId, chunkMarkdown(fields.content));
    // Imports came FROM the clone — writing back would be a no-op.
    if (!fields.path) this.syncFile(this.store.docs.get(doc.id)!);
    this.broadcast({ t: 'docs.changed' });
    return this.store.docs.get(doc.id)!;
  }

  update(id: string, fields: { title?: string; content?: string; repo?: string | null }): DocRecord {
    const doc = this.store.docs.get(id);
    if (!doc) throw new Error('doc not found');
    this.store.docs.update(id, fields);
    if (fields.content !== undefined) {
      this.store.docs.setChunks(id, doc.workspaceId, chunkMarkdown(fields.content));
    }
    const next = this.store.docs.get(id)!;
    this.syncFile(next);
    this.broadcast({ t: 'docs.changed' });
    return next;
  }

  remove(id: string): void {
    const doc = this.store.docs.get(id);
    if (doc?.storage === 'repo' && doc.path && doc.repo && this.checkouts.hasClone(doc.repo)) {
      try {
        removeRepoFile(this.checkouts.cloneDir(doc.repo), doc.path);
      } catch (err) {
        log.warn('doc file removal failed', { id, path: doc.path, err: String(err) });
      }
    }
    this.store.docs.remove(id);
    this.broadcast({ t: 'docs.changed' });
  }

  /** Markdown files inside a repo's clone, offered for import. */
  importCandidates(repo: string): RepoDocFile[] {
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);
    const root = this.checkouts.cloneDir(repo);
    const files: RepoDocFile[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || files.length >= MAX_IMPORT_FILES) return;
      for (const name of readdirSync(dir)) {
        if (files.length >= MAX_IMPORT_FILES) return;
        const path = join(dir, name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(path, depth + 1);
        } else if (/\.(md|mdx)$/i.test(name) && stat.size > 0 && stat.size <= MAX_IMPORT_BYTES) {
          files.push({ path: relative(root, path), size: stat.size });
        }
      }
    };
    walk(root, 0);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Import selected markdown files as docs — repo-backed at their original
   * path. Re-importing the same file refreshes the existing doc instead of
   * piling up duplicates.
   */
  importFromRepo(workspaceId: string, repo: string, paths: readonly string[]): DocRecord[] {
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);
    const root = resolve(this.checkouts.cloneDir(repo));
    const existing = this.store.docs.listWorkspace(workspaceId);
    const imported: DocRecord[] = [];
    for (const raw of paths.slice(0, MAX_IMPORT_FILES)) {
      const abs = resolve(root, raw);
      // Never follow an escape from the clone (absolute paths, ../ tricks).
      if (abs !== root && !abs.startsWith(root + sep)) continue;
      if (!/\.(md|mdx)$/i.test(abs)) continue;
      let content: string;
      try {
        if (statSync(abs).size > MAX_IMPORT_BYTES) continue;
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      const path = relative(root, abs);
      const title = titleFor(content, path);
      const prior = existing.find(
        (d) => d.repo === repo && (d.path === path || (d.source === 'imported' && d.title === title)),
      );
      if (prior) {
        this.store.docs.update(prior.id, { content, storage: 'repo', path });
        this.store.docs.setChunks(prior.id, workspaceId, chunkMarkdown(content));
        imported.push(this.store.docs.get(prior.id)!);
      } else {
        imported.push(this.create(workspaceId, { repo, title, content, path }, 'imported'));
      }
    }
    this.broadcast({ t: 'docs.changed' });
    return imported;
  }

  /** A read-only agent studies the repo (when given) and writes the doc. */
  async generate(
    workspaceId: string,
    opts: { repo?: string; instructions: string; storage?: AreaStorage },
  ): Promise<DocRecord> {
    let cwd: string | null = null;
    if (opts.repo) {
      if (!this.checkouts.hasClone(opts.repo)) throw new Error(`repo ${opts.repo} has no clone yet`);
      cwd = this.checkouts.cloneDir(opts.repo);
    }
    // Resolve up front so a repo request against an unconfigured workspace
    // fails before any agent time is spent.
    this.resolveStorage(workspaceId, opts.repo ?? null, opts.storage);
    const { finalMessage } = await this.orchestrator.runOneShot({
      kind: 'analysis',
      task: 'plan.analyses',
      title: `Write documentation: ${opts.instructions.slice(0, 60)}`,
      // The orchestrator mkdirs whatever cwd it gets.
      cwd: cwd ?? join(paths.scratch(), 'docs'),
      repo: opts.repo ?? null,
      prompt: generatePrompt(opts.instructions, Boolean(cwd)),
      timeoutMs: 8 * 60_000,
    });
    const draft = draftSchema.parse(extractModelJson(finalMessage ?? ''));
    return this.create(workspaceId, { repo: opts.repo ?? null, storage: opts.storage, ...draft }, 'generated');
  }
}

/** First markdown heading, else the file path. */
function titleFor(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading && heading.slice(0, 180)) || path;
}

/**
 * Heading-aware chunker for the lexical embedder: sections split at h1-h3,
 * long sections packed by paragraph up to ~1600 chars, and every chunk carries
 * its section heading so retrieval hits stay self-explanatory.
 */
export function chunkMarkdown(content: string, maxChars = 1600): string[] {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; body: string[] }> = [{ heading: '', body: [] }];
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) sections.push({ heading: line.replace(/^#+\s*/, '').trim(), body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }

  const chunks: string[] = [];
  for (const section of sections) {
    const text = section.body.join('\n').trim();
    if (!text && !section.heading) continue;
    const prefix = section.heading ? `${section.heading}\n\n` : '';
    if (!text) continue;
    if (prefix.length + text.length <= maxChars) {
      chunks.push(prefix + text);
      continue;
    }
    let current = '';
    for (const para of text.split(/\n\s*\n/)) {
      const piece = para.trim();
      if (!piece) continue;
      if (current && current.length + piece.length + 2 > maxChars - prefix.length) {
        chunks.push(prefix + current);
        current = '';
      }
      // A single paragraph larger than the budget gets hard-sliced.
      if (piece.length > maxChars - prefix.length) {
        for (let at = 0; at < piece.length; at += maxChars - prefix.length) {
          chunks.push(prefix + piece.slice(at, at + maxChars - prefix.length));
        }
      } else {
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
    if (current) chunks.push(prefix + current);
  }
  return chunks.filter((c) => c.trim().length > 0);
}

function generatePrompt(instructions: string, hasRepo: boolean): string {
  const source = hasRepo
    ? `READ-ONLY RULES (mandatory): you may read files and search the repository checked out in the current directory, but you must NOT modify anything. Ground every claim in what the code actually does.`
    : `There is no repository attached — write from the instructions alone, clearly marking assumptions.`;
  return `You are writing a documentation entry for Companion's workspace knowledge base. It will be chunked and indexed so agents and an assistant can retrieve it later — favor precise, self-contained sections with descriptive headings.

${source}

## What to document

${instructions}

Reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "title": "<short doc title>",
  "content": "<the full markdown document>"
}`;
}

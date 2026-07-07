import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  AreaStorage,
  AreaStorageConfig,
  AreaStorageState,
  ProposalRecord,
  SpaServerMessage,
  SpecRecord,
} from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { Checkouts } from '../git/checkouts.js';
import type { Proposals } from '../proposals/proposals.js';
import { extractModelJson } from '../lib/model-json.js';
import {
  assertSafeDir,
  listMarkdownIn,
  listTopLevelDirs,
  removeRepoFile,
  slugForTitle,
  writeRepoFile,
} from '../lib/area-storage.js';

const draftSchema = z.object({
  title: z.string().min(3).max(200),
  content: z.string().min(40),
});

/**
 * Specifications: living markdown documents describing how (part of) a repo
 * should behave. Written by hand or drafted by a read-only agent that studies
 * the actual codebase; a spec can be turned into a feature with one click —
 * it becomes a proposal carrying the full spec as implementation context, then
 * rides the existing analyze → approve → implement lifecycle.
 */
export class Specs {
  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly proposals: Proposals,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  list(workspaceId: string): SpecRecord[] {
    return this.store.specs.listWorkspace(workspaceId);
  }

  // ---------- storage configuration -------------------------------------------

  private configKey(workspaceId: string): string {
    return `specs:config:${workspaceId}`;
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
   * Picking a directory adopts the markdown already living there — those files
   * ARE the repo's specs.
   */
  configure(workspaceId: string, dir: string | null): { config: AreaStorageConfig; imported: number } {
    if (dir !== null) assertSafeDir(dir);
    const config: AreaStorageConfig = { dir };
    this.store.settings.set(this.configKey(workspaceId), JSON.stringify(config));
    let imported = 0;
    if (dir !== null) {
      const existing = this.store.specs.listWorkspace(workspaceId);
      for (const repo of this.store.repos.listByWorkspace(workspaceId)) {
        if (!this.checkouts.hasClone(repo.full_name)) continue;
        const root = this.checkouts.cloneDir(repo.full_name);
        for (const path of listMarkdownIn(root, dir)) {
          let content: string;
          try {
            content = readFileSync(join(root, path), 'utf8');
          } catch {
            continue;
          }
          if (!content.trim()) continue;
          const prior = existing.find((s) => s.repo === repo.full_name && s.path === path);
          if (prior) {
            this.store.specs.update(prior.id, { content });
            continue;
          }
          const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
          this.store.specs.insert({
            id: `spec-${randomUUID().slice(0, 12)}`,
            repo: repo.full_name,
            title: heading?.slice(0, 180) || path,
            content,
            status: 'ready',
            source: 'imported',
            storage: 'repo',
            path,
            generateRunId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          imported++;
        }
      }
    }
    this.broadcast({ t: 'specs.changed' });
    return { config, imported };
  }

  /** Requested storage against the workspace config; repo needs a configured dir. */
  private resolveStorage(repo: string, requested?: AreaStorage): { storage: AreaStorage; dir: string | null } {
    const workspaceId = this.store.repos.get(repo)?.workspace_id ?? null;
    const dir = workspaceId ? (this.configFor(workspaceId)?.dir ?? null) : null;
    const storage = requested ?? (dir ? 'repo' : 'virtual');
    if (storage === 'repo' && !dir) {
      throw new Error('repo storage needs a configured specs directory — set it in the Specifications module first');
    }
    return { storage, dir };
  }

  /** A fresh `<dir>/<slug>.md` path no other spec of this repo claims. */
  private freshPath(repo: string, dir: string, title: string): string {
    const taken = new Set(
      this.store.specs
        .listWorkspace(this.store.repos.get(repo)?.workspace_id ?? '')
        .filter((s) => s.repo === repo && s.path)
        .map((s) => s.path),
    );
    const slug = slugForTitle(title);
    let path = `${dir}/${slug}.md`;
    for (let n = 2; taken.has(path); n++) path = `${dir}/${slug}-${n}.md`;
    return path;
  }

  /** Mirror a repo-backed spec into its clone file (best-effort on missing clone). */
  private syncFile(spec: SpecRecord): void {
    if (spec.storage !== 'repo' || !spec.path) return;
    if (!this.checkouts.hasClone(spec.repo)) return;
    try {
      writeRepoFile(this.checkouts.cloneDir(spec.repo), spec.path, spec.content);
    } catch (err) {
      log.warn('spec file sync failed', { id: spec.id, path: spec.path, err: String(err) });
    }
  }

  // ---------- lifecycle ---------------------------------------------------------

  create(repo: string, title: string, content: string, storage?: AreaStorage): SpecRecord {
    const resolved = this.resolveStorage(repo, storage);
    const spec: SpecRecord = {
      id: `spec-${randomUUID().slice(0, 12)}`,
      repo,
      title,
      content,
      status: 'ready',
      source: 'manual',
      storage: resolved.storage,
      path: resolved.storage === 'repo' ? this.freshPath(repo, resolved.dir!, title) : null,
      generateRunId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.specs.insert(spec);
    this.syncFile(spec);
    this.broadcast({ t: 'specs.changed' });
    return spec;
  }

  update(id: string, fields: { title?: string; content?: string }): SpecRecord {
    const spec = this.store.specs.get(id);
    if (!spec) throw new Error('spec not found');
    // Saving over a failed generation is how you rescue it by hand.
    this.store.specs.update(id, { ...fields, status: 'ready' });
    const next = this.store.specs.get(id)!;
    this.syncFile(next);
    this.broadcast({ t: 'specs.changed' });
    return next;
  }

  remove(id: string): void {
    const spec = this.store.specs.get(id);
    if (spec?.storage === 'repo' && spec.path && this.checkouts.hasClone(spec.repo)) {
      try {
        removeRepoFile(this.checkouts.cloneDir(spec.repo), spec.path);
      } catch (err) {
        log.warn('spec file removal failed', { id, path: spec.path, err: String(err) });
      }
    }
    this.store.specs.remove(id);
    this.broadcast({ t: 'specs.changed' });
  }

  /**
   * Draft a spec from the repo itself (async — resolves when stored). The row
   * exists immediately with status 'generating' so the UI can show progress.
   */
  async generate(repo: string, instructions: string, storage?: AreaStorage): Promise<SpecRecord> {
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);
    // Resolve up front so a repo request against an unconfigured workspace
    // fails before any agent time is spent.
    const resolved = this.resolveStorage(repo, storage);
    const id = `spec-${randomUUID().slice(0, 12)}`;
    const placeholder: SpecRecord = {
      id,
      repo,
      title: instructions.slice(0, 80),
      content: '',
      status: 'generating',
      source: 'generated',
      storage: resolved.storage,
      path: null,
      generateRunId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.specs.insert(placeholder);
    this.broadcast({ t: 'specs.changed' });

    try {
      // Business/context docs the workspace already holds sharpen the draft.
      const workspaceId = this.store.repos.get(repo)?.workspace_id ?? null;
      const docs = workspaceId ? this.store.docs.searchChunks(workspaceId, instructions, 5) : [];
      const { runId, finalMessage } = await this.orchestrator.runOneShot({
        kind: 'analysis',
        title: `Draft spec: ${instructions.slice(0, 60)}`,
        cwd: this.checkouts.cloneDir(repo),
        repo,
        prompt: generatePrompt(instructions, docs.map((d) => `### ${d.title}\n${d.content}`)),
        timeoutMs: 10 * 60_000,
      });
      const draft = draftSchema.parse(extractModelJson(finalMessage ?? ''));
      this.store.specs.update(id, {
        title: draft.title,
        content: draft.content,
        status: 'ready',
        path: resolved.storage === 'repo' ? this.freshPath(repo, resolved.dir!, draft.title) : null,
        generateRunId: runId,
      });
      this.syncFile(this.store.specs.get(id)!);
    } catch (err) {
      log.warn('spec generation failed', { id, repo, err: String(err) });
      this.store.specs.update(id, { status: 'failed' });
      this.broadcast({ t: 'specs.changed' });
      throw err;
    }
    this.broadcast({ t: 'specs.changed' });
    return this.store.specs.get(id)!;
  }

  /**
   * One click from spec to feature: files a proposal that embeds the spec as
   * the source of truth and kicks its feasibility analysis right away.
   */
  createFeature(id: string, opts: { title?: string; notes?: string }): ProposalRecord {
    const spec = this.store.specs.get(id);
    if (!spec) throw new Error('spec not found');
    if (spec.status !== 'ready') throw new Error(`spec is ${spec.status}, not ready`);
    const body = [
      opts.notes?.trim() ? `${opts.notes.trim()}\n` : '',
      `Implement the following specification. Where the notes above and the specification conflict, the notes win.`,
      '',
      `## Specification: ${spec.title}`,
      '',
      spec.content,
    ].join('\n');
    const proposal = this.proposals.create(spec.repo, opts.title?.trim() || spec.title, body);
    // Fire-and-forget, matching how the SPA files a fresh proposal.
    void this.proposals
      .analyze(proposal.id)
      .catch((err) => log.warn('spec feature analysis failed', { proposal: proposal.id, err: String(err) }));
    return proposal;
  }
}

function generatePrompt(instructions: string, docContext: readonly string[]): string {
  const docs =
    docContext.length > 0
      ? `\n## Workspace documentation that may be relevant (business/domain context)\n\n${docContext.join('\n\n')}\n`
      : '';
  return `You are writing a specification for the repository checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase, but you must NOT modify anything. Your ONLY output is the final JSON.

## What the spec should cover

${instructions}
${docs}
## Your task
Study the relevant parts of the codebase, then write a precise, implementation-ready specification in markdown:
- Start from current behavior (cite real modules/files), then specify the desired behavior.
- Cover data model, API surface, UI behavior, edge cases, and acceptance criteria as applicable.
- Be concrete enough that an autonomous engineer could implement against it without guessing.

Reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "title": "<short spec title>",
  "content": "<the full markdown specification>"
}`;
}

import { lstat, readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, resolve } from 'node:path';
import type {
  AgentStorageCleanupRequest,
  AgentStorageCleanupResponse,
  AgentStorageRunLease,
} from '@companion/types';
import { paths } from '@companion/services';
import type { Checkouts } from './checkouts.js';

/**
 * Apply daemon-owned retention inside this runner's managed roots. Candidates
 * are discovered locally — the wire request can protect paths but can never
 * nominate an arbitrary path for deletion.
 */
export async function cleanupRunnerStorage(
  request: AgentStorageCleanupRequest,
  checkouts: Checkouts,
  liveRunIds: readonly string[] = [],
): Promise<AgentStorageCleanupResponse> {
  const now = Date.now();
  const leasesByCwd = new Map(
    request.runs.filter((run) => run.cwd.trim()).map((run) => [resolve(run.cwd), run] as const),
  );
  const leasesByRunId = new Map(request.runs.map((run) => [run.runId, run] as const));
  const live = new Set(liveRunIds);
  const errors: string[] = [];

  const worktrees = await sweepDirectories({
    root: paths.worktrees(),
    cutoff: now - boundedRetention(request.worktreeRetentionMs),
    leasesByCwd,
    leasesByRunId,
    live,
    errors,
    remove: (candidate) => checkouts.removeStaleWorktree(candidate),
  });
  const scratch = await sweepDirectories({
    root: paths.scratch(),
    cutoff: now - boundedRetention(request.scratchRetentionMs),
    leasesByCwd,
    leasesByRunId,
    live,
    errors,
    remove: (candidate) => rm(candidate, { recursive: true, force: true }),
  });
  const sessions = await sweepRunFiles({
    root: paths.sessions(),
    cutoff: now - boundedRetention(request.sessionRetentionMs),
    extensions: ['.json', '.jsonl'],
    leasesByRunId,
    live,
    errors,
  });
  const configs = await sweepRunFiles({
    root: paths.runConfigs(),
    cutoff: now - boundedRetention(request.sessionRetentionMs),
    extensions: ['.yaml'],
    leasesByRunId,
    live,
    errors,
  });

  return {
    removedWorktrees: worktrees,
    removedScratchDirs: scratch,
    removedSessionFiles: sessions,
    removedRunConfigs: configs,
    errors,
  };
}

interface DirectorySweep {
  readonly root: string;
  readonly cutoff: number;
  readonly leasesByCwd: ReadonlyMap<string, AgentStorageRunLease>;
  readonly leasesByRunId: ReadonlyMap<string, AgentStorageRunLease>;
  readonly live: ReadonlySet<string>;
  readonly errors: string[];
  readonly remove: (candidate: string) => Promise<void>;
}

async function sweepDirectories(opts: DirectorySweep): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(opts.root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = resolve(opts.root, entry.name);
    const lease = opts.leasesByCwd.get(candidate) ?? opts.leasesByRunId.get(entry.name);
    if (isProtected(lease, entry.name, opts.live)) continue;
    try {
      const info = await lstat(candidate);
      if (Math.max(info.mtimeMs, lease?.updatedAt ?? 0) > opts.cutoff) continue;
      await opts.remove(candidate);
      removed += 1;
    } catch (err) {
      recordError(opts.errors, entry.name, err);
    }
  }
  return removed;
}

interface FileSweep {
  readonly root: string;
  readonly cutoff: number;
  readonly extensions: readonly string[];
  readonly leasesByRunId: ReadonlyMap<string, AgentStorageRunLease>;
  readonly live: ReadonlySet<string>;
  readonly errors: string[];
}

async function sweepRunFiles(opts: FileSweep): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(opts.root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const extension = opts.extensions.find((suffix) => entry.name.endsWith(suffix));
    if (!extension) continue;
    const runId = entry.name.slice(0, -extension.length);
    const lease = opts.leasesByRunId.get(runId);
    if (isProtected(lease, runId, opts.live)) continue;
    const candidate = resolve(opts.root, entry.name);
    try {
      const info = await lstat(candidate);
      if (Math.max(info.mtimeMs, lease?.updatedAt ?? 0) > opts.cutoff) continue;
      await rm(candidate, { force: true });
      removed += 1;
    } catch (err) {
      recordError(opts.errors, basename(candidate), err);
    }
  }
  return removed;
}

function isProtected(
  lease: AgentStorageRunLease | undefined,
  fallbackRunId: string,
  live: ReadonlySet<string>,
): boolean {
  return lease?.protected === true || live.has(lease?.runId ?? fallbackRunId);
}

/** A compromised/misconfigured daemon must not turn a negative duration into
 * immediate deletion. One hour is the smallest policy the runner will honor. */
function boundedRetention(value: number): number {
  return Number.isFinite(value) ? Math.max(60 * 60_000, Math.floor(value)) : 24 * 60 * 60_000;
}

/** Keep the wire response bounded and free of runner-local absolute paths. */
function recordError(errors: string[], name: string, err: unknown): void {
  if (errors.length < 100) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
        ? err.code
        : err instanceof Error
          ? err.name
          : 'unknown error';
    errors.push(`${name}: ${code}`);
  } else if (errors.length === 100) {
    errors.push('additional errors omitted');
  }
}

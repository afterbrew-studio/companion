import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log, paths } from '@companion/services';

const execFileP = promisify(execFile);

/**
 * Companion-owned clones + one git worktree per agent run. The user's own
 * checkout is never touched.
 *
 * PAT hygiene: the token never lands in .git/config or remote URLs. Every
 * network operation passes an ephemeral credential helper via `-c` that echoes
 * the token from the child's env.
 *
 * Network-touching methods take an optional per-call `token` used when the
 * constructor thunk yields none — on a runner agent that's the hub-supplied
 * credential riding the request, overridden by the machine's own
 * COMPANION_RUNNER_GITHUB_TOKEN when set.
 */
export class Checkouts {
  /** Per-repo mutex: `git worktree add` / fetch mutate shared .git state. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly token: () => string | null) {}

  cloneDir(fullName: string): string {
    const [owner, name] = fullName.split('/');
    return join(paths.repos(), owner ?? '_', name ?? '_');
  }

  hasClone(fullName: string): boolean {
    return existsSync(join(this.cloneDir(fullName), '.git'));
  }

  async clone(fullName: string, token?: string): Promise<void> {
    await this.locked(fullName, async () => {
      const dir = this.cloneDir(fullName);
      if (existsSync(join(dir, '.git'))) return;
      mkdirSync(dir, { recursive: true });
      await this.git(['clone', '--quiet', `https://github.com/${fullName}.git`, dir], undefined, token);
      log.info(`cloned ${fullName}`);
    });
  }

  async fetch(fullName: string, token?: string): Promise<void> {
    await this.locked(fullName, () =>
      this.git(['fetch', '--quiet', 'origin'], this.cloneDir(fullName), token),
    );
  }

  /** Create a worktree + branch for a run. Returns the worktree path. */
  async addWorktree(
    fullName: string,
    runId: string,
    branch: string,
    baseBranch: string,
    token?: string,
  ): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(['fetch', '--quiet', 'origin', baseBranch], clone, token);
      const wt = join(paths.worktrees(), runId);
      await this.git(['worktree', 'add', '-b', branch, wt, `origin/${baseBranch}`], clone);
      // Keep run scaffolding (agent notes etc.) out of accidental commits.
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });
  }

  /**
   * Worktree checked out AT an existing remote branch (a PR head) — for agents
   * that continue someone's branch instead of starting a fresh one. The local
   * branch is named after the run so concurrent repairs never collide; pushes
   * go to the original remote branch via `push(..., branch)`.
   */
  async addWorktreeAtBranch(fullName: string, runId: string, branch: string, token?: string): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(['fetch', '--quiet', 'origin', branch], clone, token);
      const wt = join(paths.worktrees(), runId);
      await this.git(['worktree', 'add', '-b', `companion/${runId}`, wt, `origin/${branch}`], clone);
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });
  }

  async removeWorktree(fullName: string, worktreePath: string): Promise<void> {
    await this.locked(fullName, async () => {
      await this.git(['worktree', 'remove', '--force', worktreePath], this.cloneDir(fullName)).catch(
        () => undefined,
      );
    });
  }

  async pruneWorktrees(fullName: string): Promise<void> {
    await this.locked(fullName, () =>
      this.git(['worktree', 'prune'], this.cloneDir(fullName)).catch(() => undefined),
    );
  }

  /** Diff of a worktree vs its base (staged + unstaged + committed on the branch). */
  async diffVsBase(worktree: string, baseBranch: string): Promise<string> {
    // Committed work on the branch…
    const committed = await this.git(['diff', `origin/${baseBranch}...HEAD`], worktree);
    // …plus anything the agent left uncommitted.
    const uncommitted = await this.git(['diff', 'HEAD'], worktree).catch(() => ({ stdout: '' }));
    const untracked = await this.untrackedPatch(worktree);
    return [committed.stdout, uncommitted.stdout, untracked].filter(Boolean).join('\n');
  }

  async hasChanges(worktree: string, baseBranch: string): Promise<boolean> {
    return (await this.diffVsBase(worktree, baseBranch)).trim().length > 0;
  }

  /** Commit everything in the worktree (agent may have left work uncommitted). */
  async commitAll(worktree: string, message: string): Promise<void> {
    await this.git(['add', '-A'], worktree);
    const status = await this.git(['status', '--porcelain'], worktree);
    if (!status.stdout.trim()) return;
    await this.git(
      ['-c', 'user.name=Companion', '-c', 'user.email=companion@localhost', 'commit', '-q', '-m', message],
      worktree,
    );
  }

  async push(fullName: string, worktree: string, branch: string, token?: string): Promise<void> {
    await this.locked(fullName, () =>
      this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], worktree, token),
    );
  }

  // ---------- internals ---------------------------------------------------------

  private async untrackedPatch(worktree: string): Promise<string> {
    const files = await this.git(['ls-files', '--others', '--exclude-standard'], worktree);
    const list = files.stdout.split('\n').filter(Boolean);
    let patch = '';
    for (const file of list.slice(0, 50)) {
      const diff = await this.git(['diff', '--no-index', '/dev/null', file], worktree).catch(
        (err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }),
      );
      patch += diff.stdout;
    }
    return patch;
  }

  private git(
    args: string[],
    cwd: string | undefined,
    fallbackToken?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const token = this.token() ?? fallbackToken?.trim() ?? null;
    // Ephemeral credential helper: git asks it for credentials; it answers with
    // the PAT from env. Nothing token-shaped touches disk or process args.
    // The leading empty helper CLEARS inherited helpers (osxkeychain etc.) —
    // helpers are cumulative, and a stale keychain identity would otherwise
    // win and push as the wrong user.
    const cred = token
      ? [
          '-c',
          'credential.helper=',
          '-c',
          'credential.helper=!f() { echo "username=x-access-token"; echo "password=$COMPANION_GH_TOKEN"; }; f',
        ]
      : [];
    return execFileP('git', [...cred, ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...(token ? { COMPANION_GH_TOKEN: token } : {}),
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  }

  private locked<T>(fullName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(fullName) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(fullName, next.catch(() => undefined));
    return next;
  }
}

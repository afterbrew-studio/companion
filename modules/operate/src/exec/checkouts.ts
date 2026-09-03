import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { log, paths } from '@moxxy/companion-services';
import type { GitAccess, GitCredentialResolver } from '../contract/index.js';

const execFileP = promisify(execFile);

/** A git invocation that exited non-zero, carrying its streams for callers
 *  (some read stdout of an expected failure, e.g. `diff --no-index`). */
class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

class GitOutputLimitError extends GitCommandError {}

export interface DiffFileSize {
  readonly path: string;
  readonly changed: number;
}

/**
 * Parse `git diff --numstat -z`. With `-z`, a rename is encoded as an empty
 * pathname in the count record followed by the old and new path as separate
 * NUL records. Splitting on lines would corrupt valid repository paths and
 * make the review planner omit part of the change.
 */
export function parseDiffNumstat(output: string): DiffFileSize[] {
  const records = output.split('\0');
  const files: DiffFileSize[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
    if (firstTab < 1 || secondTab < 0) throw new Error('git numstat returned a malformed record');
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      // The pre-image is useful only to consume the format. Review the new path,
      // which is what `git diff ... -- <path>` accepts at the PR head.
      i += 1;
      const previousPath = records[i] ?? '';
      i += 1;
      path = records[i] ?? previousPath;
    }
    if (!path) throw new Error('git numstat returned a record without a path');
    const added = additions === '-' ? 0 : Number(additions);
    const removed = deletions === '-' ? 0 : Number(deletions);
    if (!Number.isSafeInteger(added) || added < 0 || !Number.isSafeInteger(removed) || removed < 0) {
      throw new Error('git numstat returned invalid line counts');
    }
    // A binary, mode-only or pure-rename change still needs a review group.
    files.push({ path, changed: Math.max(1, added + removed) });
  }
  return files;
}

/**
 * execFile's message is `Command failed: <the entire argv>` — which for network
 * operations means the ephemeral credential helper ends up quoted in every
 * user-facing error, burying git's actual complaint. Keep git's own words.
 */
function gitFailure(args: readonly string[], err: unknown): GitCommandError {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const stdout = e.stdout ?? '';
  const stderr = e.stderr ?? '';
  const detail =
    (stderr.trim() || (e.message ?? '').replace(/^Command failed:.*$/m, '').trim() || 'git failed')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' ');
  // The subcommand, skipping leading `-c key=value` pairs.
  const verb = args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? 'command';
  return new GitCommandError(`git ${verb} failed: ${redactSecrets(detail)}`, stdout, stderr);
}

/** git may echo a remote URL back; never let a credential in one reach a UI. */
function redactSecrets(text: string): string {
  return text
    .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/\/\/[^/@\s]+@/g, '//***@');
}

/**
 * Companion-owned clones + one git worktree per agent run. The user's own
 * checkout is never touched.
 *
 * PAT hygiene: the token never lands in .git/config or remote URLs. Every
 * network operation passes an ephemeral credential helper via `-c` that echoes
 * the token from the child's env.
 *
 * Network-touching methods take an optional per-call `token` used when the
 * constructor thunk yields none. On a remote runner this is the hub-supplied,
 * access-verified personal credential riding the request and it always wins
 * over any legacy machine credential.
 */

/**
 * A repository may refuse a commit that does not explain itself: rayf will not
 * accept a change to a document it maps to code, or to the body of an accepted
 * decision record, without a trailer naming the document and why. The daemon
 * writes the commit, not the agent, so until now the lane could not satisfy
 * those gates at all - the work was correct and the commit was rejected
 * forever, one repair cycle after another.
 *
 * The agent leaves them in this file and the daemon appends them. Read and
 * deleted before anything is staged, so the file never lands in the tree.
 */
const COMMIT_TRAILERS_FILE = '.companion-commit-trailers';

/** Enough for a change touching several owned documents; far short of a prose channel. */
const MAX_TRAILERS = 20;
const MAX_TRAILER_LENGTH = 300;

/**
 * `token: value` or `token(scope): value` — git's own trailer shape, which is
 * what a repository's parser reads.
 */
const TRAILER_SHAPE = /^[A-Za-z][A-Za-z0-9-]*(\([^()\n]{1,200}\))?: \S.*$/;

/**
 * Tokens the agent may not write, whatever the repository's own vocabulary is.
 * Attribution because the commit is the daemon's and a model must not sign it
 * as someone else - the same reason the base is reset before committing. Issue
 * closers because they act on GitHub rather than describing the change, and a
 * trailer could close an issue nobody connected to this work.
 */
const FORBIDDEN_TRAILERS = new Set([
  'co-authored-by',
  'signed-off-by',
  'closes',
  'close',
  'fixes',
  'fix',
  'resolves',
  'resolve',
]);

function readCommitTrailers(worktree: string): string[] {
  const file = join(worktree, COMMIT_TRAILERS_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // Removed whether or not a single line survives validation: leaving a
  // rejected file behind would stage it on the next commit.
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort. `git add -A` would stage it, which the caller's own
    // conflict-marker check does not cover, so log rather than fail the commit.
    log.warn('could not remove the commit-trailer file', { worktree });
  }
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trailer = line.trim();
    if (trailer === '' || trailer.startsWith('#')) continue;
    if (trailer.length > MAX_TRAILER_LENGTH || !TRAILER_SHAPE.test(trailer)) {
      log.warn('ignoring a malformed commit trailer', { trailer: trailer.slice(0, 120) });
      continue;
    }
    const token = trailer.slice(0, trailer.indexOf(':')).replace(/\(.*$/, '').toLowerCase();
    if (FORBIDDEN_TRAILERS.has(token)) {
      log.warn('ignoring a commit trailer an agent may not write', { token });
      continue;
    }
    kept.push(trailer);
    if (kept.length === MAX_TRAILERS) break;
  }
  return kept;
}

export class Checkouts {
  /** Per-repo mutex: `git worktree add` / fetch mutate shared .git state. */
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * The thunk resolves per repo, profile and required access, and may be async
   * because access is probed at GitHub. Only network operations resolve it.
   */
  constructor(
    private readonly token: GitCredentialResolver,
    /** Host clones go to; a GitHub Enterprise Server serves the same paths. */
    private readonly gitHost: string = 'github.com',
    /**
     * Instance policy gate for a push target, injected because `exec/` is also
     * bundled into the published runner CLI and must not reach for kernel
     * config. A no-op default is correct there: a runner pushes only what the
     * daemon already authorised and credentialed.
     */
    private readonly assertPushTarget: (repo: string, branch: string) => void = () => {},
  ) {}

  /** The explicit per-operation personal credential wins; the resolver is for local calls. */
  private async creds(
    fullName: string,
    fallback?: string,
    username?: string | null,
    access: GitAccess = 'read',
  ): Promise<string> {
    const credential = fallback?.trim() || (await this.token(fullName, username, access)) || null;
    if (!credential) {
      throw new Error(
        access === 'write'
          ? `no personal GitHub credential with push access to ${fullName} — connect an account with write access, or ask the repository owner to grant it`
          : `no personal GitHub credential with access to ${fullName}`,
      );
    }
    return credential;
  }

  cloneDir(fullName: string): string {
    const [owner, name] = fullName.split('/');
    return join(paths.repos(), owner ?? '_', name ?? '_');
  }

  hasClone(fullName: string): boolean {
    return existsSync(join(this.cloneDir(fullName), '.git'));
  }

  async clone(fullName: string, token?: string, username?: string | null): Promise<void> {
    await this.locked(fullName, async () => {
      const dir = this.cloneDir(fullName);
      if (existsSync(join(dir, '.git'))) return;
      mkdirSync(dir, { recursive: true });
      await this.git(
        ['clone', '--quiet', `https://${this.gitHost}/${fullName}.git`, dir],
        undefined,
        await this.creds(fullName, token, username),
      );
      log.info(`cloned ${fullName}`);
    });
  }

  async fetch(fullName: string, token?: string, username?: string | null): Promise<void> {
    await this.locked(fullName, async () =>
      this.git(['fetch', '--quiet', 'origin'], this.cloneDir(fullName), await this.creds(fullName, token, username)),
    );
  }

  /** Create a worktree + branch for a run. Returns the worktree path. */
  async addWorktree(
    fullName: string,
    runId: string,
    branch: string,
    baseBranch: string,
    token?: string,
    username?: string | null,
  ): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(['fetch', '--quiet', 'origin', baseBranch], clone, await this.creds(fullName, token, username));
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
  async addWorktreeAtBranch(
    fullName: string,
    runId: string,
    branch: string,
    token?: string,
    username?: string | null,
  ): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(['fetch', '--quiet', 'origin', branch], clone, await this.creds(fullName, token, username));
      const wt = join(paths.worktrees(), runId);
      await this.git(['worktree', 'add', '-b', `companion/${runId}`, wt, `origin/${branch}`], clone);
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });
  }

  /**
   * Temporary detached worktree at GitHub's synthetic pull-request head ref.
   * Unlike an origin branch checkout this also works for PRs opened from forks.
   * The base tracking ref is refreshed so agents can inspect the complete PR
   * incrementally with `git diff origin/<base>...HEAD -- <path>` instead of
   * receiving one oversized diff in their prompt.
   */
  async withPullRequestWorktree<T>(
    fullName: string,
    key: string,
    number: number,
    baseBranch: string,
    fn: (cwd: string) => Promise<T>,
    token?: string,
    username?: string | null,
  ): Promise<T> {
    const worktree = await this.addPullRequestWorktree(fullName, key, number, baseBranch, token, username);
    try {
      return await fn(worktree);
    } finally {
      await this.removeWorktree(fullName, worktree).catch(() => undefined);
    }
  }

  /**
   * Temporary detached worktree at the repository's current base branch.
   * Read-only agents must never receive the shared clone as their cwd: a
   * compromised prompt could corrupt the cache for every later operation even
   * when it cannot push. The worktree is disposable, while the clone remains a
   * Git-owned object/cache store only.
   */
  async withBaseWorktree<T>(
    fullName: string,
    key: string,
    baseBranch: string,
    fn: (cwd: string) => Promise<T>,
    token?: string,
    username?: string | null,
  ): Promise<T> {
    const worktree = await this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(
        ['fetch', '--quiet', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        clone,
        await this.creds(fullName, token, username),
      );
      const wt = join(paths.worktrees(), key);
      await this.git(['worktree', 'add', '--detach', wt, `origin/${baseBranch}`], clone);
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });
    try {
      return await fn(worktree);
    } finally {
      await this.removeWorktree(fullName, worktree).catch(() => undefined);
    }
  }

  /**
   * The same checkout, kept until the caller removes it.
   *
   * For work that outlives one turn — a conversation about a review that must
   * be able to read the code between questions — where re-cloning the pull
   * request per question would dominate the cost of answering it. The caller
   * owns the teardown; forgetting it leaks a worktree.
   */
  async addPullRequestWorktree(
    fullName: string,
    key: string,
    number: number,
    baseBranch: string,
    token?: string,
    username?: string | null,
  ): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      const credential = await this.creds(fullName, token, username);
      await this.git(
        ['fetch', '--quiet', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        clone,
        credential,
      );
      await this.git(['fetch', '--quiet', 'origin', `refs/pull/${number}/head`], clone, credential);
      const wt = join(paths.worktrees(), key);
      await this.git(['worktree', 'add', '--detach', wt, 'FETCH_HEAD'], clone);
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });
  }

  /**
   * One file as it stands at a pull request's head, read from the local clone.
   *
   * This is what makes "show me more context" free: the objects are already on
   * disk, so expanding a diff costs a `git show` rather than an API call and a
   * slice of the rate limit. The ref is fetched first because a pull request
   * head is not a branch this clone tracks.
   */
  async readPullRequestFile(fullName: string, number: number, path: string, username?: string | null): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(
        ['fetch', '--quiet', 'origin', `refs/pull/${number}/head`],
        clone,
        await this.creds(fullName, undefined, username),
      );
      const { stdout } = await this.git(['show', `FETCH_HEAD:${path}`], clone);
      return stdout;
    });
  }

  async removeWorktree(fullName: string, worktreePath: string): Promise<void> {
    const managed = this.managedWorktree(worktreePath);
    await this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      const cloneReady = existsSync(join(clone, '.git'));
      if (cloneReady) {
        await this.git(['worktree', 'remove', '--force', managed], clone).catch(() => undefined);
      }
      // `git worktree remove` cannot help when the clone/admin dir vanished.
      // The path was resolved as a direct child of our managed root, so the
      // orphan fallback cannot escape into an operator-owned checkout.
      await rm(managed, { recursive: true, force: true });
      // Prune after the fallback removal too: if `git worktree remove` failed,
      // the administrative entry becomes stale only once the directory is gone.
      if (cloneReady) await this.git(['worktree', 'prune', '--expire', 'now'], clone).catch(() => undefined);
    });
  }

  /** Remove a stale worktree discovered locally by the storage janitor. The
   * .git pointer identifies the owning clone when it still exists; otherwise
   * remove only the already-validated orphan directory. */
  async removeStaleWorktree(worktreePath: string): Promise<void> {
    const managed = this.managedWorktree(worktreePath);
    const fullName = this.repoForWorktree(managed);
    if (fullName) {
      await this.removeWorktree(fullName, managed);
      return;
    }
    await rm(managed, { recursive: true, force: true });
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

  /**
   * A committed PR diff up to a caller-owned byte ceiling. `null` means the
   * patch crossed the ceiling; the child is stopped there, so a minified or
   * generated file cannot allocate the normal 32 MiB git buffer merely so the
   * reviewer can decide not to place it in a prompt.
   *
   * PR review worktrees are detached, clean synthetic heads, so unlike
   * `diffVsBase` this intentionally has no uncommitted/untracked component.
   */
  async diffVsBaseBounded(worktree: string, baseBranch: string, maxBytes: number): Promise<string | null> {
    const ceiling = Math.min(Math.max(Math.trunc(maxBytes), 1), 32 * 1024 * 1024);
    try {
      return (await this.git(['diff', `origin/${baseBranch}...HEAD`], worktree, undefined, ceiling)).stdout;
    } catch (err) {
      if (err instanceof GitOutputLimitError) return null;
      throw err;
    }
  }

  /** Lightweight PR-review plan: bounded by filenames, not the diff body. */
  async diffFileSizes(worktree: string, baseBranch: string): Promise<DiffFileSize[]> {
    const { stdout } = await this.git(['diff', '--numstat', '-z', '-M', `origin/${baseBranch}...HEAD`], worktree);
    return parseDiffNumstat(stdout);
  }

  /** A server-controlled diff slice for a read-only agent prompt. */
  async diffPaths(worktree: string, baseBranch: string, paths: readonly string[]): Promise<string> {
    if (paths.length === 0) return '';
    return (await this.git(['diff', `origin/${baseBranch}...HEAD`, '--', ...paths], worktree)).stdout;
  }

  async hasChanges(worktree: string, baseBranch: string): Promise<boolean> {
    return (await this.diffVsBase(worktree, baseBranch)).trim().length > 0;
  }

  /** Commit everything in the worktree (agent may have left work uncommitted). */
  /**
   * Stage everything and commit it, refusing anything still in conflict.
   *
   * `git add -A` is indiscriminate, so without the check an agent that gave up
   * halfway through a merge had its `<<<<<<<` markers staged, committed and
   * pushed, and the branch stopped compiling. `--check` on the staged diff is
   * git's own answer to "did a conflict marker survive", and refusing here is
   * the last point before the push where it can still be caught.
   *
   * `author` signs the commit. Without one it lands as a local identity GitHub
   * cannot attribute to anybody, which is how agent work ends up authored by a
   * user that does not exist.
   */
  async commitAll(
    worktree: string,
    message: string,
    author?: { name: string; email: string },
    baseBranch?: string,
  ): Promise<void> {
    // Read and removed BEFORE `git add -A`, so the file itself is never staged.
    const trailers = readCommitTrailers(worktree);
    await this.git(['add', '-A'], worktree);
    if (baseBranch) {
      // Agents are asked to leave changes uncommitted, but a harness can still
      // ignore that instruction. A fresh PR has no history worth preserving,
      // so move HEAD back to the server-selected base while retaining the
      // final reviewed tree in the index. The commit below is then guaranteed
      // to have Companion's message/author and no model attribution trailer.
      await this.git(['reset', '--soft', `origin/${baseBranch}`], worktree);
    }
    const status = await this.git(['status', '--porcelain'], worktree);
    if (!status.stdout.trim()) return;

    const unmerged = await this.git(['diff', '--cached', '--name-only', '--diff-filter=U'], worktree);
    if (unmerged.stdout.trim()) {
      throw new Error(`unresolved merge conflicts in ${unmerged.stdout.trim().split('\n').join(', ')}`);
    }
    const markers = await this.git(['diff', '--cached', '--check'], worktree).catch(
      (err: unknown) => ({ stdout: (err as { stdout?: string }).stdout ?? '' }),
    );
    const leftover = markers.stdout
      .split('\n')
      .filter((line) => line.includes('conflict marker'))
      .map((line) => line.split(':')[0])
      .filter((path, i, all) => path && all.indexOf(path) === i);
    if (leftover.length > 0) {
      throw new Error(`conflict markers left in ${leftover.join(', ')} — the merge was not finished`);
    }

    const name = author?.name ?? 'Companion';
    const email = author?.email ?? 'companion@localhost';
    // Trailers are a SECOND `-m`, which git renders as its own paragraph, so a
    // repository's parser sees them where it expects to and the subject stays
    // one line.
    const body = trailers.length > 0 ? ['-m', trailers.join('\n')] : [];
    await this.git(
      ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message, ...body],
      worktree,
    );
  }

  async push(
    fullName: string,
    worktree: string,
    branch: string,
    token?: string,
    username?: string | null,
  ): Promise<void> {
    // Before the lock and before any credential is resolved: a refused push must
    // not queue behind a fetch or reach GitHub's rate limit to be told no.
    this.assertPushTarget(fullName, branch);
    await this.locked(fullName, async () =>
      this.git(
        ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`],
        worktree,
        await this.creds(fullName, token, username, 'write'),
      ),
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

  private async git(
    args: string[],
    cwd: string | undefined,
    /** Already-resolved credential (network operations only — see creds()). */
    token?: string | null,
    maxBuffer = 32 * 1024 * 1024,
  ): Promise<{ stdout: string; stderr: string }> {
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
    try {
      return await execFileP('git', [...cred, ...args], {
        cwd,
        maxBuffer,
        env: {
          ...process.env,
          ...(token ? { COMPANION_GH_TOKEN: token } : {}),
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        const failure = gitFailure(args, err);
        throw new GitOutputLimitError(failure.message, failure.stdout, failure.stderr);
      }
      throw gitFailure(args, err);
    }
  }

  private locked<T>(fullName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(fullName) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(fullName, next.catch(() => undefined));
    return next;
  }

  /**
   * Is this a worktree THIS process manages? The public form of the same check
   * `managedWorktree` makes, for callers that must refuse rather than throw: the
   * verify endpoint uses it so a cwd from anywhere else cannot turn "verify this
   * worktree" into "run this command on my machine".
   */
  isManagedPath(worktreePath: string): boolean {
    try {
      this.managedWorktree(worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  private managedWorktree(worktreePath: string): string {
    const root = resolve(paths.worktrees());
    const candidate = resolve(worktreePath);
    if (dirname(candidate) !== root) throw new Error('worktree path is outside the managed root');
    return candidate;
  }

  private repoForWorktree(worktreePath: string): string | null {
    let pointer: string;
    try {
      pointer = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    } catch {
      return null;
    }
    if (!pointer.startsWith('gitdir:')) return null;
    let gitdir: string;
    let reposRoot: string;
    try {
      // macOS aliases /var to /private/var; compare canonical paths so a valid
      // managed clone is not mistaken for an orphan in temporary/data roots.
      gitdir = realpathSync(resolve(worktreePath, pointer.slice('gitdir:'.length).trim()));
      reposRoot = realpathSync(paths.repos());
    } catch {
      return null;
    }
    const worktreesAdmin = dirname(gitdir);
    const gitAdmin = dirname(worktreesAdmin);
    if (basename(worktreesAdmin) !== 'worktrees' || basename(gitAdmin) !== '.git') return null;
    const clone = dirname(gitAdmin);
    const rel = relative(reposRoot, clone);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
    const parts = rel.split(sep).filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
  }
}

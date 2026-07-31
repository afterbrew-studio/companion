/**
 * Minimal GitHub REST client on global fetch — no octokit dependency tree.
 * ETag-aware GETs keep polling cheap against the 5k/hr PAT budget.
 */

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * A spent budget answers with the same 403 as "you may not read this", so
     * callers that turn a status into a verdict about access need it apart.
     */
    readonly rateLimited: boolean = false,
  ) {
    super(message);
  }
}

/** github.com; a GitHub Enterprise Server instance serves the same paths under `/api/v3`. */
export const DEFAULT_API = 'https://api.github.com';

/**
 * Ceiling on the per-client ETag cache. Generous enough that the hot paths (one
 * repo's PR list, each open PR's checks) all stay resident, small enough that a
 * daemon running for months cannot accumulate a response body per commit.
 */
const MAX_ETAG_ENTRIES = 500;

export class GitHubClient {
  private readonly etags = new Map<string, { etag: string; body: unknown }>();
  private readonly branchCache = new Map<string, { at: number; branches: GhBranch[] }>();
  private readonly branchInflight = new Map<string, Promise<GhBranch[]>>();

  constructor(
    private readonly token: string,
    private readonly api: string = DEFAULT_API,
    /**
     * Instance policy gate for anything that MUTATES on the forge. Injected
     * rather than read here so this file stays a thin transport with no idea
     * what a policy is; a no-op default keeps it usable in tests and scripts.
     *
     * `what` names the operation for the audit trail.
     */
    private readonly assertWrite: (what: string) => void = () => {},
  ) {}

  /**
   * GET with ETag cache. Returns the cached body on 304.
   *
   * Bounded LRU rather than an open map: some cached paths carry a commit SHA
   * (`/commits/:ref/check-runs`), and those keys are unbounded over a
   * repository's life while each entry holds a whole response body. Caching
   * them is still right — the checks poller asks about the same head many times
   * while CI runs, which is exactly what the 304 is for — so the fix is a
   * ceiling, not an exemption.
   */
  async get<T>(path: string): Promise<T> {
    const cached = this.etags.get(path);
    const res = await fetch(`${this.api}${path}`, {
      headers: {
        ...this.headers(),
        ...(cached ? { 'if-none-match': cached.etag } : {}),
      },
    });
    if (res.status === 304 && cached) {
      // Re-insert to move it to the young end: a path still being polled must
      // not be evicted just because it was first seen long ago.
      this.etags.delete(path);
      this.etags.set(path, cached);
      return cached.body as T;
    }
    if (!res.ok) throw await this.error(res, path);
    const body = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag) {
      this.etags.delete(path);
      this.etags.set(path, { etag, body });
      // Map iterates in insertion order, so the first key is the least recently
      // used one.
      while (this.etags.size > MAX_ETAG_ENTRIES) {
        const oldest = this.etags.keys().next().value;
        if (oldest === undefined) break;
        this.etags.delete(oldest);
      }
    }
    return body;
  }

  /**
   * GET without touching the ETag cache.
   *
   * For paths whose key contains a commit SHA or a run id. Those are unbounded
   * over the life of a repository, so caching them would grow the map (and hold
   * every response body) forever, unlike the stable `/repos/:x` paths the cache
   * exists for. These callers also want current state by definition: nobody
   * re-runs CI for the same commit twice expecting the first answer.
   */
  private async getUncached<T>(path: string): Promise<T> {
    const res = await fetch(`${this.api}${path}`, { headers: this.headers() });
    if (!res.ok) throw await this.error(res, path);
    return (await res.json()) as T;
  }

  async post<T>(path: string, payload: unknown): Promise<T> {
    return this.send<T>('POST', path, payload);
  }

  async patch<T>(path: string, payload: unknown): Promise<T> {
    return this.send<T>('PATCH', path, payload);
  }

  async viewer(): Promise<{ login: string }> {
    return this.get<{ login: string }>('/user');
  }

  /** A public account profile. Used for contributor provenance (account age, footprint). */
  async user(login: string): Promise<GhUser> {
    return this.get<GhUser>(`/users/${encodeURIComponent(login)}`);
  }

  /** Repositories the token can see (owner/collaborator/org), newest push first, paged. */
  async viewerRepos(maxPages = 3): Promise<GhRepoSummary[]> {
    const collected: GhRepoSummary[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhRepoSummary[]>(`/user/repos?per_page=100&sort=pushed&direction=desc&page=${page}`);
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  }

  async repo(fullName: string): Promise<{
    full_name: string;
    default_branch: string;
    private: boolean;
    owner: { login: string };
    name: string;
    /** What THIS token may do here — absent only on unauthenticated reads. */
    permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
  }> {
    return this.get(`/repos/${fullName}`);
  }

  /** Existing remote branches, paged and bounded to protect the GitHub budget. */
  async branches(fullName: string, maxPages = 20): Promise<GhBranch[]> {
    const cached = this.branchCache.get(fullName);
    if (cached && Date.now() - cached.at < 60_000) return cached.branches;
    const pending = this.branchInflight.get(fullName);
    if (pending) return pending;
    const load = (async (): Promise<GhBranch[]> => {
      const collected: GhBranch[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const batch = await this.get<GhBranch[]>(`/repos/${fullName}/branches?per_page=100&page=${page}`);
        collected.push(...batch);
        if (batch.length < 100) break;
      }
      this.branchCache.set(fullName, { at: Date.now(), branches: collected });
      return collected;
    })();
    this.branchInflight.set(fullName, load);
    try {
      return await load;
    } finally {
      this.branchInflight.delete(fullName);
    }
  }

  /** All issues (open+closed, no PRs) sorted by updated, paged. */
  async issues(
    fullName: string,
    opts: { since?: string; maxPages?: number } = {},
  ): Promise<GhIssue[]> {
    const collected: GhIssue[] = [];
    const maxPages = opts.maxPages ?? 10;
    for (let page = 1; page <= maxPages; page++) {
      const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : '';
      const batch = await this.get<GhIssue[]>(
        `/repos/${fullName}/issues?state=all&per_page=100&sort=updated&direction=desc&page=${page}${since}`,
      );
      // The issues endpoint interleaves PRs (they carry `pull_request`) —
      // keep them: the sync harvests PR comment counts from these rows.
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  }

  async pulls(fullName: string, maxPages = 5): Promise<GhPull[]> {
    const collected: GhPull[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhPull[]>(
        `/repos/${fullName}/pulls?state=all&per_page=100&sort=updated&direction=desc&page=${page}`,
      );
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  }

  /** One PR's current state — used to refresh the cache right after an action. */
  async pull(fullName: string, number: number): Promise<GhPull> {
    return this.get<GhPull>(`/repos/${fullName}/pulls/${number}`);
  }

  /** One issue's current state — used to refresh the cache right after an action. */
  async issue(fullName: string, number: number): Promise<GhIssue> {
    return this.get<GhIssue>(`/repos/${fullName}/issues/${number}`);
  }

  async issueComments(fullName: string, issueNumber: number): Promise<Array<{ user: { login: string } | null; body: string; created_at: string }>> {
    return this.get(`/repos/${fullName}/issues/${issueNumber}/comments?per_page=50`);
  }

  async prReviewList(fullName: string, prNumber: number): Promise<GhReview[]> {
    return this.get(`/repos/${fullName}/pulls/${prNumber}/reviews?per_page=100`);
  }

  /** Inline (file/line-anchored) review comments on a PR. */
  async prReviewComments(fullName: string, prNumber: number): Promise<GhReviewComment[]> {
    return this.get(`/repos/${fullName}/pulls/${prNumber}/comments?per_page=100`);
  }

  async addLabels(fullName: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.post(`/repos/${fullName}/issues/${issueNumber}/labels`, { labels });
  }

  /** Close/reopen an issue (works for PR numbers too via the issues API). */
  async updateIssueState(fullName: string, issueNumber: number, state: 'open' | 'closed'): Promise<void> {
    await this.patch(`/repos/${fullName}/issues/${issueNumber}`, { state });
  }

  async comment(fullName: string, issueNumber: number, body: string): Promise<{ html_url: string }> {
    return this.post(`/repos/${fullName}/issues/${issueNumber}/comments`, { body });
  }

  async createPr(
    fullName: string,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<{ html_url: string; number: number }> {
    return this.post(`/repos/${fullName}/pulls`, args);
  }

  /** Check runs for a commit (GitHub Actions + apps). */
  async checkRuns(fullName: string, ref: string): Promise<GhCheckRun[]> {
    const body = await this.get<{ check_runs: GhCheckRun[] }>(
      `/repos/${fullName}/commits/${ref}/check-runs?per_page=100`,
    );
    return body.check_runs ?? [];
  }

  /** Legacy combined commit status (CircleCI et al. still use it). */
  async combinedStatus(fullName: string, ref: string): Promise<GhCombinedStatus> {
    return this.get<GhCombinedStatus>(`/repos/${fullName}/commits/${ref}/status`);
  }

  /**
   * Changed files via the paginated files API — resilient to large PRs that the
   * single-payload `.diff` endpoint rejects (406). Pages are capped to bound the
   * response; `truncated` flags a PR that exceeds the cap.
   */
  async prFiles(fullName: string, number: number, maxPages = 15): Promise<{ files: GhPrFile[]; truncated: boolean }> {
    const files: GhPrFile[] = [];
    let full = false;
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`${this.api}/repos/${fullName}/pulls/${number}/files?per_page=100&page=${page}`, {
        headers: this.headers(),
      });
      if (!res.ok) throw await this.error(res, `/repos/${fullName}/pulls/${number}/files`);
      const batch = (await res.json()) as GhPrFile[];
      files.push(...batch);
      full = batch.length === 100;
      if (!full) break;
    }
    return { files, truncated: full };
  }

  /**
   * A PR's commits, oldest first, bounded like prFiles. Commit messages and
   * authorship are the only place attribution trailers and authoring cadence
   * are visible, so provenance judgements read from here rather than guessing
   * from the description.
   */
  async prCommits(fullName: string, number: number, maxPages = 3): Promise<{ commits: GhPrCommit[]; truncated: boolean }> {
    const commits: GhPrCommit[] = [];
    let full = false;
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhPrCommit[]>(`/repos/${fullName}/pulls/${number}/commits?per_page=100&page=${page}`);
      commits.push(...batch);
      full = batch.length === 100;
      if (!full) break;
    }
    return { commits, truncated: full };
  }

  /** Post a PR review (COMMENT / APPROVE / REQUEST_CHANGES). */
  async createPrReview(
    fullName: string,
    number: number,
    args: { body: string; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' },
  ): Promise<{ html_url: string }> {
    return this.post(`/repos/${fullName}/pulls/${number}/reviews`, args);
  }

  /**
   * Branch protection, as three answers a merge gate needs: does `behind`
   * actually block (`strict`), does an admin bypass exist at all
   * (`enforceAdmins`), and which contexts must pass BY NAME.
   *
   * Counting green checks is not enough: a required context missing from the
   * list entirely would sail past a count. Returns null when protection is
   * unreadable (no admin rights, or none configured), which callers must treat
   * as "unknown", never as "unprotected".
   */
  async branchProtection(
    fullName: string,
    branch: string,
  ): Promise<{ strict: boolean; enforceAdmins: boolean; requiredContexts: string[] } | null> {
    try {
      const res = await this.get<{
        required_status_checks?: { strict?: boolean; contexts?: string[] } | null;
        enforce_admins?: { enabled?: boolean } | null;
      }>(`/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`);
      return {
        strict: res.required_status_checks?.strict === true,
        enforceAdmins: res.enforce_admins?.enabled === true,
        requiredContexts: res.required_status_checks?.contexts ?? [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Re-run CI for a commit.
   *
   * Goes through workflow RUNS rather than check runs on purpose: `rerequest` on
   * a single check-run is refused for anything GitHub Actions produced, and the
   * daily case is "the lint lane flaked, run the failures again", which is one
   * call per workflow run. `scope: 'all'` re-runs green lanes too, which costs
   * minutes and is only worth it when the failure is suspected to be shared.
   *
   * Returns how many runs were asked to restart, so a caller can tell "nothing
   * to re-run" from "asked three".
   */
  async rerunChecks(fullName: string, headSha: string, scope: 'failed' | 'all'): Promise<number> {
    this.assertWrite(`POST /repos/${fullName}/actions/runs/:id/rerun`);
    const { workflow_runs: runs } = await this.getUncached<{ workflow_runs: GhWorkflowRun[] }>(
      `/repos/${fullName}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`,
    );
    const targets =
      scope === 'all' ? runs : runs.filter((r) => r.status === 'completed' && r.conclusion !== 'success');
    let restarted = 0;
    for (const run of targets) {
      const path = `/repos/${fullName}/actions/runs/${run.id}/${scope === 'all' ? 'rerun' : 'rerun-failed-jobs'}`;
      const res = await fetch(`${this.api}${path}`, { method: 'POST', headers: this.headers() });
      // 403 here usually means "this run is too old to re-run", which is not an
      // error worth failing the whole request over when others succeeded.
      if (res.ok) restarted++;
      else if (res.status !== 403) throw await this.error(res, path);
    }
    return restarted;
  }

  /**
   * The failing jobs at a commit, with the tail of each one's log.
   *
   * The TAIL, because a failure says what went wrong at the end, after however
   * many thousand lines of progress output. Best-effort per job: a log that has
   * expired or is still being written is skipped rather than failing the lot.
   */
  async failingJobLogs(
    fullName: string,
    headSha: string,
    opts: { maxJobs?: number; maxChars?: number } = {},
  ): Promise<Array<{ name: string; log: string }>> {
    const maxJobs = opts.maxJobs ?? 4;
    const maxChars = opts.maxChars ?? 15_000;
    const { workflow_runs: runs } = await this.getUncached<{ workflow_runs: GhWorkflowRun[] }>(
      `/repos/${fullName}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`,
    );
    const out: Array<{ name: string; log: string }> = [];
    for (const run of runs.filter((r) => r.status === 'completed' && r.conclusion !== 'success')) {
      if (out.length >= maxJobs) break;
      const { jobs } = await this.getUncached<{ jobs: Array<{ id: number; name: string; conclusion: string | null }> }>(
        `/repos/${fullName}/actions/runs/${run.id}/jobs?per_page=100`,
      );
      for (const job of jobs.filter((j) => j.conclusion === 'failure')) {
        if (out.length >= maxJobs) break;
        const log = await this.jobLog(fullName, job.id, maxChars).catch(() => null);
        if (log) out.push({ name: job.name, log });
      }
    }
    return out;
  }

  private async jobLog(fullName: string, jobId: number, maxChars: number): Promise<string | null> {
    const path = `/repos/${fullName}/actions/jobs/${jobId}/logs`;
    const res = await fetch(`${this.api}${path}`, { headers: this.headers(), redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      // GitHub redirects to a signed blob URL where the signature IS the
      // authorization. Following it with our token attached would both leak the
      // credential to a storage host and be rejected by it, so this second
      // request deliberately carries no headers.
      const blob = await fetch(location);
      return blob.ok ? await readTail(blob, maxChars) : null;
    }
    return res.ok ? await readTail(res, maxChars) : null;
  }

  /**
   * Where GraphQL lives for this host.
   *
   * NOT `${api}/graphql`. On github.com the REST base is `https://api.github.com`
   * and GraphQL is a sibling path, but a GitHub Enterprise Server base is
   * `https://ghe.corp/api/v3` while its GraphQL endpoint is `https://ghe.corp/api/graphql`
   * — one level up, not below. Appending blindly produces a 404 that looks like
   * a permissions problem.
   */
  private graphqlUrl(): string {
    return `${this.api.replace(/\/v3$/, '')}/graphql`;
  }

  /** Take a pull request out of draft. */
  async markReadyForReview(fullName: string, number: number): Promise<void> {
    this.assertWrite(`PATCH /repos/${fullName}/pulls/${number} (ready)`);
    // Draft state is GraphQL-only on the REST v3 PATCH, so this is the one
    // mutation here that has to go through the GraphQL endpoint.
    const pr = await this.pull(fullName, number);
    const res = await fetch(this.graphqlUrl(), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}',
        variables: { id: (pr as unknown as { node_id: string }).node_id },
      }),
    });
    if (!res.ok) throw await this.error(res, '/graphql markPullRequestReadyForReview');
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  }

  /** Merge the base branch into the PR's head, the fix for a `behind` branch. */
  async updateBranch(fullName: string, number: number): Promise<void> {
    this.assertWrite(`PUT /repos/${fullName}/pulls/${number}/update-branch`);
    const path = `/repos/${fullName}/pulls/${number}/update-branch`;
    const res = await fetch(`${this.api}${path}`, { method: 'PUT', headers: this.headers() });
    if (!res.ok) throw await this.error(res, path);
  }

  async mergePr(
    fullName: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<{ merged: boolean; message: string }> {
    const res = await fetch(`${this.api}/repos/${fullName}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ merge_method: method }),
    });
    if (!res.ok) throw await this.error(res, `/repos/${fullName}/pulls/${number}/merge`);
    return (await res.json()) as { merged: boolean; message: string };
  }

  async closePr(fullName: string, number: number): Promise<void> {
    await this.patch(`/repos/${fullName}/pulls/${number}`, { state: 'closed' });
  }

  /**
   * Best-effort head-branch cleanup after a merge. Same-repo heads only — a
   * fork's ref is not ours to delete, and a same-named base-repo branch must
   * not be collateral. Returns false when skipped (fork / unknown head repo).
   */
  async deleteMergedPrBranch(fullName: string, number: number): Promise<boolean> {
    // Before the lookup, not after: a refused delete should not spend a GitHub
    // request to find out it was going to be refused.
    this.assertWrite(`DELETE /repos/${fullName}/git/refs/heads`);
    const pr = await this.pull(fullName, number);
    if (pr.head.repo?.full_name !== fullName) return false;
    const res = await fetch(`${this.api}/repos/${fullName}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    // 422 = ref already gone (raced GitHub's own auto-delete) — that's success.
    if (!res.ok && res.status !== 422) throw await this.error(res, `/repos/${fullName}/git/refs/heads/${pr.head.ref}`);
    return true;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'companion-daemon',
    };
  }

  private async send<T>(method: string, path: string, payload: unknown): Promise<T> {
    // Every POST and PATCH funnels through here, which is what makes this the
    // choke point: a method added later is gated without touching the gate.
    this.assertWrite(`${method} ${path}`);
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await this.error(res, path);
    return (await res.json()) as T;
  }

  private async error(res: Response, path: string): Promise<GitHubError> {
    const body = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string } | string> };
      if (parsed.message) message = parsed.message;
      // 422s carry the actual reason in errors[] ("Can not request changes on
      // your own pull request", ...) — without it the failure is undebuggable.
      const details = (parsed.errors ?? [])
        .map((e) => (typeof e === 'string' ? e : e.message))
        .filter((m): m is string => Boolean(m));
      if (details.length > 0) message += ` — ${details.join('; ')}`;
    } catch {
      // keep the status line
    }
    return new GitHubError(`GitHub ${path}: ${message}`, res.status, rateLimited(res));
  }
}

/** Primary budget spent: the remaining count is 0. Secondary: GitHub sends `retry-after`. */
function rateLimited(res: Response): boolean {
  return res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
}

export interface GhRepoSummary {
  full_name: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  archived: boolean;
}

export interface GhBranch {
  name: string;
  protected: boolean;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name?: string } | string>;
  user: { login: string } | null;
  assignees: Array<{ login: string }> | null;
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  closed_at: string | null;
  draft?: boolean;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login: string }> | null;
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { ref: string };
  /** Only on the single-PR GET and webhook payloads (never the list); null = still computing. */
  mergeable?: boolean | null;
  /**
   * REST's name for what the GraphQL API calls `mergeStateStatus`: clean /
   * dirty / blocked / behind / unstable / draft / has_hooks / unknown. Only
   * `mergeable` cannot distinguish "conflicts" from "a required check is
   * missing" from "the branch is behind", which are three different actions.
   */
  mergeable_state?: string;
  user: { login: string } | null;
  /**
   * The author's standing in THIS repository, as GitHub computes it:
   * OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR /
   * FIRST_TIMER / MANNEQUIN / NONE. Absent on some webhook payload shapes.
   */
  author_association?: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

/** A public account profile (`GET /users/:login`). */
/**
 * Read only the last `maxChars` of a response body.
 *
 * `await res.text()` would materialise the whole thing first, and a CI job log
 * runs to tens of megabytes; four of those at once is a real spike for a value
 * we then throw almost all of away. Streaming keeps at most the tail plus one
 * chunk resident.
 */
async function readTail(res: Response, maxChars: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(-maxChars);
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let tail = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += decoder.decode(value, { stream: true });
      // Trim on a hysteresis rather than every chunk: slicing a string is a
      // copy, and doing it per chunk would cost more than the memory it saves.
      if (tail.length > maxChars * 2) tail = tail.slice(-maxChars);
    }
    tail += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return tail.slice(-maxChars);
}

export interface GhUser {
  login: string;
  /** 'User' | 'Organization' | 'Bot'. */
  type: string;
  name: string | null;
  created_at: string;
  public_repos: number;
  followers: number;
}

/** One commit on a pull request (`GET /pulls/:n/commits`). */
export interface GhPrCommit {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
    committer: { name?: string; email?: string; date?: string } | null;
  };
  /** The linked GitHub account; null when the commit email matches no account. */
  author: { login: string } | null;
  committer: { login: string } | null;
}

export interface GhReview {
  user: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body?: string | null;
  submitted_at: string | null;
}

export interface GhReviewComment {
  user: { login: string } | null;
  body: string;
  path: string;
  /** Line in the current diff; original_line survives force-pushes. */
  line: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  created_at: string;
}

export interface GhPrFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
}

/** One GitHub Actions workflow run for a commit. The unit `rerun` acts on. */
export interface GhWorkflowRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
}

export interface GhCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface GhCombinedStatus {
  state: 'success' | 'failure' | 'pending' | 'error';
  statuses: Array<{
    context: string;
    state: 'success' | 'failure' | 'pending' | 'error';
    target_url: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

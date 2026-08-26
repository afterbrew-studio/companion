/**
 * Minimal GitHub REST client on global fetch — no octokit dependency tree.
 * ETag-aware GETs keep polling cheap against the 5k/hr PAT budget.
 */

export class GitHubError extends Error {
  /**
   * What the CLIENT should be told. GitHub failing is not this daemon failing,
   * and answering 500 makes an upstream hiccup read as our own crash, which
   * sends whoever sees it looking in the wrong place.
   *
   * A spent budget or an upstream outage is worth retrying shortly; anything
   * else is a real answer about this request and travels as it came.
   */
  get clientStatus(): number {
    if (this.rateLimited) return 429;
    // A rejected GitHub credential is not an expired Companion session. The
    // SPA treats every 401 as a signal to clear its local login, so forwarding
    // this status would sign the maintainer out because an upstream token was
    // revoked. Surface it as an integration failure instead.
    if (this.status === 401) return 502;
    return this.status >= 500 || this.status === 0 ? 502 : this.status;
  }

  /** Seconds to wait before it is worth asking again; null when it is not. */
  get retryAfter(): number | null {
    if (this.rateLimited) return 60;
    return this.clientStatus === 502 ? 10 : null;
  }

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

/** Last primary-rate-limit observation for this credential. No token or URL is exposed. */
export interface GitHubRateLimitSnapshot {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: number | null;
  readonly resource: string | null;
  readonly observedAt: number;
}

/** One entry from GitHub's recursive git-tree endpoint. */
export interface GhTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
  readonly size?: number;
}

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
  private readonly rateLimits = new Map<string, GitHubRateLimitSnapshot>();

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
    this.observeRateLimit(res);
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
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, path);
    return (await res.json()) as T;
  }

  /** Operational telemetry only; callers cannot recover credential material from it. */
  rateLimitSnapshot(): GitHubRateLimitSnapshot | null {
    const snapshots = [...this.rateLimits.values()];
    if (snapshots.length === 0) return null;
    // Report the most constrained resource, not whichever concurrent request
    // happened to finish last (REST core and GraphQL have separate budgets).
    snapshots.sort((a, b) => rateLimitPressure(b) - rateLimitPressure(a));
    return { ...snapshots[0]! };
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
    allow_merge_commit?: boolean;
    allow_squash_merge?: boolean;
    allow_rebase_merge?: boolean;
    allow_auto_merge?: boolean;
  }> {
    return this.get(`/repos/${fullName}`);
  }

  /**
   * One bounded request inventories repository-owned agent guidance. The ref is
   * supplied by Companion (normally the connected repo's default/base branch),
   * never accepted from an untrusted pull-request head.
   */
  async repoTree(fullName: string, ref: string): Promise<{ tree: readonly GhTreeEntry[]; truncated: boolean }> {
    const body = await this.get<{ tree?: GhTreeEntry[]; truncated?: boolean }>(
      `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    return { tree: body.tree ?? [], truncated: body.truncated === true };
  }

  /** Read a text blob selected from repoTree without a second path/ref lookup. */
  async repoTextBlob(fullName: string, sha: string): Promise<string> {
    const blob = await this.get<{ content?: string; encoding?: string }>(
      `/repos/${fullName}/git/blobs/${encodeURIComponent(sha)}`,
    );
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new Error(`GitHub returned a non-text blob for ${fullName}@${sha.slice(0, 12)}`);
    }
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
  }

  /**
   * Read a bounded set of repository text files in one GraphQL round trip.
   * The aliases are generated locally while every ref/path remains a variable,
   * so filenames can never alter the query document.
   */
  async repoTextFiles(fullName: string, ref: string, paths: readonly string[]): Promise<Map<string, string>> {
    if (paths.length > 48) throw new Error('repository context file batch exceeds 48');
    const separator = fullName.indexOf('/');
    if (separator <= 0 || separator === fullName.length - 1) throw new Error(`invalid repository ${fullName}`);
    if (paths.length === 0) return new Map();
    const owner = fullName.slice(0, separator);
    const name = fullName.slice(separator + 1);
    const declarations = paths.map((_, index) => `$expression${index}: String!`).join(', ');
    const fields = paths
      .map(
        (_, index) =>
          `f${index}: object(expression: $expression${index}) { ... on Blob { text isBinary byteSize } }`,
      )
      .join('\n');
    const variables: Record<string, unknown> = { owner, name };
    paths.forEach((path, index) => {
      variables[`expression${index}`] = `${ref}:${path}`;
    });
    const data = await this.graphql<{
      repository: Record<string, { text: string | null; isBinary: boolean; byteSize: number } | null> | null;
    }>(
      `query CompanionRepositoryAgentContext($owner: String!, $name: String!, ${declarations}) {
        repository(owner: $owner, name: $name) {
          ${fields}
        }
      }`,
      variables,
    );
    const result = new Map<string, string>();
    paths.forEach((path, index) => {
      const blob = data.repository?.[`f${index}`];
      if (blob && !blob.isBinary && typeof blob.text === 'string') result.set(path, blob.text);
    });
    return result;
  }

  /**
   * Body-free, read-only workload snapshot for autonomy planning. GitHub's REST
   * pull list omits changed-line/file counts, and fetching one detail endpoint
   * per PR costs O(queue) requests. GraphQL returns the reviewability signals,
   * aggregate CI state and exact total counts in bounded pages instead.
   *
   * The query text is constant and contains no mutation field. `pullLimit` is
   * deliberately lower than `issueLimit`: every PR row is rendered/explained,
   * while issue rows contribute only intake counts.
   */
  async repositoryAutonomyQueue(
    fullName: string,
    opts: { pullLimit?: number; issueLimit?: number } = {},
  ): Promise<GhRepositoryAutonomyQueue> {
    const separator = fullName.indexOf('/');
    if (separator <= 0 || separator === fullName.length - 1) throw new Error(`invalid repository ${fullName}`);
    const owner = fullName.slice(0, separator);
    const name = fullName.slice(separator + 1);
    const pullLimit = Math.min(Math.max(Math.trunc(opts.pullLimit ?? 100), 1), 1_000);
    const issueLimit = Math.min(Math.max(Math.trunc(opts.issueLimit ?? 1_000), 1), 1_000);
    const [pullResult, issueResult] = await Promise.all([
      this.autonomyPulls(owner, name, pullLimit),
      this.autonomyIssues(owner, name, issueLimit),
    ]);
    return {
      pulls: pullResult.rows,
      openPullCount: pullResult.total,
      pullsComplete: pullResult.rows.length >= pullResult.total,
      issues: issueResult.rows,
      openIssueCount: issueResult.total,
      issuesComplete: issueResult.rows.length >= issueResult.total,
    };
  }

  private async autonomyPulls(
    owner: string,
    name: string,
    limit: number,
  ): Promise<{ rows: GhPull[]; total: number }> {
    const rows: GhPull[] = [];
    let total = 0;
    let cursor: string | null = null;
    while (rows.length < limit) {
      const page: GhAutonomyPullQuery = await this.graphql<GhAutonomyPullQuery>(AUTONOMY_PULL_QUERY, {
        owner,
        name,
        cursor,
        first: Math.min(100, limit - rows.length),
      });
      if (!page.repository) throw new Error(`GitHub repository ${owner}/${name} is unavailable`);
      const connection: GhAutonomyPullConnection = page.repository.pullRequests;
      total = connection.totalCount;
      rows.push(...connection.nodes.filter((node): node is GhAutonomyPullNode => node !== null).map(mapAutonomyPull));
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
      cursor = connection.pageInfo.endCursor;
    }
    return { rows, total };
  }

  private async autonomyIssues(
    owner: string,
    name: string,
    limit: number,
  ): Promise<{ rows: GhIssue[]; total: number }> {
    const rows: GhIssue[] = [];
    let total = 0;
    let cursor: string | null = null;
    while (rows.length < limit) {
      const page: GhAutonomyIssueQuery = await this.graphql<GhAutonomyIssueQuery>(AUTONOMY_ISSUE_QUERY, {
        owner,
        name,
        cursor,
        first: Math.min(100, limit - rows.length),
      });
      if (!page.repository) throw new Error(`GitHub repository ${owner}/${name} is unavailable`);
      const connection: GhAutonomyIssueConnection = page.repository.issues;
      total = connection.totalCount;
      rows.push(...connection.nodes.filter((node): node is GhAutonomyIssueNode => node !== null).map(mapAutonomyIssue));
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
      cursor = connection.pageInfo.endCursor;
    }
    return { rows, total };
  }

  /**
   * Install or reconcile Companion's repository webhook without creating a
   * duplicate after a timeout/crash. GitHub never returns a hook's secret, so
   * matching by the stable delivery URL and PATCHing rotates it back to the
   * local receiver's current secret.
   */
  async ensureRepoWebhook(
    fullName: string,
    url: string,
    secret: string,
    knownId: number | null = null,
  ): Promise<number> {
    const payload = {
      name: 'web',
      active: true,
      events: ['issues', 'pull_request', 'pull_request_review_comment', 'check_run', 'check_suite', 'status'],
      config: { url, content_type: 'json', insecure_ssl: '0', secret },
    };
    if (knownId !== null) {
      try {
        const known = await this.patch<GhRepoHook>(`/repos/${fullName}/hooks/${knownId}`, payload);
        if (!Number.isSafeInteger(known.id) || known.id <= 0) {
          throw new Error('GitHub returned an invalid repository webhook id');
        }
        return known.id;
      } catch (err) {
        // A maintainer may have deleted the remembered hook in GitHub. Only a
        // confirmed 404 falls back to discovery/creation; auth and rate-limit
        // failures must stay visible instead of creating a likely duplicate.
        if (!(err instanceof GitHubError) || err.status !== 404) throw err;
      }
    }

    let existing: GhRepoHook | undefined;
    for (let page = 1; page <= 10 && !existing; page++) {
      const hooks = await this.getUncached<GhRepoHook[]>(
        `/repos/${fullName}/hooks?per_page=100&page=${page}`,
      );
      existing = hooks.find((hook) => hook.name === 'web' && hook.config.url === url);
      if (hooks.length < 100) break;
    }
    const hook = existing
      ? await this.patch<GhRepoHook>(`/repos/${fullName}/hooks/${existing.id}`, payload)
      : await this.post<GhRepoHook>(`/repos/${fullName}/hooks`, payload);
    if (!Number.isSafeInteger(hook.id) || hook.id <= 0) {
      throw new Error('GitHub returned an invalid repository webhook id');
    }
    return hook.id;
  }

  /** Delete is idempotent: a hook removed in GitHub's UI is already off. */
  async deleteRepoWebhook(fullName: string, id: number): Promise<void> {
    this.assertWrite(`DELETE /repos/${fullName}/hooks/${id}`);
    const path = `/repos/${fullName}/hooks/${id}`;
    const res = await fetch(`${this.api}${path}`, { method: 'DELETE', headers: this.headers() });
    this.observeRateLimit(res);
    if (!res.ok && res.status !== 404) throw await this.error(res, path);
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
    opts: { since?: string; maxPages?: number; state?: 'open' | 'closed' | 'all' } = {},
  ): Promise<GhIssue[]> {
    const collected: GhIssue[] = [];
    const maxPages = opts.maxPages ?? 10;
    for (let page = 1; page <= maxPages; page++) {
      const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : '';
      const batch = await this.get<GhIssue[]>(
        `/repos/${fullName}/issues?state=${opts.state ?? 'all'}&per_page=100&sort=updated&direction=desc&page=${page}${since}`,
      );
      // The issues endpoint interleaves PRs (they carry `pull_request`) —
      // keep them: the sync harvests PR comment counts from these rows.
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  }

  async pulls(
    fullName: string,
    maxPages = 5,
    state: 'open' | 'closed' | 'all' = 'all',
  ): Promise<GhPull[]> {
    const collected: GhPull[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhPull[]>(
        `/repos/${fullName}/pulls?state=${state}&per_page=100&sort=updated&direction=desc&page=${page}`,
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

  /**
   * What this account may do on the repository: `admin`, `write`, `triage`,
   * `read` or `none`.
   *
   * Asked of GitHub rather than inferred from anything cached, because the whole
   * point of asking is that the answer may have changed since the event - a
   * collaborator removed between applying a label and the delivery being
   * processed still appears as the label's author forever.
   */
  async collaboratorPermission(fullName: string, username: string): Promise<string> {
    const answer = await this.get<{ permission?: unknown }>(
      `/repos/${fullName}/collaborators/${encodeURIComponent(username)}/permission`,
    );
    return typeof answer.permission === 'string' ? answer.permission : 'none';
  }

  async issueComments(fullName: string, issueNumber: number): Promise<GhIssueComment[]> {
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

  async removeLabel(fullName: string, issueNumber: number, label: string): Promise<void> {
    await this.destroy(`/repos/${fullName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
  }

  async addAssignees(fullName: string, issueNumber: number, assignees: string[]): Promise<void> {
    await this.post(`/repos/${fullName}/issues/${issueNumber}/assignees`, { assignees });
  }

  async removeAssignees(fullName: string, issueNumber: number, assignees: string[]): Promise<void> {
    await this.destroy(`/repos/${fullName}/issues/${issueNumber}/assignees`, { assignees });
  }

  async requestReviewers(fullName: string, prNumber: number, reviewers: string[]): Promise<void> {
    await this.post(`/repos/${fullName}/pulls/${prNumber}/requested_reviewers`, { reviewers });
  }

  async removeReviewers(fullName: string, prNumber: number, reviewers: string[]): Promise<void> {
    await this.destroy(`/repos/${fullName}/pulls/${prNumber}/requested_reviewers`, { reviewers });
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
    args: { title: string; head: string; base: string; body: string; draft?: boolean },
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
    let hasNextPage = false;
    for (let page = 1; page <= maxPages; page++) {
      const result = await this.prFilesPage(fullName, number, page, 100);
      files.push(...result.files);
      hasNextPage = result.hasNextPage;
      if (!hasNextPage) break;
    }
    return { files, truncated: hasNextPage };
  }

  /**
   * One bounded changed-file page for the human diff browser. Review planning
   * deliberately uses {@link prFiles} instead: paging the UI must never make an
   * automated review mistake a visible page for complete coverage.
   */
  async prFilesPage(
    fullName: string,
    number: number,
    page: number,
    pageSize = 50,
  ): Promise<{ files: GhPrFile[]; page: number; pageSize: number; hasNextPage: boolean }> {
    if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('PR files page must be a positive integer');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RangeError('PR files page size must be between 1 and 100');
    }
    const path = `/repos/${fullName}/pulls/${number}/files`;
    const res = await fetch(`${this.api}${path}?per_page=${pageSize}&page=${page}`, { headers: this.headers() });
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, path);
    const files = (await res.json()) as GhPrFile[];
    const link = res.headers.get('link');
    // GitHub and current GHES return RFC 8288 links. The length fallback keeps
    // older installations navigable; at worst an exact-full last page exposes
    // one empty next page instead of silently hiding real changes.
    const hasNextPage = link === null ? files.length === pageSize : linkHasRelation(link, 'next');
    return { files, page, pageSize, hasNextPage };
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

  /**
   * Post a PR review (COMMENT / APPROVE / REQUEST_CHANGES), optionally with
   * inline comments anchored to lines of the diff.
   *
   * The comments travel WITH the review rather than as separate calls: that is
   * what makes them one review, one notification, and one set of threads the
   * author can resolve. It also makes the call all-or-nothing — GitHub rejects
   * the entire request if any single comment names a line outside the diff —
   * so callers must validate anchors before getting here.
   */
  async createPrReview(
    fullName: string,
    number: number,
    args: {
      body: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      /** Head the review was computed against; pins the comments to it. */
      commitId?: string;
      comments?: ReadonlyArray<GhReviewCommentInput>;
    },
  ): Promise<{ id: number; html_url: string }> {
    const { commitId, comments, ...rest } = args;
    return this.post(`/repos/${fullName}/pulls/${number}/reviews`, {
      ...rest,
      ...(commitId ? { commit_id: commitId } : {}),
      ...(comments && comments.length > 0 ? { comments } : {}),
    });
  }

  /**
   * The comments one review created, so the ids can be mapped back onto the
   * findings that produced them. The create response does not carry them.
   */
  async prReviewCommentsFor(fullName: string, prNumber: number, reviewId: number): Promise<GhReviewComment[]> {
    return this.get(`/repos/${fullName}/pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100`);
  }

  /**
   * Answer inside an existing inline thread. Posting a fresh comment on the
   * same line would open a second thread beside the one being answered, which
   * is not a reply to anybody.
   */
  async replyToReviewComment(
    fullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number; html_url: string }> {
    return this.post(`/repos/${fullName}/pulls/${prNumber}/comments/${commentId}/replies`, { body });
  }

  /** Post one reviewed comment, optionally carrying a GitHub suggestion, on an exact diff range. */
  async createReviewComment(
    fullName: string,
    prNumber: number,
    comment: GhReviewCommentInput & { readonly commit_id: string },
  ): Promise<{ id: number; html_url: string }> {
    return this.post(`/repos/${fullName}/pulls/${prNumber}/comments`, comment);
  }

  /** Fresh review threads include GraphQL ids, which the resolve mutation requires. */
  async prReviewThreads(
    fullName: string,
    prNumber: number,
    maxPages = 10,
  ): Promise<{ threads: GhReviewThread[]; truncated: boolean }> {
    const [owner, name, extra] = fullName.split('/');
    if (!owner || !name || extra) throw new Error(`invalid repository ${fullName}`);
    const threads: GhReviewThread[] = [];
    let cursor: string | null = null;
    let hasNextPage = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const data: GhReviewThreadsQuery = await this.graphql<GhReviewThreadsQuery>(REVIEW_THREADS_QUERY, {
        owner,
        name,
        number: prNumber,
        cursor,
      });
      if (!data.repository?.pullRequest) throw new Error(`GitHub pull request ${fullName}#${prNumber} is unavailable`);
      const connection: GhReviewThreadConnection = data.repository.pullRequest.reviewThreads;
      threads.push(...connection.nodes.filter((thread): thread is GhReviewThread => thread !== null));
      hasNextPage = connection.pageInfo.hasNextPage;
      if (!hasNextPage || !connection.pageInfo.endCursor) break;
      cursor = connection.pageInfo.endCursor;
    }
    return { threads, truncated: hasNextPage };
  }

  /** Resolve the whole inline conversation, matching GitHub's review-thread model. */
  async resolveReviewThread(threadId: string): Promise<void> {
    this.assertWrite('GraphQL resolveReviewThread');
    const res = await fetch(this.graphqlUrl(), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}',
        variables: { id: threadId },
      }),
    });
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, '/graphql resolveReviewThread');
    const body = (await res.json()) as {
      readonly data?: { readonly resolveReviewThread?: { readonly thread?: { readonly isResolved?: boolean } | null } | null };
      readonly errors?: ReadonlyArray<{ readonly message?: string }>;
    };
    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message ?? 'unknown GraphQL error').join('; '));
    }
    if (body.data?.resolveReviewThread?.thread?.isResolved !== true) {
      throw new Error('GitHub did not resolve the review thread');
    }
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
  ): Promise<{
    strict: boolean;
    enforceAdmins: boolean;
    requiredContexts: string[];
    requiredApprovingReviews: number;
    dismissStaleReviews: boolean;
    requireCodeOwnerReviews: boolean;
    requireConversationResolution: boolean;
    allowForcePushes: boolean;
  } | null> {
    try {
      const res = await this.get<{
        required_status_checks?: { strict?: boolean; contexts?: string[] } | null;
        enforce_admins?: { enabled?: boolean } | null;
        required_pull_request_reviews?: {
          required_approving_review_count?: number;
          dismiss_stale_reviews?: boolean;
          require_code_owner_reviews?: boolean;
        } | null;
        required_conversation_resolution?: { enabled?: boolean } | null;
        allow_force_pushes?: { enabled?: boolean } | null;
      }>(`/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`);
      return {
        strict: res.required_status_checks?.strict === true,
        enforceAdmins: res.enforce_admins?.enabled === true,
        requiredContexts: res.required_status_checks?.contexts ?? [],
        requiredApprovingReviews: res.required_pull_request_reviews?.required_approving_review_count ?? 0,
        dismissStaleReviews: res.required_pull_request_reviews?.dismiss_stale_reviews === true,
        requireCodeOwnerReviews: res.required_pull_request_reviews?.require_code_owner_reviews === true,
        requireConversationResolution: res.required_conversation_resolution?.enabled === true,
        allowForcePushes: res.allow_force_pushes?.enabled === true,
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
      this.observeRateLimit(res);
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
    this.observeRateLimit(res);
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

  /** Structurally server-authored read queries only; mutations keep their explicit write-gated methods. */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.graphqlUrl(), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, '/graphql');
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) {
      const message = body.errors.map((error) => error.message ?? 'unknown GraphQL error').join('; ');
      throw new Error(`GitHub GraphQL: ${message.slice(0, 1_000)}`);
    }
    if (!body.data) throw new Error('GitHub GraphQL returned no data');
    return body.data;
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
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, '/graphql markPullRequestReadyForReview');
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  }

  /** Merge the base branch into the PR's head, the fix for a `behind` branch. */
  async updateBranch(fullName: string, number: number): Promise<void> {
    this.assertWrite(`PUT /repos/${fullName}/pulls/${number}/update-branch`);
    const path = `/repos/${fullName}/pulls/${number}/update-branch`;
    const res = await fetch(`${this.api}${path}`, { method: 'PUT', headers: this.headers() });
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, path);
  }

  async mergePr(
    fullName: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
    expectedHeadSha?: string,
  ): Promise<{ merged: boolean; message: string }> {
    // Merge is the most consequential forge write. It uses PUT instead of the
    // shared POST/PATCH transport, so it must enter the same instance policy
    // choke point explicitly before any network I/O.
    this.assertWrite(`PUT /repos/${fullName}/pulls/${number}/merge`);
    const res = await fetch(`${this.api}/repos/${fullName}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      // GitHub rejects with 409/422 if the PR moved after the caller's gates.
      // Without `sha`, a race merges a commit nobody reviewed or tested.
      body: JSON.stringify({ merge_method: method, ...(expectedHeadSha ? { sha: expectedHeadSha } : {}) }),
    });
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, `/repos/${fullName}/pulls/${number}/merge`);
    return (await res.json()) as { merged: boolean; message: string };
  }

  async closePr(fullName: string, number: number): Promise<void> {
    await this.patch(`/repos/${fullName}/pulls/${number}`, { state: 'closed' });
  }

  async reopenPr(fullName: string, number: number): Promise<void> {
    await this.patch(`/repos/${fullName}/pulls/${number}`, { state: 'open' });
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
    this.observeRateLimit(res);
    // 422 = ref already gone (raced GitHub's own auto-delete) — that's success.
    if (!res.ok && res.status !== 422) throw await this.error(res, `/repos/${fullName}/git/refs/heads/${pr.head.ref}`);
    return true;
  }

  private observeRateLimit(res: Response): void {
    const limit = finiteHeader(res.headers.get('x-ratelimit-limit'));
    const remaining = finiteHeader(res.headers.get('x-ratelimit-remaining'));
    const resetSeconds = finiteHeader(res.headers.get('x-ratelimit-reset'));
    const resource = res.headers.get('x-ratelimit-resource');
    if (limit === null && remaining === null && resetSeconds === null && resource === null) return;
    const snapshot = {
      limit,
      remaining,
      resetAt: resetSeconds === null ? null : resetSeconds * 1_000,
      resource,
      observedAt: Date.now(),
    };
    this.rateLimits.set(resource ?? 'unknown', snapshot);
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
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, path);
    return (await res.json()) as T;
  }

  /** DELETE endpoints are split out because several accept a JSON body and commonly return 204. */
  private async destroy(path: string, payload?: unknown): Promise<void> {
    this.assertWrite(`DELETE ${path}`);
    const res = await fetch(`${this.api}${path}`, {
      method: 'DELETE',
      headers: payload === undefined ? this.headers() : { ...this.headers(), 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    this.observeRateLimit(res);
    if (!res.ok) throw await this.error(res, path);
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

const AUTONOMY_PULL_QUERY = `
  query CompanionAutonomyPulls($owner: String!, $name: String!, $cursor: String, $first: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          createdAt
          updatedAt
          isDraft
          additions
          deletions
          changedFiles
          mergeable
          mergeStateStatus
          headRefName
          headRefOid
          baseRefName
          reviewDecision
          author { login }
          labels(first: 100) { nodes { name } }
        }
      }
    }
  }
`;

const AUTONOMY_ISSUE_QUERY = `
  query CompanionAutonomyIssues($owner: String!, $name: String!, $cursor: String, $first: Int!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          createdAt
          updatedAt
          author { login }
          comments { totalCount }
          labels(first: 1) { totalCount }
          assignees(first: 1) { totalCount }
        }
      }
    }
  }
`;

interface GhPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GhAutonomyPullNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string } | null> };
}

interface GhAutonomyPullQuery {
  repository: {
    pullRequests: {
      totalCount: number;
      pageInfo: GhPageInfo;
      nodes: Array<GhAutonomyPullNode | null>;
    };
  } | null;
}

type GhAutonomyPullConnection = NonNullable<GhAutonomyPullQuery['repository']>['pullRequests'];

interface GhAutonomyIssueNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  comments: { totalCount: number };
  labels: { totalCount: number };
  assignees: { totalCount: number };
}

interface GhAutonomyIssueQuery {
  repository: {
    issues: {
      totalCount: number;
      pageInfo: GhPageInfo;
      nodes: Array<GhAutonomyIssueNode | null>;
    };
  } | null;
}

type GhAutonomyIssueConnection = NonNullable<GhAutonomyIssueQuery['repository']>['issues'];

function mapAutonomyPull(node: GhAutonomyPullNode): GhPull {
  return {
    number: node.number,
    title: node.title,
    body: null,
    state: 'open',
    merged_at: null,
    closed_at: null,
    draft: node.isDraft,
    labels: node.labels.nodes.filter((label): label is { name: string } => label !== null),
    assignees: [],
    head: { ref: node.headRefName, sha: node.headRefOid },
    base: { ref: node.baseRefName },
    mergeable: node.mergeable === 'MERGEABLE' ? true : node.mergeable === 'CONFLICTING' ? false : undefined,
    mergeable_state: node.mergeStateStatus.toLowerCase(),
    user: node.author,
    additions: node.additions,
    deletions: node.deletions,
    changed_files: node.changedFiles,
    review_decision: node.reviewDecision === 'APPROVED'
      ? 'approved'
      : node.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : null,
    html_url: node.url,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

function mapAutonomyIssue(node: GhAutonomyIssueNode): GhIssue {
  return {
    number: node.number,
    title: node.title,
    body: null,
    state: 'open',
    // The dry-run only needs labelled/unlabelled and assigned/unassigned
    // counts. A bounded sentinel avoids downloading names it never returns.
    labels: node.labels.totalCount > 0 ? ['__present__'] : [],
    user: node.author,
    assignees: node.assignees.totalCount > 0 ? [{ login: '__present__' }] : [],
    comments: node.comments.totalCount,
    html_url: node.url,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    closed_at: null,
  };
}

/** Primary budget spent: the remaining count is 0. Secondary: GitHub sends `retry-after`. */
function rateLimited(res: Response): boolean {
  return res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
}

function finiteHeader(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rateLimitPressure(snapshot: GitHubRateLimitSnapshot): number {
  if (snapshot.remaining === 0) return Number.POSITIVE_INFINITY;
  if (snapshot.remaining === null || snapshot.limit === null || snapshot.limit === 0) return 0;
  return 1 - snapshot.remaining / snapshot.limit;
}

/** Read one relation from GitHub's comma-separated RFC 8288 Link header. */
function linkHasRelation(header: string, relation: string): boolean {
  return header.split(',').some((part) =>
    part
      .split(';')
      .slice(1)
      .some((attribute) => attribute.trim() === `rel="${relation}"`),
  );
}

export interface GhRepoSummary {
  full_name: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  archived: boolean;
}

interface GhRepoHook {
  id: number;
  name: string;
  active: boolean;
  config: { url?: string };
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
  requested_reviewers?: Array<{ login: string }> | null;
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
  /** Aggregate size fields are present on the single-PR endpoint, not lists. */
  additions?: number;
  deletions?: number;
  changed_files?: number;
  /** Body-free autonomy GraphQL projection; absent on REST payloads. */
  review_decision?: 'approved' | 'changes_requested' | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

/** Exact queue totals plus bounded body-free rows for read-only planning. */
export interface GhRepositoryAutonomyQueue {
  readonly pulls: ReadonlyArray<GhPull>;
  readonly openPullCount: number;
  readonly pullsComplete: boolean;
  readonly issues: ReadonlyArray<GhIssue>;
  readonly openIssueCount: number;
  readonly issuesComplete: boolean;
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

export interface GhIssueComment {
  readonly id: number;
  readonly html_url: string;
  readonly user: { readonly login: string } | null;
  readonly body: string;
  readonly created_at: string;
}

export interface GhReviewComment {
  id?: number;
  html_url?: string;
  user: { login: string } | null;
  body: string;
  path: string;
  /** Line in the current diff; original_line survives force-pushes. */
  line: number | null;
  original_line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  diff_hunk?: string;
  /** Set on every reply, to the id of the comment that STARTED the thread. */
  in_reply_to_id?: number | null;
  created_at: string;
}

export interface GhReviewThreadComment {
  readonly id: string;
  readonly databaseId: number | null;
  readonly author: { readonly login: string } | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly path: string;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly replyTo: { readonly databaseId: number | null } | null;
}

export interface GhReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly comments: {
    readonly nodes: ReadonlyArray<GhReviewThreadComment | null>;
  };
}

interface GhReviewThreadConnection {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: ReadonlyArray<GhReviewThread | null>;
}

interface GhReviewThreadsQuery {
  readonly repository: {
    readonly pullRequest: { readonly reviewThreads: GhReviewThreadConnection } | null;
  } | null;
}

/**
 * One inline comment as GitHub accepts it. Snake_case because it goes on the
 * wire verbatim; `start_side` is mandatory whenever `start_line` is present.
 */
export interface GhReviewCommentInput {
  path: string;
  body: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
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

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner:String!,$name:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100,after:$cursor){
          pageInfo{hasNextPage endCursor}
          nodes{
            id isResolved isOutdated path line
            comments(first:100){
              nodes{id databaseId author{login} body createdAt url path line originalLine replyTo{databaseId}}
            }
          }
        }
      }
    }
  }
`;

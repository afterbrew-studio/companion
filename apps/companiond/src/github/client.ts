/**
 * Minimal GitHub REST client on global fetch — no octokit dependency tree.
 * ETag-aware GETs keep polling cheap against the 5k/hr PAT budget.
 */

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const API = 'https://api.github.com';

export class GitHubClient {
  private readonly etags = new Map<string, { etag: string; body: unknown }>();

  constructor(private readonly token: string) {}

  /** GET with ETag cache. Returns the cached body on 304. */
  async get<T>(path: string): Promise<T> {
    const cached = this.etags.get(path);
    const res = await fetch(`${API}${path}`, {
      headers: {
        ...this.headers(),
        ...(cached ? { 'if-none-match': cached.etag } : {}),
      },
    });
    if (res.status === 304 && cached) return cached.body as T;
    if (!res.ok) throw await this.error(res, path);
    const body = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag) this.etags.set(path, { etag, body });
    return body;
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

  async repo(fullName: string): Promise<{
    full_name: string;
    default_branch: string;
    private: boolean;
    owner: { login: string };
    name: string;
  }> {
    return this.get(`/repos/${fullName}`);
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

  async issueComments(fullName: string, issueNumber: number): Promise<Array<{ user: { login: string } | null; body: string; created_at: string }>> {
    return this.get(`/repos/${fullName}/issues/${issueNumber}/comments?per_page=50`);
  }

  async prReviewList(fullName: string, prNumber: number): Promise<GhReview[]> {
    return this.get(`/repos/${fullName}/pulls/${prNumber}/reviews?per_page=100`);
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

  /** Raw unified diff of a PR (GitHub's diff media type). */
  async prDiff(fullName: string, number: number): Promise<string> {
    const res = await fetch(`${API}/repos/${fullName}/pulls/${number}`, {
      headers: { ...this.headers(), accept: 'application/vnd.github.diff' },
    });
    if (!res.ok) throw await this.error(res, `/repos/${fullName}/pulls/${number}.diff`);
    return res.text();
  }

  /** Post a PR review (COMMENT / APPROVE / REQUEST_CHANGES). */
  async createPrReview(
    fullName: string,
    number: number,
    args: { body: string; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' },
  ): Promise<{ html_url: string }> {
    return this.post(`/repos/${fullName}/pulls/${number}/reviews`, args);
  }

  async mergePr(
    fullName: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<{ merged: boolean; message: string }> {
    const res = await fetch(`${API}/repos/${fullName}/pulls/${number}/merge`, {
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

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'companion-daemon',
    };
  }

  private async send<T>(method: string, path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
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
    return new GitHubError(`GitHub ${path}: ${message}`, res.status);
  }
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
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GhReview {
  user: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string | null;
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

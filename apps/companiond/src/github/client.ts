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
      // The issues endpoint interleaves PRs; a PR carries `pull_request`.
      collected.push(...batch.filter((i) => !i.pull_request));
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

  async addLabels(fullName: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.post(`/repos/${fullName}/issues/${issueNumber}/labels`, { labels });
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
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) message = parsed.message;
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
  pull_request?: unknown;
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  draft?: boolean;
  head: { ref: string };
  base: { ref: string };
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

/**
 * CI repair must not edit `.github/**` unless the issue that started the run
 * named that path. Prompt text is not an enforcer; this is.
 */

const GITHUB_DIR = /^\.github(?:\/|$)/;

export class ForbiddenGithubEdit extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(
      `CI repair tried to edit ${paths.join(', ')} but the issue did not name those paths`,
    );
    this.name = 'ForbiddenGithubEdit';
    this.paths = paths;
  }
}

export function pathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const path = (match[2] ?? match[1] ?? '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function isRepoGithubPath(path: string): boolean {
  return GITHUB_DIR.test(path.replace(/^\.\//, ''));
}

export function issueNamesPath(body: string, path: string): boolean {
  const needle = path.replace(/^\.\//, '');
  if (body.includes(needle)) return true;
  // A Relevant-files row that names the directory covers files under it.
  if (needle.startsWith('.github/') && /(?:^|[\s`])\.github\/?(?:\s|$)/m.test(body)) return true;
  return false;
}

export function unnamedGithubPaths(changedPaths: readonly string[], issueBody: string): string[] {
  return changedPaths.filter((path) => isRepoGithubPath(path) && !issueNamesPath(issueBody, path));
}

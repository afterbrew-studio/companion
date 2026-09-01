/**
 * CI repair must not edit `.github/**` unless the originating issue named that
 * path in Relevant files. The pull-request body is the agent's own output.
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

/** The Relevant files answer, not Context, Summary, or the rest of the body. */
export function relevantFilesSection(body: string): string {
  const heading = body.match(
    /(?:^|\n)#{1,6}\s*Relevant files\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|\n_{3,}\s*$|$)/i,
  );
  if (typeof heading?.[1] === 'string') return heading[1];
  const labelled = body.match(
    /(?:^|\n)Relevant files:\s*\n([\s\S]*?)(?=\n[A-Z][^:\n]{0,40}:\s*\n|$)/i,
  );
  return labelled?.[1] ?? '';
}

export function issueNamesPath(body: string, path: string): boolean {
  const section = relevantFilesSection(body);
  if (section.trim() === '') return false;
  const needle = path.replace(/^\.\//, '');
  if (section.includes(needle)) return true;
  if (needle.startsWith('.github/') && /(?:^|[\s`])\.github\/?(?:\s|$)/m.test(section)) return true;
  return false;
}

export function unnamedGithubPaths(changedPaths: readonly string[], issueBody: string): string[] {
  return changedPaths.filter((path) => isRepoGithubPath(path) && !issueNamesPath(issueBody, path));
}

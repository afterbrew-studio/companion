export function githubUserUrl(host: string, login: string): string {
  return `https://${host}/${encodeURIComponent(login)}`;
}

export function githubRepoUrl(host: string, repo: string): string {
  return `https://${host}/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

export function githubContextUrl(
  host: string,
  repo: string,
  kind: 'pull-request' | 'issue',
  number: number,
): string {
  return `${githubRepoUrl(host, repo)}/${kind === 'pull-request' ? 'pull' : 'issues'}/${number}`;
}

export function githubAvatarUrl(host: string, login: string): string {
  return `${githubUserUrl(host, login)}.png?size=56`;
}

import type { ServiceMap } from '@moxxy/companion-contracts';
import { log } from '@moxxy/companion-sdk/server';
import type { SlopAuthorStanding, SlopCommitFact, SlopProvenance } from '../contract/index.js';

// Structural aliases, same reason as slop-service: another module's /api entry
// must never be imported, so the collaborator types derive from the service
// bundle this module receives through the registry.
type CodeService = ServiceMap['code'];
type GitHubClient = NonNullable<ReturnType<CodeService['githubAccounts']['clientFor']>>;
type PrCommit = Awaited<ReturnType<GitHubClient['prCommits']>>['commits'][number];

/**
 * Branch prefixes coding agents write by default. A match is a fact, not a
 * fault: honest agent use is allowed, and the rule weighs it accordingly.
 */
const AGENT_BRANCH_PREFIXES = [
  'codex/',
  'cursor/',
  'copilot/',
  'devin/',
  'claude/',
  'aider/',
  'sweep/',
  'gpt-engineer/',
];

/** Substrings that make an attribution line machine-authored rather than human. */
const AI_ATTRIBUTION_MARKERS = [
  'claude',
  'chatgpt',
  'openai',
  'gpt-4',
  'gpt-5',
  'copilot',
  'cursor',
  'codex',
  'devin',
  'aider',
  'gemini',
  'anthropic',
  'generated with',
  'ai-generated',
  'ai-assisted',
  'co-authored-by: bot',
];

const DAY_MS = 24 * 60 * 60_000;

/** GitHub's author_association, normalized. Unknown input stays 'unknown'. */
export function toStanding(association: string | undefined | null, accountType?: string): SlopAuthorStanding {
  if (accountType === 'Bot') return 'bot';
  switch ((association ?? '').toUpperCase()) {
    case 'OWNER':
      return 'owner';
    case 'MEMBER':
      return 'member';
    case 'COLLABORATOR':
      return 'collaborator';
    case 'CONTRIBUTOR':
      return 'contributor';
    // GitHub distinguishes "first PR to this repo" from "first PR anywhere";
    // for a maintainer deciding how much scrutiny to apply they are the same.
    case 'FIRST_TIME_CONTRIBUTOR':
    case 'FIRST_TIMER':
      return 'first_time_contributor';
    case 'MANNEQUIN':
      return 'bot';
    case 'NONE':
      return 'none';
    default:
      return 'unknown';
  }
}

/**
 * Trailer keys from a commit message, lowercased. Git's convention is that
 * trailers occupy the final block of the message, so only that block is read:
 * a `Note: ...` line in the middle of a body is prose, not a trailer.
 */
export function trailerKeys(message: string): string[] {
  const blocks = message.replace(/\r\n/g, '\n').trimEnd().split(/\n\s*\n/);
  const last = blocks[blocks.length - 1];
  if (!last) return [];
  const keys: string[] = [];
  for (const line of last.split('\n')) {
    const match = /^([A-Za-z][A-Za-z-]*)\s*:\s*\S/.exec(line.trim());
    if (match) keys.push(match[1]!.toLowerCase());
  }
  return keys;
}

/**
 * Attribution lines in a commit message that name a machine author. Returns the
 * lines verbatim (clipped) so an observation can quote them; the caller never
 * has to re-derive what fired.
 */
export function aiAttributionLines(message: string): string[] {
  const found: string[] = [];
  for (const raw of message.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (AI_ATTRIBUTION_MARKERS.some((marker) => lower.includes(marker))) found.push(line.slice(0, 160));
  }
  return found;
}

function toCommitFact(commit: PrCommit): SlopCommitFact {
  const message = commit.commit.message ?? '';
  const dateText = commit.commit.author?.date ?? commit.commit.committer?.date ?? null;
  const authoredAt = dateText ? Date.parse(dateText) : Number.NaN;
  return {
    sha: commit.sha.slice(0, 8),
    subject: message.split('\n')[0]?.slice(0, 200) ?? '',
    authorLogin: commit.author?.login ?? null,
    authoredAt: Number.isFinite(authoredAt) ? authoredAt : 0,
    trailers: trailerKeys(message),
  };
}

/** The identity a commit is attributed to, preferring the linked account. */
function identityOf(commit: PrCommit): string {
  return (
    commit.author?.login?.toLowerCase() ??
    commit.commit.author?.email?.toLowerCase() ??
    commit.commit.author?.name?.toLowerCase() ??
    'unknown'
  );
}

/** Reduce raw commits to the facts a provenance judgement is allowed to cite. */
export function summarizeCommits(
  commits: readonly PrCommit[],
  truncated: boolean,
): Pick<SlopProvenance, 'commits' | 'commitsTruncated' | 'aiTrailers' | 'signedOff' | 'distinctAuthors' | 'spanMinutes'> {
  const facts = commits.map(toCommitFact);
  const attribution = new Set<string>();
  for (const commit of commits) for (const line of aiAttributionLines(commit.commit.message ?? '')) attribution.add(line);

  const times = facts.map((f) => f.authoredAt).filter((t) => t > 0);
  const spanMinutes =
    times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 60_000) : null;

  return {
    commits: facts,
    commitsTruncated: truncated,
    aiTrailers: [...attribution],
    // Vacuously true on an empty list would claim DCO compliance for a PR whose
    // commits could not be read, so an empty list is not signed off.
    signedOff: facts.length > 0 && facts.every((f) => f.trailers.includes('signed-off-by')),
    distinctAuthors: new Set(commits.map(identityOf)).size,
    spanMinutes,
  };
}

export function agentBranchPrefix(headRef: string): string | null {
  const lower = headRef.toLowerCase();
  return AGENT_BRANCH_PREFIXES.find((prefix) => lower.startsWith(prefix)) ?? null;
}

/**
 * Fetch what GitHub knows about where this pull request came from: the author's
 * standing and account footprint, and the commits with their trailers.
 *
 * Bounded and tolerant by design. At most three requests (all ETag-cached on
 * the client), and any failure degrades the record rather than failing the
 * detection: a missing profile leaves the age fields null, an unreachable API
 * returns null and the prompt then tells the agent it has no provenance data.
 * Provenance is context for a judgement, never a precondition for making one.
 */
export async function gatherProvenance(
  client: GitHubClient,
  repo: string,
  pr: { number: number; author: string; headRef: string },
): Promise<SlopProvenance | null> {
  const [pull, commits, profile] = await Promise.all([
    client.pull(repo, pr.number).catch(() => null),
    client.prCommits(repo, pr.number).catch(() => null),
    pr.author ? client.user(pr.author).catch(() => null) : Promise.resolve(null),
  ]);

  if (!pull && !commits && !profile) {
    log.warn('slop provenance unavailable', { repo, prNumber: pr.number });
    return null;
  }

  const created = profile?.created_at ? Date.parse(profile.created_at) : Number.NaN;
  return {
    authorLogin: pr.author,
    standing: toStanding(pull?.author_association, profile?.type),
    accountAgeDays: Number.isFinite(created) ? Math.floor((Date.now() - created) / DAY_MS) : null,
    publicRepos: profile?.public_repos ?? null,
    followers: profile?.followers ?? null,
    ...summarizeCommits(commits?.commits ?? [], commits?.truncated ?? false),
    branchAgentPrefix: agentBranchPrefix(pr.headRef),
  };
}

/**
 * The provenance block injected into the detection prompt. Absent data is
 * stated as absent: the alternative is an agent that reads silence as evidence.
 */
export function provenanceSection(provenance: SlopProvenance | null): string {
  if (!provenance) {
    return `## Contributor provenance
UNAVAILABLE. GitHub could not be reached for this detection. You have no commit metadata, no author history and no standing. Do not report any provenance signal; judge only from the description and the code.`;
  }

  const lines: string[] = [];
  lines.push(`Author: ${provenance.authorLogin} | Standing in this repo: ${standingLabel(provenance.standing)}`);
  lines.push(
    `Account: ${provenance.accountAgeDays === null ? 'age unknown' : `${provenance.accountAgeDays} days old`}` +
      `${provenance.publicRepos === null ? '' : `, ${provenance.publicRepos} public repos`}` +
      `${provenance.followers === null ? '' : `, ${provenance.followers} followers`}`,
  );
  lines.push(
    `Commits: ${provenance.commits.length}${provenance.commitsTruncated ? '+ (list capped)' : ''}` +
      ` by ${provenance.distinctAuthors} distinct identity/identities` +
      `${provenance.spanMinutes === null ? '' : `, spanning ${provenance.spanMinutes} minutes`}`,
  );
  lines.push(`DCO: ${provenance.signedOff ? 'every commit is signed off' : 'not every commit carries Signed-off-by'}`);
  lines.push(
    provenance.branchAgentPrefix
      ? `Branch prefix: '${provenance.branchAgentPrefix}' (a coding agent's default naming)`
      : 'Branch prefix: no agent-tool prefix',
  );
  lines.push(
    provenance.aiTrailers.length > 0
      ? `AI attribution found in commit messages:\n${provenance.aiTrailers.map((t) => `  - ${t}`).join('\n')}`
      : 'AI attribution in commit messages: none found',
  );

  const commitList = provenance.commits
    .slice(0, 40)
    .map((c) => `  - ${c.sha} ${c.subject}${c.authorLogin ? ` (${c.authorLogin})` : ' (unlinked email)'}`)
    .join('\n');
  if (commitList) lines.push(`Commit subjects:\n${commitList}`);

  return `## Contributor provenance (fetched from GitHub, treat as fact)\n${lines.join('\n')}`;
}

function standingLabel(standing: SlopAuthorStanding): string {
  switch (standing) {
    case 'first_time_contributor':
      return 'FIRST-TIME CONTRIBUTOR (no merged PR here before)';
    case 'bot':
      return 'BOT or mannequin account';
    case 'none':
      return 'no association (outside contributor)';
    case 'unknown':
      return 'unknown (GitHub did not report it, so do not infer)';
    default:
      return standing;
  }
}

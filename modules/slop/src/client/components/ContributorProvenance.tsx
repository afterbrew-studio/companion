import { Eyebrow, MetaSignal, type StatusTone } from '@moxxy/companion-sdk/ui';
import type { SlopAuthorStanding, SlopProvenance } from '../../contract/index.js';

const STANDING_META: Record<SlopAuthorStanding, { label: string; tone: StatusTone }> = {
  owner: { label: 'repo owner', tone: 'green' },
  member: { label: 'org member', tone: 'green' },
  collaborator: { label: 'collaborator', tone: 'green' },
  contributor: { label: 'returning contributor', tone: 'zinc' },
  first_time_contributor: { label: 'first-time contributor', tone: 'amber' },
  bot: { label: 'bot account', tone: 'amber' },
  none: { label: 'outside contributor', tone: 'amber' },
  unknown: { label: 'standing unknown', tone: 'zinc' },
};

/** Under a month old with almost nothing published: worth a maintainer's eye. */
function isFreshAccount(p: SlopProvenance): boolean {
  return p.accountAgeDays !== null && p.accountAgeDays < 30;
}

/**
 * The facts the detection ran with, shown next to the verdict so a maintainer
 * can weigh the agent's provenance reasoning against its inputs rather than
 * taking the score on trust. Everything here was snapshotted at detection time.
 */
export function ContributorProvenance({ provenance }: { provenance: SlopProvenance | null }): JSX.Element {
  if (!provenance) {
    return (
      <div>
        <Eyebrow>Contributor</Eyebrow>
        <p className="dim mt-1.5 text-xs">
          This detection carried no contributor facts, because GitHub was unreachable or the detection predates
          provenance capture. Where facts were missing the agent was told to report no provenance signal rather than
          infer one.
        </p>
      </div>
    );
  }

  const standing = STANDING_META[provenance.standing];
  const chips: Array<{ tone: StatusTone; label: string; title?: string }> = [
    { tone: standing.tone, label: standing.label },
  ];
  if (isFreshAccount(provenance)) {
    chips.push({ tone: 'amber', label: `account ${provenance.accountAgeDays}d old` });
  }
  if (provenance.aiTrailers.length > 0) {
    chips.push({
      tone: 'amber',
      label: 'AI attribution',
      title: provenance.aiTrailers.join('\n'),
    });
  }
  if (provenance.branchAgentPrefix) {
    chips.push({ tone: 'zinc', label: `branch ${provenance.branchAgentPrefix}` });
  }
  chips.push(
    provenance.signedOff
      ? { tone: 'green', label: 'DCO signed off' }
      : { tone: 'zinc', label: 'no Signed-off-by' },
  );

  return (
    <div>
      <Eyebrow>Contributor</Eyebrow>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          className="linkish font-mono text-[13px]"
          href={`https://github.com/${provenance.authorLogin}`}
          target="_blank"
          rel="noreferrer"
        >
          {provenance.authorLogin}
        </a>
        {chips.map((chip, i) => (
          <MetaSignal key={i} tone={chip.tone} label={chip.label} title={chip.title} />
        ))}
      </div>
      <p className="dim mt-1.5 text-xs">
        {describeAccount(provenance)}
        {' · '}
        {describeCommits(provenance)}
      </p>
      {provenance.commits.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {provenance.commits.slice(0, 12).map((commit) => (
            <li key={commit.sha} className="truncate text-xs">
              <span className="dim font-mono">{commit.sha}</span> {commit.subject}
              {commit.authorLogin === null ? <span className="dim"> (unlinked email)</span> : null}
            </li>
          ))}
          {provenance.commits.length > 12 ? (
            <li className="dim text-xs">and {provenance.commits.length - 12} more</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function describeAccount(p: SlopProvenance): string {
  const age = p.accountAgeDays === null ? 'account age unknown' : `account ${formatAge(p.accountAgeDays)} old`;
  const repos = p.publicRepos === null ? '' : `, ${p.publicRepos} public repos`;
  return `${age}${repos}`;
}

function describeCommits(p: SlopProvenance): string {
  if (p.commits.length === 0) return 'commits unavailable';
  const count = `${p.commits.length}${p.commitsTruncated ? '+' : ''} commit${p.commits.length === 1 ? '' : 's'}`;
  const authors = p.distinctAuthors > 1 ? `, ${p.distinctAuthors} authors` : '';
  const span = p.spanMinutes === null ? '' : `, over ${formatSpan(p.spanMinutes)}`;
  return `${count}${authors}${span}`;
}

function formatAge(days: number): string {
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function formatSpan(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

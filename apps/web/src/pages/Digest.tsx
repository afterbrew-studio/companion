import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useDigest } from '../hooks/useDigest.js';
import { Markdown } from '../components/Markdown.js';
import { EmptyState, Page, PageHeader, Section, Spinner, timeAgo } from '../components/ui.js';

/**
 * Daily Digest: the AI review of a repository — what shipped, what failed,
 * what matters now, and where the project is heading. One digest per repo per
 * run; generated on demand here or on the daily schedule (Automations).
 */
export function DigestPage(): JSX.Element {
  const { current, repos, reports, runs, selected, setSelected, loaded, error, setError, refresh } = useDigest();
  const { can } = useAuth();
  const [sending, setSending] = useState(false);

  if (!current) {
    return (
      <Page>
        <EmptyState title="No workspace yet" hint="Connect a repository first (Repositories)." />
      </Page>
    );
  }

  const repo = repos.find((r) => r.fullName === selected) ?? null;
  const digests = reports.filter((r) => r.kind === 'digest' && r.repo === selected);
  const [latest, ...history] = digests;
  // The one-shot lives as a report run while the agent works — surface it so a
  // digest kicked off elsewhere (schedule, another tab) still shows progress.
  const liveRun = runs.find((r) => r.live && r.kind === 'report' && r.repo === selected) ?? null;
  const generating = sending || liveRun !== null;

  const generate = async (): Promise<void> => {
    if (!selected) return;
    setSending(true);
    setError(null);
    try {
      // Returns immediately; the agent works in the background. Keep the local
      // busy state up briefly to bridge the gap until the live run appears.
      await api.digestNow(selected);
      await refresh();
      window.setTimeout(() => setSending(false), 5000);
    } catch (err) {
      setError(String(err));
      setSending(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Daily Digest"
        subtitle="The AI review of your repository — shipped, failed, what matters now, and the direction."
        actions={
          <>
            {repos.length > 1 ? (
              <select
                className="input py-1.5"
                aria-label="Repository"
                value={selected ?? ''}
                onChange={(e) => setSelected(e.target.value)}
              >
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            ) : null}
            {can('automations:manage') && selected ? (
              <button className="btn" disabled={generating} onClick={() => void generate()}>
                {generating ? 'Reviewing…' : 'Generate digest'}
              </button>
            ) : null}
          </>
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      {generating ? (
        <div className="card anim-in flex items-center gap-3">
          <Spinner />
          <span className="min-w-0 flex-1 text-sm">
            <span className="block font-medium">AI is reviewing {selected}</span>
            <span className="dim block text-xs">
              Reading tracker state and the clone; the digest lands here in a few minutes.
            </span>
          </span>
          {liveRun ? (
            <a className="btn-ghost shrink-0" href={`#/runs/${liveRun.id}`}>
              Watch live
            </a>
          ) : null}
        </div>
      ) : null}

      {!loaded ? null : repos.length === 0 ? (
        <EmptyState
          title="No repositories in this workspace"
          hint="Connect a repository first (Repositories)."
          action={
            <a className="btn" href="#/repos">
              Open Repositories
            </a>
          }
        />
      ) : latest ? (
        <article className={`card ${generating ? 'mt-4' : ''} anim-in`} aria-label="Latest digest">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-2.5 text-sm dark:border-zinc-800">
            <span className="badge">digest</span>
            <strong className="min-w-0 flex-1 truncate">{latest.repo}</strong>
            <span className="dim">{timeAgo(latest.createdAt)}</span>
          </div>
          <div className="pt-2.5">
            <Markdown text={latest.body} />
          </div>
        </article>
      ) : generating ? null : (
        <EmptyState
          title="No digest yet"
          hint={
            can('automations:manage')
              ? 'Generate your first digest above, or enable the daily schedule under Automations.'
              : 'Digests appear here once a maintainer generates one or the daily schedule runs.'
          }
        />
      )}

      {repo && can('automations:manage') && !repo.digestEnabled ? (
        <p className="dim mt-3 text-[13px]">
          Want this every morning without clicking?{' '}
          <a className="underline" href="#/automations">
            Enable the daily digest schedule
          </a>{' '}
          for {repo.fullName}.
        </p>
      ) : null}

      {history.length > 0 ? (
        <Section title="Previous digests" description="Older reviews for this repository, newest first.">
          <div className="flex flex-col gap-2.5">
            {history.map((r) => (
              <details key={r.id} className="card">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm select-none">
                  <span className="badge">digest</span>
                  <strong className="min-w-0 flex-1 truncate">{r.title}</strong>
                  <span className="dim">{timeAgo(r.createdAt)}</span>
                </summary>
                <div className="mt-2.5 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
                  <Markdown text={r.body} />
                </div>
              </details>
            ))}
          </div>
        </Section>
      ) : null}
    </Page>
  );
}

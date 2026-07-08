import { useState } from 'react';
import type { ProposalRecord, RepoRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useProposals } from '../hooks/useProposals.js';
import { Page, EmptyState, Modal, PageHeader, Spinner, Tooltip, timeAgo, useConfirm } from '../components/ui.js';
import { facet, useListFilter, ListFilterToolbar, type FilterSelectField } from '../lib/list-filter.js';

/**
 * Proposals for the active workspace. Business users file and follow; a
 * maintainer approves (starting an implementation agent) and finishes into a
 * PR. Lifecycle: draft → analyzing → analyzed → implementing → review →
 * implemented.
 */
export function ProposalsPage(): JSX.Element {
  const { current, repos, proposals, error, refresh } = useProposals();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);

  const filterFields: Array<FilterSelectField<ProposalRecord>> = [
    {
      key: 'repo',
      label: 'Repository',
      allLabel: 'All repositories',
      options: facet(proposals, (p) => p.repo).map((r) => ({ value: r, label: r })),
      match: (p, v) => p.repo === v,
    },
    {
      key: 'status',
      label: 'Status',
      allLabel: 'Any status',
      options: [
        'draft',
        'analyzing',
        'analyzed',
        'approved',
        'implementing',
        'review',
        'implemented',
        'rejected',
        'failed',
      ].map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })),
      match: (p, v) => p.status === v,
    },
  ];
  const filter = useListFilter(
    proposals,
    (p, needle) => p.title.toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle),
    filterFields,
  );
  const filtered = filter.filtered;

  if (!current) return <EmptyState title="No workspace selected" />;

  return (
    <Page>
      <PageHeader
        title="Proposals"
        subtitle={current.name}
        actions={
          can('proposals:create') ? (
            <button className="btn" onClick={() => setCreating(true)}>
              New proposal
            </button>
          ) : undefined
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      {proposals.length > 0 ? (
        <ListFilterToolbar
          filter={filter}
          fields={filterFields}
          total={proposals.length}
          placeholder="Search title or body…"
          searchLabel="Search proposals"
        />
      ) : null}

      <div className="flex flex-col gap-3">
        {filtered.map((p) => (
          <ProposalCard key={p.id} proposal={p} onChange={refresh} />
        ))}
      </div>
      {proposals.length === 0 ? (
        <EmptyState
          title="No proposals yet"
          hint="Describe a change in plain language; an agent analyzes feasibility before any code is written."
          action={
            can('proposals:create') ? (
              <button className="btn" onClick={() => setCreating(true)}>
                Write the first proposal
              </button>
            ) : undefined
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No proposals match" hint="Loosen the search or clear the filters." />
      ) : null}

      {creating ? (
        <CreateProposalModal
          repos={repos}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

function CreateProposalModal({
  repos,
  onClose,
  onCreated,
}: {
  repos: RepoRecord[];
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [repo, setRepo] = useState(repos[0]?.fullName ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { proposal } = await api.createProposal(repo, title.trim(), body.trim());
      // Fire the feasibility analysis right away; the card streams its state.
      void api.analyzeProposal(proposal.id).catch(() => undefined);
      onCreated();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New proposal" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Repository</span>
          <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)} required>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Title</span>
          <input
            className="input"
            required
            minLength={3}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add CSV export to the reports screen"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">What should change, and why?</span>
          <textarea
            className="input min-h-36"
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe the outcome you want in plain language. The analysis agent reads the codebase and reports feasibility, steps, and risks."
          />
        </label>
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !repo || !title.trim() || !body.trim()}>
            {busy ? 'Creating…' : 'Create & analyze'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Leading state at a glance: spinner while agents work, colored glyph otherwise. */
function ProposalStateIcon({ status, failedImplementing }: { status: ProposalRecord['status']; failedImplementing: boolean }): JSX.Element {
  if (status === 'analyzing' || status === 'implementing') {
    return (
      <Tooltip content={status === 'analyzing' ? 'Agent is analyzing feasibility' : 'Agent is implementing'}>
        <Spinner />
      </Tooltip>
    );
  }
  const spec =
    status === 'implemented'
      ? { label: 'Implemented', cls: 'text-emerald-600 dark:text-emerald-400', glyph: 'M4.6 8.4l2 2 4-4.4' }
      : status === 'rejected' || status === 'failed'
        ? {
            label: status === 'rejected' ? 'Rejected' : failedImplementing ? 'Implementation failed' : 'Analysis failed',
            cls: 'text-red-600 dark:text-red-400',
            glyph: 'm5.5 5.5 5 5M10.5 5.5l-5 5',
          }
        : status === 'analyzed' || status === 'review'
          ? { label: status === 'review' ? 'Ready for review' : 'Analyzed — awaiting approval', cls: 'text-amber-600 dark:text-amber-400', glyph: 'M8 4.6v4M8 11h.01' }
          : { label: 'Draft', cls: 'text-zinc-400 dark:text-zinc-500', glyph: 'M5 8h6' };
  return (
    <Tooltip content={spec.label}>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-4 shrink-0 ${spec.cls}`}
        role="img"
        aria-label={spec.label}
      >
        <circle cx="8" cy="8" r="6.2" />
        <path d={spec.glyph} />
      </svg>
    </Tooltip>
  );
}

function ProposalCard({
  proposal,
  onChange,
}: {
  proposal: ProposalRecord;
  onChange: () => Promise<void>;
}): JSX.Element {
  const { can } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const canAct = can('proposals:act');

  /** Distill what shipped into a spec draft — an agent reads the merged work. */
  const capture = async (): Promise<void> => {
    setCapturing(true);
    setError(null);
    try {
      await api.captureSpecFromProposal(proposal.id);
      setCaptured(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setCapturing(false);
    }
  };

  const act = (fn: () => Promise<unknown>) => async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const a = proposal.analysis;

  return (
    <article className="card" aria-label={proposal.title}>
      <div className="flex items-center gap-2.5">
        <ProposalStateIcon status={proposal.status} failedImplementing={proposal.implementRunId !== null} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{proposal.title}</div>
          <div className="dim mt-0.5 truncate text-xs">
            {proposal.status.replace('_', ' ')} · {proposal.repo.split('/')[1] ?? proposal.repo} ·{' '}
            {timeAgo(proposal.updatedAt)}
          </div>
        </div>
      </div>

      <p className="dim mt-2.5 line-clamp-2 text-[13px] whitespace-pre-wrap">{proposal.body}</p>

      {a ? (
        <div className="mt-2.5">
          <button className="linkish text-sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide analysis' : `Analysis: feasibility ${a.feasibility} — details`}
          </button>
          {expanded ? (
            <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-[13px] dark:bg-zinc-900">
              <p>{a.summary}</p>
              {a.steps.length > 0 ? (
                <ol className="mt-2 list-decimal pl-5">
                  {a.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              ) : null}
              {a.risks.length > 0 ? (
                <div className="mt-2">
                  <span className="dim">Risks:</span>
                  <ul className="list-disc pl-5">
                    {a.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="error-bar">{error}</div> : null}

      <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        {proposal.status === 'draft' || proposal.status === 'failed' ? (
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => void act(() => api.analyzeProposal(proposal.id))()}
          >
            {proposal.status === 'failed' ? 'Retry analysis' : 'Analyze'}
          </button>
        ) : null}
        {proposal.status === 'analyzed' && canAct ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                // Land on the animated PR preview to watch the agent build it.
                const { proposal: p } = await api.approveProposal(proposal.id);
                if (p.implementRunId) location.hash = `#/runs/${p.implementRunId}/preview`;
              })()
            }
          >
            Approve & implement
          </button>
        ) : null}
        {proposal.status === 'review' && canAct ? (
          <>
            {proposal.implementRunId ? (
              <a className="btn-ghost" href={`#/runs/${proposal.implementRunId}/preview`}>
                Review the diff
              </a>
            ) : null}
            <button className="btn" disabled={busy} onClick={() => void act(() => api.finishProposal(proposal.id))()}>
              Finish → open PR
            </button>
          </>
        ) : null}
        {proposal.status === 'implementing' && proposal.implementRunId ? (
          <a className="btn-ghost" href={`#/runs/${proposal.implementRunId}/preview`}>
            Watch implementation
          </a>
        ) : null}
        {proposal.status === 'implemented' && can('specs:manage') ? (
          captured ? (
            <span className="dim text-[13px]">
              Spec drafting — see{' '}
              <a className="linkish" href="#/specs">
                Specifications
              </a>
            </span>
          ) : (
            <button className="btn-ghost" disabled={capturing} onClick={() => void capture()}>
              {capturing ? 'Queueing…' : 'Capture as spec'}
            </button>
          )
        ) : null}
        {proposal.prUrl ? (
          <a className="btn-ghost" href={proposal.prUrl} target="_blank" rel="noreferrer">
            PR ↗
          </a>
        ) : null}
        {canAct &&
        proposal.status !== 'rejected' &&
        proposal.status !== 'implemented' &&
        proposal.status !== 'implementing' ? (
          <>
            <span className="action-sep" aria-hidden />
            <button
              className="btn-danger-ghost"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  const ok = await confirmDanger({
                    title: 'Reject proposal',
                    message: `"${proposal.title}" is marked rejected and leaves the actionable queue.`,
                    confirmLabel: 'Reject',
                  });
                  if (ok) await act(() => api.rejectProposal(proposal.id))();
                })()
              }
            >
              Reject
            </button>
          </>
        ) : null}
      </div>
      {confirmElement}
    </article>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  CardActions,
  EmptyState,
  ErrorBar,
  Field,
  FilterField,
  FiltersPopover,
  FormActions,
  InlineLoading,
  ListFooter,
  Modal,
  Page,
  PageHeader,
  SearchInput,
  Spinner,
  StatusGlyph,
  Tooltip,
  timeAgo,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { ProposalListRecord, ProposalRecord } from '../../contract/index.js';
import { planApi as api } from '../api.js';
import { useProposals } from '../hooks/useProposals.js';

/**
 * Proposals for the active workspace. Business users file and follow; a
 * maintainer approves (starting an implementation agent) and finishes into a
 * PR. Lifecycle: draft → analyzing → analyzed → implementing → review →
 * implemented.
 */
export function ProposalsPage(): JSX.Element {
  const {
    current,
    repos,
    proposals,
    total,
    loading,
    hasMore,
    loadMore,
    search,
    setSearch,
    filters,
    setFilter,
    clearFilters,
    activeFilters,
    error,
    refresh,
  } = useProposals();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);

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
      <ErrorBar error={error} />

      <div className="flex items-center justify-end gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search title or body…  ( / )"
          ariaLabel="Search proposals by title or body"
          className="w-full sm:w-72"
        />
        <FiltersPopover active={activeFilters} onClear={clearFilters}>
          <FilterField label="Repository">
            <select className="input" value={filters.repo} onChange={(event) => setFilter('repo')(event.target.value)}>
              <option value="all">All repositories</option>
              {repos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>{repo.fullName}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Status">
            <select className="input" value={filters.status} onChange={(event) => setFilter('status')(event.target.value)}>
              <option value="all">Any status</option>
              {[
                'draft', 'analyzing', 'analyzed', 'approved', 'implementing',
                'review', 'implemented', 'rejected', 'failed',
              ].map((status) => (
                <option key={status} value={status}>{status[0]!.toUpperCase() + status.slice(1)}</option>
              ))}
            </select>
          </FilterField>
        </FiltersPopover>
      </div>

      {proposals === null ? (
        <InlineLoading label="Loading proposals…" />
      ) : proposals.length > 0 ? (
        <>
          <div className="flex flex-col gap-3">
            {proposals.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} onChange={refresh} />
            ))}
          </div>
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={proposals.length}
            total={total}
            noun="proposals"
            onVisible={loadMore}
          />
        </>
      ) : !error && (search.trim() !== '' || activeFilters > 0) ? (
        <EmptyState title="No proposals match" hint="Loosen the search or clear the filters." />
      ) : !error ? (
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
      ) : null}

      {creating ? (
        <CreateProposalModal
          workspaceId={current.id}
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
  workspaceId,
  repos,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  repos: RepoRecord[];
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [repo, setRepo] = useState(repos.find((candidate) => candidate.githubAccessible)?.fullName ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { proposal } = await api.createProposal(workspaceId, repo, title.trim(), body.trim());
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
        <Field label="Repository">
          <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)} required>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName} disabled={!r.githubAccessible}>
                {r.fullName}
                {r.githubAccessible ? '' : ' — access required'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input
            className="input"
            required
            minLength={3}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add CSV export to the reports screen"
          />
        </Field>
        <Field label="What should change, and why?">
          <textarea
            className="input min-h-36"
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe the outcome you want in plain language. The analysis agent reads the codebase and reports feasibility, steps, and risks."
          />
        </Field>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !repo || !title.trim() || !body.trim()}>
            {busy ? 'Creating…' : 'Create & analyze'}
          </button>
        </FormActions>
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
  if (status === 'implemented') return <StatusGlyph tone="ok" label="Implemented" />;
  if (status === 'rejected' || status === 'failed') {
    return (
      <StatusGlyph
        tone="danger"
        label={status === 'rejected' ? 'Rejected' : failedImplementing ? 'Implementation failed' : 'Analysis failed'}
      />
    );
  }
  if (status === 'analyzed' || status === 'review') {
    return <StatusGlyph tone="warn" label={status === 'review' ? 'Ready for review' : 'Analyzed — awaiting approval'} />;
  }
  return <StatusGlyph tone="muted" label="Draft" />;
}

function ProposalCard({
  proposal,
  onChange,
}: {
  proposal: ProposalListRecord;
  onChange: () => Promise<void>;
}): JSX.Element {
  const { can } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ProposalRecord | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const detailSeq = useRef(0);
  const canAct = can('proposals:act');

  useEffect(() => {
    detailSeq.current += 1;
    setDetail(null);
    setDetailBusy(false);
    setExpanded(false);
  }, [proposal.id, proposal.updatedAt]);

  const toggleAnalysis = async (): Promise<void> => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (detail) {
      setExpanded(true);
      return;
    }
    const mySeq = ++detailSeq.current;
    setDetailBusy(true);
    setError(null);
    try {
      const response = await api.getProposal(proposal.id);
      if (detailSeq.current !== mySeq) return;
      setDetail(response.proposal);
      setExpanded(true);
    } catch (err) {
      if (detailSeq.current === mySeq) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (detailSeq.current === mySeq) setDetailBusy(false);
    }
  };

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

  const analysis = detail?.analysis ?? null;

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

      <p className="dim mt-2.5 line-clamp-2 text-[13px] whitespace-pre-wrap">
        {proposal.bodyPreview}{proposal.bodyLength > proposal.bodyPreview.length ? '…' : ''}
      </p>

      {proposal.analysisFeasibility ? (
        <div className="mt-2.5">
          <button className="linkish shrink-0 text-sm" disabled={detailBusy} onClick={() => void toggleAnalysis()}>
            {detailBusy
              ? 'Loading analysis…'
              : expanded
                ? 'Hide analysis'
                : `Analysis: feasibility ${proposal.analysisFeasibility} — details`}
          </button>
          {expanded && analysis ? (
            <div className="well mt-2 text-[13px]">
              <p>{analysis.summary}</p>
              {analysis.steps.length > 0 ? (
                <ol className="mt-2 list-decimal pl-5">
                  {analysis.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              ) : null}
              {analysis.risks.length > 0 ? (
                <div className="mt-2">
                  <span className="dim">Risks:</span>
                  <ul className="list-disc pl-5">
                    {analysis.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <ErrorBar error={error} />

      <CardActions>
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
      </CardActions>
      {confirmElement}
    </article>
  );
}

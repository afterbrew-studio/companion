import { useEffect, useState } from 'react';
import type { ProposalRecord, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

export function ProposalsPage(): JSX.Element {
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [{ proposals }, { repos }] = await Promise.all([api.listProposals(), api.listRepos()]);
      setProposals(proposals);
      setRepos(repos);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'proposals.changed' || msg.t === 'runs.changed') void refresh();
    });
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Proposals</h1>
        <button className="btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New proposal'}
        </button>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}
      {showForm ? (
        <ProposalForm
          repos={repos}
          onCreated={() => {
            setShowForm(false);
            void refresh();
          }}
        />
      ) : null}

      <ul className="mt-4 flex flex-col gap-2.5">
        {proposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} onChange={refresh} />
        ))}
        {proposals.length === 0 ? (
          <li className="dim py-5">No proposals yet — write one and let the AI analyze it.</li>
        ) : null}
      </ul>
    </div>
  );
}

function ProposalForm({ repos, onCreated }: { repos: RepoRecord[]; onCreated: () => void }): JSX.Element {
  const [repo, setRepo] = useState(repos[0]?.fullName ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { proposal } = await api.createProposal(repo, title, body);
      void api.analyzeProposal(proposal.id); // fire analysis right away
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mt-3 flex flex-col gap-2.5">
      <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((r) => (
          <option key={r.fullName}>{r.fullName}</option>
        ))}
      </select>
      <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        className="input resize-y"
        placeholder="Describe the change you want. The AI will analyze feasibility against the codebase and propose an implementation plan."
        rows={6}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error ? <div className="error-bar">{error}</div> : null}
      <button className="btn self-start" disabled={busy || !repo || title.length < 3 || !body} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create & analyze'}
      </button>
    </div>
  );
}

function propBadge(status: ProposalRecord['status']): string {
  if (status === 'implemented') return 'badge-ok';
  if (status === 'analyzing' || status === 'implementing') return 'badge-warn';
  if (status === 'analyzed' || status === 'review') return 'badge-accent';
  if (status === 'failed' || status === 'rejected') return 'badge-danger';
  return 'badge';
}

function ProposalCard({ proposal, onChange }: { proposal: ProposalRecord; onChange: () => Promise<void> }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const act = (fn: () => Promise<unknown>) => (): void => {
    setError(null);
    void fn()
      .then(onChange)
      .catch((e) => setError(String(e)));
  };

  return (
    <li className="card flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={propBadge(proposal.status)}>{proposal.status}</span>
        <button className="linkish font-medium" onClick={() => setOpen((v) => !v)}>
          {proposal.title}
        </button>
        <span className="dim">{proposal.repo}</span>
        <span className="flex-1" />
        {proposal.status === 'draft' || proposal.status === 'failed' ? (
          <button className="btn-ghost" onClick={act(() => api.analyzeProposal(proposal.id))}>
            Analyze
          </button>
        ) : null}
        {proposal.status === 'analyzing' ? <span className="dim">analyzing…</span> : null}
        {proposal.status === 'analyzed' ? (
          <>
            <button className="btn" onClick={act(() => api.approveProposal(proposal.id))}>
              Approve & implement
            </button>
            <button className="btn-danger" onClick={act(() => api.rejectProposal(proposal.id))}>
              Reject
            </button>
          </>
        ) : null}
        {proposal.status === 'implementing' && proposal.implementRunId ? (
          <a className="linkish text-sm" href={`#/runs/${proposal.implementRunId}`}>
            watch run →
          </a>
        ) : null}
        {proposal.status === 'review' && proposal.implementRunId ? (
          <a className="linkish text-sm" href={`#/runs/${proposal.implementRunId}`}>
            review diff →
          </a>
        ) : null}
        {proposal.prUrl ? (
          <a className="linkish text-sm" href={proposal.prUrl} target="_blank" rel="noreferrer">
            PR ↗
          </a>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-dashed border-zinc-300 pt-2.5 dark:border-zinc-700">
          <pre className="dim text-[13px] whitespace-pre-wrap">{proposal.body}</pre>
          {proposal.analysis ? (
            <div className="mt-2 rounded-lg border border-dashed border-zinc-300 px-3.5 py-2.5 text-[13px] dark:border-zinc-700">
              <p>
                <strong>Analysis</strong> — feasibility: <span className="badge">{proposal.analysis.feasibility}</span>
              </p>
              <p className="mt-1">{proposal.analysis.summary}</p>
              <ol className="mt-1.5 list-decimal pl-5">
                {proposal.analysis.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              {proposal.analysis.risks.length ? <p className="dim mt-1.5">Risks: {proposal.analysis.risks.join(' · ')}</p> : null}
              {proposal.analysisRunId ? (
                <a className="dim hover:underline" href={`#/runs/${proposal.analysisRunId}`}>
                  analysis run →
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <div className="error-bar">{error}</div> : null}
    </li>
  );
}

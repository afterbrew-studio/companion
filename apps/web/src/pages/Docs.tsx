import { useCallback, useEffect, useState } from 'react';
import type { AreaStorage, AreaStorageState, DocRecord, DocSearchHit, RepoDocFile, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { Markdown } from '../components/Markdown.js';
import { AreaStorageSetup, StorageSummary } from '../components/AreaStorageSetup.js';
import { Page, EmptyState, Modal, PageHeader, Spinner, Tooltip, timeAgo, useConfirm } from '../components/ui.js';

/**
 * Documentation for the active workspace: curated knowledge (architecture,
 * business context, runbooks) chunked and indexed by the built-in local-bm25
 * embedder so the assistant and agents can retrieve it. Docs come from three
 * places: written here, imported from a repo's markdown files, or drafted by
 * an agent that reads the codebase. The search box previews exactly what
 * retrieval returns.
 */
export function DocsPage(): JSX.Element {
  const { current } = useWorkspace();
  const { can } = useAuth();
  const [docs, setDocs] = useState<DocRecord[] | null>(null);
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [storage, setStorage] = useState<AreaStorageState | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [modal, setModal] = useState<'write' | 'import' | 'generate' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [d, r, cfg] = await Promise.all([
        api.workspaceDocs(current.id),
        api.workspaceRepos(current.id),
        api.docsConfig(current.id),
      ]);
      setDocs(d.docs);
      setRepos(r.repos);
      setStorage(cfg);
      setError(null);
    } catch (err) {
      setError(String(err));
      setDocs([]);
    }
  }, [current]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'docs.changed') void refresh();
    });
  }, [refresh]);

  if (!current) return <EmptyState title="No workspace selected" />;
  const canManage = can('docs:manage');
  const needsSetup = storage !== null && storage.config === null;
  const configDir = storage?.config?.dir ?? null;

  return (
    <Page>
      <PageHeader
        title="Documentation"
        subtitle={`${current.name} · indexed for retrieval by agents and the assistant`}
        actions={
          canManage && !needsSetup ? (
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={() => setModal('import')}>
                Import from repo
              </button>
              <button className="btn-ghost" onClick={() => setModal('generate')}>
                ✦ Generate
              </button>
              <button className="btn" onClick={() => setModal('write')}>
                New doc
              </button>
            </div>
          ) : undefined
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      {storage !== null && ((needsSetup && canManage) || configuring) ? (
        <AreaStorageSetup
          area="documentation"
          defaultDir="docs"
          state={storage}
          onSave={async (dir) => {
            await api.saveDocsConfig(current.id, dir);
            setConfiguring(false);
            await refresh();
          }}
          onCancel={configuring ? () => setConfiguring(false) : undefined}
        />
      ) : storage?.config ? (
        <StorageSummary config={storage.config} canManage={canManage} onChange={() => setConfiguring(true)} />
      ) : null}

      <RetrievalSearch workspaceId={current.id} />

      <div className="mt-4 flex flex-col gap-3">
        {(docs ?? []).map((d) => (
          <DocCard key={d.id} doc={d} onChange={refresh} />
        ))}
      </div>
      {docs !== null && docs.length === 0 ? (
        <EmptyState
          title="No documentation yet"
          hint="Everything indexed here becomes retrievable knowledge — architecture notes, business context, runbooks. Import a repo's markdown to start."
          action={
            canManage ? (
              <button className="btn" onClick={() => setModal('import')}>
                Import from a repo
              </button>
            ) : undefined
          }
        />
      ) : null}

      {modal === 'write' ? (
        <WriteDocModal
          workspaceId={current.id}
          repos={repos}
          doc={null}
          configDir={configDir}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void refresh();
          }}
        />
      ) : null}
      {modal === 'import' ? (
        <ImportDocsModal
          workspaceId={current.id}
          repos={repos}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void refresh();
          }}
        />
      ) : null}
      {modal === 'generate' ? (
        <GenerateDocModal
          workspaceId={current.id}
          repos={repos}
          configDir={configDir}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

/** Live retrieval preview — the same query path agents and the assistant use. */
function RetrievalSearch({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<DocSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits(null);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .searchDocs(workspaceId, query)
        .then(({ hits }) => setHits(hits))
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, workspaceId]);

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <input
          className="input flex-1"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the knowledge index — see exactly what retrieval returns…"
          aria-label="Search documentation"
        />
        {busy ? <Spinner /> : null}
      </div>
      {hits !== null ? (
        <div className="mt-3 flex flex-col gap-2">
          {hits.length === 0 ? (
            <p className="dim text-[13px]">No indexed chunks match.</p>
          ) : (
            hits.map((h, i) => (
              <div key={`${h.docId}-${h.seq}-${i}`} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
                <div className="dim mb-1 flex items-center gap-2 text-[11px]">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">{h.title}</span>
                  {h.repo ? <span className="chip">{h.repo.split('/')[1] ?? h.repo}</span> : null}
                  <span>chunk {h.seq + 1}</span>
                </div>
                <p className="line-clamp-3 text-[13px] whitespace-pre-wrap">{h.content}</p>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Indexed docs are retrievable; a 0-chunk doc is invisible to search. */
function DocStateIcon({ indexed }: { indexed: boolean }): JSX.Element {
  const spec = indexed
    ? { label: 'Indexed for retrieval', cls: 'text-emerald-600 dark:text-emerald-400', glyph: 'M4.6 8.4l2 2 4-4.4' }
    : { label: 'Not indexed — search cannot find this doc', cls: 'text-amber-600 dark:text-amber-400', glyph: 'M8 4.6v4M8 11h.01' };
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

function DocCard({ doc, onChange }: { doc: DocRecord; onChange: () => Promise<void> }): JSX.Element {
  const { can } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const { current } = useWorkspace();

  const remove = async (): Promise<void> => {
    const ok = await confirmDanger({
      title: 'Delete documentation',
      message: `"${doc.title}" and its indexed chunks disappear from retrieval immediately.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api.deleteDoc(doc.id);
      await onChange();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <article className="card" aria-label={doc.title}>
      <div className="flex items-center gap-2.5">
        <DocStateIcon indexed={doc.chunkCount > 0} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{doc.title}</span>
            {doc.repo ? <span className="chip shrink-0">{doc.repo.split('/')[1] ?? doc.repo}</span> : null}
          </div>
          <div className="dim mt-0.5 truncate text-xs">
            {doc.source} · {doc.path ? <code className="font-mono text-[11px]">{doc.path}</code> : 'virtual'} ·{' '}
            {doc.chunkCount} {doc.chunkCount === 1 ? 'chunk' : 'chunks'} via {doc.embedder} · updated{' '}
            {timeAgo(doc.updatedAt)}
          </div>
        </div>
        <button className="linkish shrink-0 text-sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide' : 'Read'}
        </button>
      </div>

      {expanded ? (
        <div className="markdown mt-3 max-h-[32rem] overflow-y-auto rounded-lg bg-zinc-50 p-4 dark:bg-zinc-900">
          <Markdown text={doc.content} />
        </div>
      ) : null}
      {error ? <div className="error-bar">{error}</div> : null}

      {can('docs:manage') ? (
        <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
          <button className="btn-ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="btn-danger ml-auto" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      ) : null}

      {editing && current ? (
        <WriteDocModal
          workspaceId={current.id}
          repos={[]}
          doc={doc}
          configDir={null}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            void onChange();
          }}
        />
      ) : null}
      {confirmElement}
    </article>
  );
}

function WriteDocModal({
  workspaceId,
  repos,
  doc,
  configDir,
  onClose,
  onDone,
}: {
  workspaceId: string;
  repos: RepoRecord[];
  doc: DocRecord | null;
  /** Workspace docs directory; null = virtual-only (or editing, where storage is fixed). */
  configDir: string | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(doc?.title ?? '');
  const [repo, setRepo] = useState(doc?.repo ?? '');
  const [content, setContent] = useState(doc?.content ?? '');
  const [storage, setStorage] = useState<AreaStorage>(configDir ? 'repo' : 'virtual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (doc) await api.updateDoc(doc.id, { title: title.trim(), content });
      else {
        await api.createDoc(workspaceId, {
          repo: repo || null,
          title: title.trim(),
          content,
          // Repo storage only applies when the doc is about a repo.
          storage: repo ? storage : 'virtual',
        });
      }
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={doc ? `Edit doc — ${doc.title}` : 'New documentation'} onClose={onClose} wide>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <div className="flex gap-3 max-sm:flex-col">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="dim">Title</span>
            <input
              className="input"
              required
              minLength={3}
              maxLength={200}
              autoFocus={!doc}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Payments domain — business rules"
            />
          </label>
          {!doc ? (
            <label className="flex flex-col gap-1 text-sm sm:w-56">
              <span className="dim">About repo (optional)</span>
              <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
                <option value="">Workspace-wide</option>
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!doc && configDir && repo ? (
            <label className="flex flex-col gap-1 text-sm sm:w-52">
              <span className="dim">Storage</span>
              <select className="input" value={storage} onChange={(e) => setStorage(e.target.value as AreaStorage)}>
                <option value="repo">Repository — {configDir}/</option>
                <option value="virtual">Virtual (Companion only)</option>
              </select>
            </label>
          ) : null}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Content (markdown — chunked and indexed on save)</span>
          <textarea
            className="input min-h-80 w-full resize-y font-mono text-xs leading-relaxed"
            required
            autoFocus={doc !== null}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !title.trim() || !content.trim()}>
            {busy ? 'Saving…' : doc ? 'Save & reindex' : 'Create & index'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Pick a repo, tick its markdown files, import them as indexed docs. */
function ImportDocsModal({
  workspaceId,
  repos,
  onClose,
  onDone,
}: {
  workspaceId: string;
  repos: RepoRecord[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [repo, setRepo] = useState(repos.find((r) => r.cloneReady)?.fullName ?? repos[0]?.fullName ?? '');
  const [files, setFiles] = useState<RepoDocFile[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    setFiles(null);
    setSelected(new Set());
    setError(null);
    api
      .repoDocFiles(repo)
      .then(({ files }) => {
        setFiles(files);
        // Everything preselected — deselect what you don't want.
        setSelected(new Set(files.map((f) => f.path)));
      })
      .catch((err) => {
        setFiles([]);
        setError(String(err));
      });
  }, [repo]);

  const toggle = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.importRepoDocs(workspaceId, repo, [...selected]);
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Import markdown from a repo" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Repository (needs a finished clone)</span>
          <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
                {r.cloneReady ? '' : ' (clone pending)'}
              </option>
            ))}
          </select>
        </label>
        {files === null ? (
          <p className="dim text-[13px]">Scanning for markdown files…</p>
        ) : files.length === 0 ? (
          <p className="dim text-[13px]">No markdown files found in this repo's clone.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            {files.map((f) => (
              <label
                key={f.path}
                className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                <span className="dim shrink-0">{(f.size / 1024).toFixed(1)} kB</span>
              </label>
            ))}
          </div>
        )}
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || selected.size === 0} onClick={() => void submit()}>
            {busy ? 'Importing…' : `Import ${selected.size} ${selected.size === 1 ? 'file' : 'files'}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** An agent reads the repo and writes the doc — synchronous, like skill drafts. */
function GenerateDocModal({
  workspaceId,
  repos,
  configDir,
  onClose,
  onDone,
}: {
  workspaceId: string;
  repos: RepoRecord[];
  /** Workspace docs directory; null = virtual-only workspace. */
  configDir: string | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [repo, setRepo] = useState(repos.find((r) => r.cloneReady)?.fullName ?? '');
  const [instructions, setInstructions] = useState('');
  const [storage, setStorage] = useState<AreaStorage>(configDir ? 'repo' : 'virtual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.generateDoc(workspaceId, {
        repo: repo || undefined,
        instructions: instructions.trim(),
        storage: repo ? storage : 'virtual',
      });
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Generate documentation" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Source repo (the writer agent reads it; optional)</span>
          <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">None — write from the instructions alone</option>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
        {configDir && repo ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Storage</span>
            <select className="input" value={storage} onChange={(e) => setStorage(e.target.value as AreaStorage)}>
              <option value="repo">Repository — {configDir}/</option>
              <option value="virtual">Virtual (Companion only)</option>
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">✦ What should be documented?</span>
          <textarea
            className="input min-h-28"
            required
            autoFocus
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. the auth and session model end-to-end: roles, permissions, token lifecycle, where each is enforced"
          />
        </label>
        {busy ? (
          <div className="dim flex items-center gap-2 text-[13px]">
            <Spinner /> The agent is reading the repo and writing — this can take a few minutes…
          </div>
        ) : null}
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || instructions.trim().length < 8}>
            {busy ? 'Generating…' : 'Generate & index'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

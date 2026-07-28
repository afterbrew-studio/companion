import { useEffect, useState } from 'react';
import {
  CardActions,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  InlineLoading,
  ListFilterToolbar,
  Markdown,
  Modal,
  Page,
  PageHeader,
  Spinner,
  StatusGlyph,
  facet,
  timeAgo,
  useConfirm,
  useListFilter,
  type FilterSelectField,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { AreaStorage, DocRecord, DocSearchHit, RepoDocFile } from '../../contract/index.js';
import { planApi as api } from '../api.js';
import { useDocs } from '../hooks/useDocs.js';
import { AreaStorageSetup, StorageSummary } from '../components/AreaStorageSetup.js';

/**
 * Documentation for the active workspace: curated knowledge (architecture,
 * business context, runbooks) chunked and indexed by the built-in local-bm25
 * embedder so the assistant and agents can retrieve it. Docs come from three
 * places: written here, imported from a repo's markdown files, or drafted by
 * an agent that reads the codebase. The search box previews exactly what
 * retrieval returns.
 */
export function DocsPage(): JSX.Element {
  const { can } = useAuth();
  const { current, repos, docs, storage, error, refresh } = useDocs();
  const [configuring, setConfiguring] = useState(false);
  const [modal, setModal] = useState<'write' | 'import' | 'generate' | null>(null);

  const filterFields: Array<FilterSelectField<DocRecord>> = [
    {
      key: 'repo',
      label: 'Repository',
      allLabel: 'All docs',
      options: [
        { value: '__workspace', label: 'Workspace-wide' },
        ...facet(docs ?? [], (d) => d.repo).map((r) => ({ value: r, label: r })),
      ],
      match: (d, v) => (v === '__workspace' ? d.repo === null : d.repo === v),
    },
    {
      key: 'source',
      label: 'Source',
      allLabel: 'Any source',
      options: [
        { value: 'manual', label: 'Manual' },
        { value: 'imported', label: 'Imported' },
        { value: 'generated', label: 'Generated' },
      ],
      match: (d, v) => d.source === v,
    },
    {
      key: 'storage',
      label: 'Storage',
      allLabel: 'Any storage',
      options: [
        { value: 'virtual', label: 'Virtual' },
        { value: 'repo', label: 'Repository' },
      ],
      match: (d, v) => d.storage === v,
    },
  ];
  const filter = useListFilter(
    docs ?? [],
    (d, needle) => d.title.toLowerCase().includes(needle) || d.content.toLowerCase().includes(needle),
    filterFields,
  );
  const filtered = filter.filtered;

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
      <ErrorBar error={error} />

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

      {docs !== null && docs.length > 0 ? (
        <div className="mt-4">
          <ListFilterToolbar
            filter={filter}
            fields={filterFields}
            total={docs.length}
            placeholder="Filter docs by title or content…"
            searchLabel="Filter the documentation list"
          />
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {filtered.map((d) => (
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
      ) : docs !== null && filtered.length === 0 ? (
        <EmptyState title="No docs match" hint="Loosen the search or clear the filters." />
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
              <div key={`${h.docId}-${h.seq}-${i}`} className="well">
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
  return indexed ? (
    <StatusGlyph tone="ok" label="Indexed for retrieval" />
  ) : (
    <StatusGlyph tone="warn" label="Not indexed — search cannot find this doc" />
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
            {doc.source} · {doc.path ? <code className="code-inline">{doc.path}</code> : 'virtual'} ·{' '}
            {doc.chunkCount} {doc.chunkCount === 1 ? 'chunk' : 'chunks'} via {doc.embedder} · updated{' '}
            {timeAgo(doc.updatedAt)}
          </div>
        </div>
        <button className="linkish shrink-0 text-sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide' : 'Read'}
        </button>
      </div>

      {expanded ? (
        <div className="well markdown mt-3 max-h-[32rem] overflow-y-auto p-4">
          <Markdown text={doc.content} />
        </div>
      ) : null}
      <ErrorBar error={error} />

      {can('docs:manage') ? (
        <CardActions>
          <button className="btn-ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
          <span className="action-sep" aria-hidden />
          <button className="btn-danger-ghost" onClick={() => void remove()}>
            Delete
          </button>
        </CardActions>
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
          <Field label="Title" className="min-w-0 flex-1">
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
          </Field>
          {!doc ? (
            <Field label="About repo (optional)" className="sm:w-56">
              <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
                <option value="">Workspace-wide</option>
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {!doc && configDir && repo ? (
            <Field label="Storage" className="sm:w-52">
              <select className="input" value={storage} onChange={(e) => setStorage(e.target.value as AreaStorage)}>
                <option value="repo">Repository — {configDir}/</option>
                <option value="virtual">Virtual (Companion only)</option>
              </select>
            </Field>
          ) : null}
        </div>
        <Field label="Content (markdown — chunked and indexed on save)">
          <textarea
            className="input min-h-80 w-full resize-y font-mono text-xs leading-relaxed"
            required
            autoFocus={doc !== null}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </Field>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !title.trim() || !content.trim()}>
            {busy ? 'Saving…' : doc ? 'Save & reindex' : 'Create & index'}
          </button>
        </FormActions>
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
        <Field label="Repository (needs a finished clone)">
          <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
                {r.cloneReady ? '' : ' (clone pending)'}
              </option>
            ))}
          </select>
        </Field>
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
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || selected.size === 0} onClick={() => void submit()}>
            {busy ? 'Importing…' : `Import ${selected.size} ${selected.size === 1 ? 'file' : 'files'}`}
          </button>
        </FormActions>
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
        <Field label="Source repo (the writer agent reads it; optional)">
          <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">None — write from the instructions alone</option>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        </Field>
        {configDir && repo ? (
          <Field label="Storage">
            <select className="input" value={storage} onChange={(e) => setStorage(e.target.value as AreaStorage)}>
              <option value="repo">Repository — {configDir}/</option>
              <option value="virtual">Virtual (Companion only)</option>
            </select>
          </Field>
        ) : null}
        <Field label="✦ What should be documented?">
          <textarea
            className="input min-h-28"
            required
            autoFocus
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. the auth and session model end-to-end: roles, permissions, token lifecycle, where each is enforced"
          />
        </Field>
        {busy ? (
          <InlineLoading label="The agent is reading the repo and writing — this can take a few minutes…" />
        ) : null}
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || instructions.trim().length < 8}>
            {busy ? 'Generating…' : 'Generate & index'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

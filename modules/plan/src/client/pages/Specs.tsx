import { useState } from 'react';
import {
  EmptyState,
  ListFilterToolbar,
  Markdown,
  Modal,
  Page,
  PageHeader,
  Spinner,
  Tooltip,
  facet,
  timeAgo,
  useConfirm,
  useListFilter,
  type FilterSelectField,
} from '@companion/ui';
import { useAuth } from '@companion/module-core/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { AreaStorage, SpecRecord } from '../../contract/index.js';
import { planApi as api } from '../api.js';
import { useSpecs } from '../hooks/useSpecs.js';
import { AreaStorageSetup, StorageSummary } from '../components/AreaStorageSetup.js';

/**
 * Specifications for the active workspace: living markdown documents that pin
 * down how (part of) a repo should behave. Written by hand or drafted by an
 * agent that reads the actual codebase; one click turns a spec into a feature
 * (a proposal carrying the spec rides the normal analyze → implement flow).
 */
export function SpecsPage(): JSX.Element {
  const { current, repos, specs, storage, error, refresh } = useSpecs();
  const { can } = useAuth();
  const [configuring, setConfiguring] = useState(false);
  const [creating, setCreating] = useState<'write' | 'generate' | null>(null);

  const filterFields: Array<FilterSelectField<SpecRecord>> = [
    {
      key: 'repo',
      label: 'Repository',
      allLabel: 'All repositories',
      options: facet(specs ?? [], (s) => s.repo).map((r) => ({ value: r, label: r })),
      match: (s, v) => s.repo === v,
    },
    {
      key: 'status',
      label: 'Status',
      allLabel: 'Any status',
      options: [
        { value: 'ready', label: 'Ready' },
        { value: 'generating', label: 'Generating' },
        { value: 'failed', label: 'Failed' },
        { value: 'drifted', label: 'Drifted' },
      ],
      match: (s, v) => (v === 'drifted' ? s.driftNote !== null : s.status === v),
    },
    {
      key: 'source',
      label: 'Source',
      allLabel: 'Any source',
      options: [
        { value: 'manual', label: 'Manual' },
        { value: 'generated', label: 'Generated' },
        { value: 'imported', label: 'Imported' },
      ],
      match: (s, v) => s.source === v,
    },
    {
      key: 'storage',
      label: 'Storage',
      allLabel: 'Any storage',
      options: [
        { value: 'virtual', label: 'Virtual' },
        { value: 'repo', label: 'Repository' },
      ],
      match: (s, v) => s.storage === v,
    },
  ];
  const filter = useListFilter(
    specs ?? [],
    (s, needle) => s.title.toLowerCase().includes(needle) || s.content.toLowerCase().includes(needle),
    filterFields,
  );
  const filtered = filter.filtered;

  if (!current) return <EmptyState title="No workspace selected" />;
  const canManage = can('specs:manage');
  const needsSetup = storage !== null && storage.config === null;
  const configDir = storage?.config?.dir ?? null;

  return (
    <Page>
      <PageHeader
        title="Specifications"
        subtitle={current.name}
        actions={
          canManage && !needsSetup ? (
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={() => setCreating('generate')}>
                ✦ Generate from repo
              </button>
              <button className="btn" onClick={() => setCreating('write')}>
                New spec
              </button>
            </div>
          ) : undefined
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      {storage !== null && ((needsSetup && canManage) || configuring) ? (
        <AreaStorageSetup
          area="specifications"
          defaultDir="specs"
          state={storage}
          onSave={async (dir) => {
            await api.saveSpecsConfig(current.id, dir);
            setConfiguring(false);
            await refresh();
          }}
          onCancel={configuring ? () => setConfiguring(false) : undefined}
        />
      ) : storage?.config ? (
        <StorageSummary config={storage.config} canManage={canManage} onChange={() => setConfiguring(true)} />
      ) : null}

      {specs !== null && specs.length > 0 ? (
        <ListFilterToolbar
          filter={filter}
          fields={filterFields}
          total={specs.length}
          placeholder="Search title or content…"
          searchLabel="Search specifications"
        />
      ) : null}

      <div className="flex flex-col gap-3">
        {filtered.map((s) => (
          <SpecCard key={s.id} spec={s} onChange={refresh} />
        ))}
      </div>
      {specs !== null && specs.length === 0 ? (
        <EmptyState
          title="No specifications yet"
          hint="A spec pins down how something should behave — agents implement against it instead of guessing. Write one, or let an agent draft it from the codebase."
          action={
            canManage ? (
              <button className="btn" onClick={() => setCreating('generate')}>
                Generate the first spec
              </button>
            ) : undefined
          }
        />
      ) : specs !== null && filtered.length === 0 ? (
        <EmptyState title="No specs match" hint="Loosen the search or clear the filters." />
      ) : null}

      {creating ? (
        <SpecEditorModal
          mode={creating}
          repos={repos}
          configDir={configDir}
          onClose={() => setCreating(null)}
          onDone={() => {
            setCreating(null);
            void refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

/** Spinner while an agent drafts; colored glyph for the settled states. */
function SpecStateIcon({ status, drifted }: { status: SpecRecord['status']; drifted?: boolean }): JSX.Element {
  if (status === 'generating') {
    return (
      <Tooltip content="Agent is drafting this spec from the codebase">
        <Spinner />
      </Tooltip>
    );
  }
  const spec =
    status === 'failed'
      ? { label: 'Generation failed', cls: 'text-red-600 dark:text-red-400', glyph: 'm5.5 5.5 5 5M10.5 5.5l-5 5' }
      : drifted
        ? { label: 'Diverged from code since a merged PR', cls: 'text-amber-600 dark:text-amber-400', glyph: 'M8 4.6v4M8 11h.01' }
        : { label: 'Ready', cls: 'text-emerald-600 dark:text-emerald-400', glyph: 'M4.6 8.4l2 2 4-4.4' };
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

function SpecCard({ spec, onChange }: { spec: SpecRecord; onChange: () => Promise<void> }): JSX.Element {
  const { can } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [filing, setFiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();

  const remove = async (): Promise<void> => {
    const ok = await confirmDanger({
      title: 'Delete specification',
      message: `"${spec.title}" is removed permanently. Proposals already filed from it keep their copy.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api.deleteSpec(spec.id);
      await onChange();
    } catch (err) {
      setError(String(err));
    }
  };

  const dismissDrift = async (): Promise<void> => {
    try {
      await api.dismissSpecDrift(spec.id);
      await onChange();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <article className="card" aria-label={spec.title}>
      <div className="flex items-center gap-2.5">
        <SpecStateIcon status={spec.status} drifted={spec.driftNote !== null} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{spec.title}</div>
          <div className="dim mt-0.5 truncate text-xs">
            {spec.repo.split('/')[1] ?? spec.repo} · {spec.source} ·{' '}
            {spec.path ? <code className="font-mono text-[11px]">{spec.path}</code> : 'virtual'} · updated{' '}
            {timeAgo(spec.updatedAt)}
          </div>
        </div>
        {spec.status === 'ready' && spec.content ? (
          <button className="linkish shrink-0 text-sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide' : 'Read'}
          </button>
        ) : null}
      </div>

      {spec.driftNote ? (
        <div className="banner-warn mb-0">
          <span className="min-w-0 flex-1">Diverged from code — {spec.driftNote}</span>
          {can('specs:manage') ? (
            <button className="linkish shrink-0 text-sm" onClick={() => void dismissDrift()}>
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {expanded && spec.status === 'ready' && spec.content ? (
        <div className="markdown mt-3 max-h-[32rem] overflow-y-auto rounded-lg bg-zinc-50 p-4 dark:bg-zinc-900">
          <Markdown text={spec.content} />
        </div>
      ) : null}

      {error ? <div className="error-bar">{error}</div> : null}

      {(spec.status === 'ready' && can('proposals:create')) ||
      (can('specs:manage') && spec.status !== 'generating') ||
      spec.generateRunId ? (
        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
          {spec.status === 'ready' && can('proposals:create') ? (
            <button className="btn" onClick={() => setFiling(true)}>
              Create feature
            </button>
          ) : null}
          {can('specs:manage') && spec.status !== 'generating' ? (
            <button className="btn-ghost" onClick={() => setEditing(true)}>
              {spec.status === 'failed' ? 'Write by hand' : 'Edit'}
            </button>
          ) : null}
          {spec.generateRunId ? (
            <a className="btn-ghost" href={`#/runs/${spec.generateRunId}`}>
              Drafting run
            </a>
          ) : null}
          {can('specs:manage') && spec.status !== 'generating' ? (
            <>
              <span className="action-sep" aria-hidden />
              <button className="btn-danger-ghost" onClick={() => void remove()}>
                Delete
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <EditSpecModal
          spec={spec}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void onChange();
          }}
        />
      ) : null}
      {filing ? (
        <CreateFeatureModal
          spec={spec}
          onClose={() => setFiling(false)}
          onFiled={() => {
            setFiling(false);
            void onChange();
          }}
        />
      ) : null}
      {confirmElement}
    </article>
  );
}

function SpecEditorModal({
  mode,
  repos,
  configDir,
  onClose,
  onDone,
}: {
  mode: 'write' | 'generate';
  repos: RepoRecord[];
  /** Workspace specs directory; null = virtual-only workspace. */
  configDir: string | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [repo, setRepo] = useState(repos[0]?.fullName ?? '');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [instructions, setInstructions] = useState('');
  const [storage, setStorage] = useState<AreaStorage>(configDir ? 'repo' : 'virtual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'generate') {
        await api.generateSpec(repo, instructions.trim(), storage);
      } else {
        await api.createSpec(repo, title.trim(), content, storage);
      }
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={mode === 'generate' ? 'Generate spec from repo' : 'New specification'} onClose={onClose} wide={mode === 'write'}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <div className="flex gap-3 max-sm:flex-col">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="dim">Repository</span>
            <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)} required>
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </label>
          {configDir ? (
            <label className="flex flex-col gap-1 text-sm sm:w-52">
              <span className="dim">Storage</span>
              <select className="input" value={storage} onChange={(e) => setStorage(e.target.value as AreaStorage)}>
                <option value="repo">Repository — {configDir}/</option>
                <option value="virtual">Virtual (Companion only)</option>
              </select>
            </label>
          ) : null}
        </div>
        {mode === 'generate' ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">✦ What should the spec cover?</span>
            <textarea
              className="input min-h-28"
              required
              autoFocus
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. how CSV export should work across the reports screens — current behavior, desired behavior, edge cases"
            />
          </label>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="dim">Title</span>
              <input
                className="input"
                required
                minLength={3}
                maxLength={200}
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Reports CSV export"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="dim">Specification (markdown)</span>
              <textarea
                className="input min-h-72 w-full resize-y font-mono text-xs leading-relaxed"
                required
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </label>
          </>
        )}
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="submit"
            disabled={busy || !repo || (mode === 'generate' ? instructions.trim().length < 8 : !title.trim() || !content.trim())}
          >
            {busy ? 'Working…' : mode === 'generate' ? 'Generate spec' : 'Create spec'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditSpecModal({
  spec,
  onClose,
  onSaved,
}: {
  spec: SpecRecord;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(spec.title);
  const [content, setContent] = useState(spec.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateSpec(spec.id, { title: title.trim(), content });
      onSaved();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit spec — ${spec.title}`} onClose={onClose} wide>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Title</span>
          <input
            className="input"
            required
            minLength={3}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Specification (markdown)</span>
          <textarea
            className="input min-h-80 w-full resize-y font-mono text-xs leading-relaxed"
            required
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
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Spec → feature: file a proposal carrying the spec; analysis starts immediately. */
function CreateFeatureModal({
  spec,
  onClose,
  onFiled,
}: {
  spec: SpecRecord;
  onClose: () => void;
  onFiled: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(spec.title);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { proposal } = await api.createFeatureFromSpec(spec.id, {
        title: title.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setFiled(proposal.id);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  if (filed) {
    return (
      <Modal title="Feature filed" onClose={onFiled}>
        <p className="text-sm">
          The proposal is filed and its feasibility analysis is running. Follow it in{' '}
          <a className="linkish" href="#/proposals" onClick={onFiled}>
            Proposals
          </a>
          .
        </p>
        <div className="mt-4 flex justify-end">
          <button className="btn" onClick={onFiled}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Create feature from spec — ${spec.title}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <p className="dim text-[13px]">
          Files a proposal carrying the full specification as implementation context, then starts the
          feasibility analysis — the normal approve → implement flow takes it from there.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Feature title</span>
          <input
            className="input"
            required
            minLength={3}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Scoping notes (optional — they override the spec where they conflict)</span>
          <textarea
            className="input min-h-24"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. only the first two sections for now; skip the admin surface"
          />
        </label>
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !title.trim()}>
            {busy ? 'Filing…' : 'File & analyze'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

import { useState } from 'react';
import {
  CardActions,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  ListFilterToolbar,
  Markdown,
  Modal,
  Page,
  PageHeader,
  Spinner,
  StatusGlyph,
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
      <ErrorBar error={error} />

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
          workspaceId={current.id}
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
  if (status === 'failed') return <StatusGlyph tone="danger" label="Generation failed" />;
  if (drifted) return <StatusGlyph tone="warn" label="Diverged from code since a merged PR" />;
  return <StatusGlyph tone="ok" label="Ready" />;
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
            {spec.path ? <code className="code-inline">{spec.path}</code> : 'virtual'} · updated{' '}
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
        <div className="well markdown mt-3 max-h-[32rem] overflow-y-auto p-4">
          <Markdown text={spec.content} />
        </div>
      ) : null}

      <ErrorBar error={error} />

      {(spec.status === 'ready' && can('proposals:create')) ||
      (can('specs:manage') && spec.status !== 'generating') ||
      spec.generateRunId ? (
        <CardActions>
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
        </CardActions>
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
  workspaceId,
  repos,
  configDir,
  onClose,
  onDone,
}: {
  mode: 'write' | 'generate';
  workspaceId: string;
  repos: RepoRecord[];
  /** Workspace specs directory; null = virtual-only workspace. */
  configDir: string | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [repo, setRepo] = useState(repos.find((candidate) => candidate.githubAccessible)?.fullName ?? '');
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
        await api.generateSpec(workspaceId, repo, instructions.trim(), storage);
      } else {
        await api.createSpec(workspaceId, repo, title.trim(), content, storage);
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
          <Field label="Repository" className="min-w-0 flex-1">
            <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)} required>
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName} disabled={!r.githubAccessible}>
                  {r.fullName}
                  {r.githubAccessible ? '' : ' — access required'}
                </option>
              ))}
            </select>
          </Field>
          {configDir ? (
            <Field label="Storage" className="sm:w-52">
              <select className="input" value={storage} onChange={(e) => setStorage(e.target.value as AreaStorage)}>
                <option value="repo">Repository — {configDir}/</option>
                <option value="virtual">Virtual (Companion only)</option>
              </select>
            </Field>
          ) : null}
        </div>
        {mode === 'generate' ? (
          <Field label="✦ What should the spec cover?">
            <textarea
              className="input min-h-28"
              required
              autoFocus
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. how CSV export should work across the reports screens — current behavior, desired behavior, edge cases"
            />
          </Field>
        ) : (
          <>
            <Field label="Title">
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
            </Field>
            <Field label="Specification (markdown)">
              <textarea
                className="input min-h-72 w-full resize-y font-mono text-xs leading-relaxed"
                required
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </Field>
          </>
        )}
        <ErrorBar error={error} />
        <FormActions>
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
        </FormActions>
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
        <Field label="Title">
          <input
            className="input"
            required
            minLength={3}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Specification (markdown)">
          <textarea
            className="input min-h-80 w-full resize-y font-mono text-xs leading-relaxed"
            required
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
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

/** Spec → Ideas: open the guided planner with the specification prefilled. */
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
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const idea = [
      `Plan and implement the feature described by the existing specification "${title.trim() || spec.title}".`,
      notes.trim() ? `Additional scope:\n${notes.trim()}` : '',
      `Specification:\n${spec.content}`,
    ].filter(Boolean).join('\n\n').slice(0, 8_000);
    sessionStorage.setItem('companion.idea.prefill', JSON.stringify({ repo: spec.repo, idea }));
    onFiled();
    window.location.hash = '/ideas';
  };

  return (
    <Modal title={`Create feature from spec — ${spec.title}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="dim text-[13px]">
          Opens Ideas with this specification prefilled. The guided planner confirms scope, builds the
          remaining artifacts, prepares tasks and asks before any agent starts coding.
        </p>
        <Field label="Feature title">
          <input
            className="input"
            required
            minLength={3}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Scoping notes (optional — they override the spec where they conflict)">
          <textarea
            className="input min-h-24"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. only the first two sections for now; skip the admin surface"
          />
        </Field>
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={!title.trim()}>
            Continue in Ideas
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

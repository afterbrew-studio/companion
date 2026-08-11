import { useEffect, useRef, useState } from 'react';
import { runIntent, useIntent, useModuleEnabled } from '@moxxy/companion-sdk/client';
import {
  AiActionMenu,
  CardActions,
  EmptyState,
  ErrorBar,
  Field,
  FilterField,
  FiltersPopover,
  FormActions,
  InlineLoading,
  ListFooter,
  Markdown,
  Modal,
  Page,
  PageHeader,
  Spinner,
  StatusGlyph,
  Tooltip,
  timeAgo,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { AreaStorage, SpecListRecord, SpecRecord } from '../../contract/index.js';
import { planApi as api } from '../api.js';
import { useSpecs } from '../hooks/useSpecs.js';
import { AreaStorageSetup, StorageSummary } from '../components/AreaStorageSetup.js';
import { KnowledgeToolbar } from '../components/KnowledgeToolbar.js';

/**
 * Specifications for the active workspace: living markdown documents that pin
 * down how (part of) a repo should behave. Written by hand or drafted by an
 * agent that reads the actual codebase; one click turns a spec into a feature
 * (a proposal carrying the spec rides the normal analyze → implement flow).
 */
export function SpecsPage(): React.JSX.Element {
  const {
    current,
    repos,
    specs,
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
    storage,
    error,
    refresh,
  } = useSpecs();
  const { can } = useAuth();
  const [configuring, setConfiguring] = useState(false);
  const [creating, setCreating] = useState<'write' | 'generate' | null>(null);
  const canManage = can('specs:manage');

  useIntent('new-spec', () => {
    if (canManage) setCreating('write');
  });

  if (!current) {
    return (
      <Page>
        <PageHeader title="Specifications" subtitle="Reviewed behavior and requirements" />
        <EmptyState
          title="Create a workspace first"
          hint="Specifications stay with a workspace so agents and maintainers share the same scope."
          action={
            can('workspaces:create') ? (
              <button className="btn" onClick={() => runIntent('new-workspace')}>Create workspace</button>
            ) : undefined
          }
        />
      </Page>
    );
  }
  const canGenerate = canManage && can('runs:read') && can('runs:act');
  const configDir = storage?.config?.dir ?? null;

  return (
    <Page>
      <PageHeader
        title="Specifications"
        subtitle={current.name}
        actions={
          canManage ? (
            <div className="flex gap-2">
              {canGenerate ? (
                <AiActionMenu
                  label="Draft a specification with AI"
                  actions={[{ label: 'Generate from repository with AI', onSelect: () => setCreating('generate') }]}
                />
              ) : null}
              <button className="btn" onClick={() => setCreating('write')}>
                New spec
              </button>
            </div>
          ) : undefined
        }
      />
      <ErrorBar error={error} />

      {storage !== null && configuring ? (
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
      ) : null}

      <KnowledgeToolbar
        search={search}
        onSearch={setSearch}
        ariaLabel="Search specifications by title or content"
        leading={
          storage !== null ? (
            <StorageSummary config={storage.config} canManage={canManage} onChange={() => setConfiguring(true)} />
          ) : undefined
        }
      >
        <FiltersPopover active={activeFilters} onClear={clearFilters}>
          <FilterField label="Repository">
            <select className="input" value={filters.repo} onChange={(event) => setFilter('repo')(event.target.value)}>
              <option value="all">All repositories</option>
              {repos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Status">
            <select className="input" value={filters.status} onChange={(event) => setFilter('status')(event.target.value)}>
              <option value="all">Any status</option>
              <option value="ready">Ready</option>
              <option value="generating">Generating</option>
              <option value="failed">Failed</option>
              <option value="drifted">Drifted</option>
            </select>
          </FilterField>
          <FilterField label="Source">
            <select className="input" value={filters.source} onChange={(event) => setFilter('source')(event.target.value)}>
              <option value="all">Any source</option>
              <option value="manual">Manual</option>
              <option value="generated">Generated</option>
              <option value="imported">Imported</option>
            </select>
          </FilterField>
          <FilterField label="Storage">
            <select className="input" value={filters.storage} onChange={(event) => setFilter('storage')(event.target.value)}>
              <option value="all">Any storage</option>
              <option value="virtual">Virtual</option>
              <option value="repo">Repository</option>
            </select>
          </FilterField>
        </FiltersPopover>
      </KnowledgeToolbar>

      {specs === null ? (
        <InlineLoading label="Loading specifications…" />
      ) : specs.length > 0 ? (
        <>
          <div className="flex flex-col gap-3">
            {specs.map((spec) => (
              <SpecCard key={spec.id} spec={spec} onChange={refresh} />
            ))}
          </div>
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={specs.length}
            total={total}
            noun="specifications"
            onVisible={loadMore}
          />
        </>
      ) : !error && (search.trim() !== '' || activeFilters > 0) ? (
        <EmptyState title="No specs match" hint="Loosen the search or clear the filters." />
      ) : !error ? (
        <EmptyState
          title="No specifications yet"
          hint="A spec pins down how something should behave — agents implement against it instead of guessing. Write one, or let an agent draft it from the codebase."
        />
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
function SpecStateIcon({ status, drifted }: { status: SpecListRecord['status']; drifted?: boolean }): React.JSX.Element {
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

function SpecCard({ spec, onChange }: { spec: SpecListRecord; onChange: () => Promise<void> }): React.JSX.Element {
  const { can } = useAuth();
  const canReadRuns = can('runs:read');
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [filing, setFiling] = useState(false);
  const [detail, setDetail] = useState<SpecRecord | null>(null);
  const [detailIntent, setDetailIntent] = useState<'read' | 'edit' | 'file' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detailSeq = useRef(0);
  const { confirmDanger, confirmElement } = useConfirm();

  useEffect(() => {
    detailSeq.current += 1;
    setDetail(null);
    setDetailIntent(null);
    setExpanded(false);
    setEditing(false);
    setFiling(false);
  }, [spec.id, spec.updatedAt]);

  const loadDetail = async (intent: 'read' | 'edit' | 'file'): Promise<SpecRecord | null> => {
    if (detail) return detail;
    const mySeq = ++detailSeq.current;
    setDetailIntent(intent);
    setError(null);
    try {
      const response = await api.getSpec(spec.id);
      if (detailSeq.current !== mySeq) return null;
      setDetail(response.spec);
      return response.spec;
    } catch (err) {
      if (detailSeq.current === mySeq) setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (detailSeq.current === mySeq) setDetailIntent(null);
    }
  };

  const toggleRead = async (): Promise<void> => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (await loadDetail('read')) setExpanded(true);
  };

  const startEdit = async (): Promise<void> => {
    if (await loadDetail('edit')) setEditing(true);
  };

  const startFiling = async (): Promise<void> => {
    if (await loadDetail('file')) setFiling(true);
  };

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
        {spec.status === 'ready' && spec.contentLength > 0 ? (
          <button
            className="linkish shrink-0 text-sm"
            disabled={detailIntent !== null}
            onClick={() => void toggleRead()}
          >
            {detailIntent === 'read' ? 'Loading…' : expanded ? 'Hide' : 'Read'}
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

      {expanded && detail && spec.status === 'ready' ? (
        <div className="well markdown mt-3 max-h-[32rem] overflow-y-auto p-4">
          <Markdown text={detail.content} />
        </div>
      ) : null}

      <ErrorBar error={error} />

      {(spec.status === 'ready' && can('proposals:create')) ||
      (can('specs:manage') && spec.status !== 'generating') ||
      (spec.generateRunId && canReadRuns) ? (
        <CardActions>
          {spec.status === 'ready' && can('proposals:create') ? (
            <button className="btn" disabled={detailIntent !== null} onClick={() => void startFiling()}>
              {detailIntent === 'file' ? 'Loading…' : 'Create feature'}
            </button>
          ) : null}
          {can('specs:manage') && spec.status !== 'generating' ? (
            <button className="btn-ghost" disabled={detailIntent !== null} onClick={() => void startEdit()}>
              {detailIntent === 'edit' ? 'Loading…' : spec.status === 'failed' ? 'Write by hand' : 'Edit'}
            </button>
          ) : null}
          {spec.generateRunId && canReadRuns ? (
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

      {editing && detail ? (
        <EditSpecModal
          spec={detail}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void onChange();
          }}
        />
      ) : null}
      {filing && detail ? (
        <CreateFeatureModal
          spec={detail}
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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

/** Spec → feature: hand off to the guided planner when present, else file the proposal directly. */
function CreateFeatureModal({
  spec,
  onClose,
  onFiled,
}: {
  spec: SpecRecord;
  onClose: () => void;
  onFiled: () => void;
}): React.JSX.Element {
  // planner owns #/ideas and may be absent from the build; without it, plan's
  // own create-feature route files the proposal and starts its analysis.
  const plannerEnabled = useModuleEnabled('planner');
  const [title, setTitle] = useState(spec.title);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (plannerEnabled) {
      const idea = [
        `Plan and implement the feature described by the existing specification "${title.trim() || spec.title}".`,
        notes.trim() ? `Additional scope:\n${notes.trim()}` : '',
        `Specification:\n${spec.content}`,
      ].filter(Boolean).join('\n\n').slice(0, 8_000);
      sessionStorage.setItem('companion.idea.prefill', JSON.stringify({ repo: spec.repo, idea }));
      onFiled();
      window.location.hash = '/ideas';
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createFeatureFromSpec(spec.id, {
        title: title.trim() || spec.title,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onFiled();
      window.location.hash = '/legacy-proposals';
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Create feature from spec — ${spec.title}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <p className="dim text-[13px]">
          {plannerEnabled
            ? 'Opens Ideas with this specification prefilled. The guided planner confirms scope, builds the remaining artifacts, prepares tasks and asks before any agent starts coding.'
            : 'Files a proposal that embeds this specification as the source of truth and starts its feasibility analysis right away.'}
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
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !title.trim()}>
            {plannerEnabled ? 'Continue in Ideas' : busy ? 'Filing…' : 'Create feature'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

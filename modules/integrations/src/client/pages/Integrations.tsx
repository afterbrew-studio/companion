import { useEffect, useMemo, useState } from 'react';
import type { Permission } from '@moxxy/companion-contracts';
import { Slot } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import {
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  MetaSignal,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  Section,
  SegmentedControl,
  Switch,
  timeAgo,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import type {
  IntegrationCategory,
  IntegrationConfigField,
  IntegrationConnectionDraft,
  IntegrationConnectionRecord,
  IntegrationFieldValue,
  EffectiveIntegrationRoute,
  IntegrationProviderDescriptor,
  IntegrationScope,
  IntegrationTargetRef,
} from '../../contract/index.js';
import { integrationsApi } from '../api.js';
import { useIntegrations } from '../hooks/useIntegrations.js';
import { decodeIntegrationTarget, encodeIntegrationTarget, reviewTargetOptions } from '../review-targets.js';

const CATEGORY_LABELS: Record<string, string> = {
  review: 'Code review',
  communication: 'Communication',
  'project-management': 'Project management',
  'developer-tools': 'Developer tools',
};

export function IntegrationsPage(): JSX.Element {
  const { can } = useAuth();
  const { current } = useWorkspace();
  const state = useIntegrations();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<IntegrationCategory | 'all'>('all');
  const [editing, setEditing] = useState<{
    provider: IntegrationProviderDescriptor;
    connection?: IntegrationConnectionRecord;
  } | null>(null);
  const [reviewRoute, setReviewRoute] = useState<EffectiveIntegrationRoute | null>(null);
  const [primary, setPrimary] = useState('');
  const [fallback, setFallback] = useState('');
  const [routeError, setRouteError] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const reviewScope: IntegrationScope = current
    ? { kind: 'workspace', workspaceId: current.id }
    : { kind: 'instance' };
  const reviewScopeKey = JSON.stringify(reviewScope);

  const providers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (state.catalog?.providers ?? []).filter(
      (provider) =>
        (category === 'all' || provider.category === category) &&
        (!needle ||
          `${provider.vendor} ${provider.title} ${provider.description} ${provider.capabilities.join(' ')}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [state.catalog, query, category]);
  const reviewOptions = useMemo(
    () => reviewTargetOptions(
      state.catalog?.providers ?? [],
      state.catalog?.connections ?? [],
      reviewScope,
      true,
    ),
    [state.catalog, reviewScopeKey],
  );

  useEffect(() => {
    setReviewRoute(null);
    setPrimary('');
    setFallback('');
  }, [reviewScopeKey]);

  useEffect(() => {
    if (!state.catalog) return;
    let live = true;
    void integrationsApi
      .route('code-review', reviewScope)
      .then(({ route }) => {
        if (!live) return;
        setReviewRoute(route);
        setPrimary(route.targets[0] ? encodeIntegrationTarget(route.targets[0]) : '');
        setFallback(route.targets[1] ? encodeIntegrationTarget(route.targets[1]) : '');
        setRouteError(null);
      })
      .catch((error) => {
        if (live) setRouteError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [state.catalog, reviewScopeKey]);

  if (!state.catalog) return state.error ? <Page><ErrorBar error={state.error} /></Page> : <PageLoading label="Loading integrations…" />;

  // This page configures instance + current-workspace defaults. Repository
  // connections have their own focused surface, and connections from another
  // workspace must not be edited against the currently selected workspace.
  const pageConnections = state.catalog.connections.filter(
    (connection) =>
      connection.scope.kind === 'instance' ||
      (connection.scope.kind === 'workspace' && connection.scope.workspaceId === current?.id),
  );
  const availableProviderIds = new Set(state.catalog.providers.map((provider) => provider.id));
  const unavailableConnections = pageConnections.filter(
    (connection) => !availableProviderIds.has(connection.providerId),
  );
  const connected = pageConnections.filter(
    (connection) => connection.enabled && availableProviderIds.has(connection.providerId),
  ).length;
  const attention = pageConnections.filter(
    (connection) =>
      !availableProviderIds.has(connection.providerId) ||
      connection.health.status === 'unavailable' ||
      connection.health.status === 'degraded',
  ).length;
  const categories = [...new Set(state.catalog.providers.map((provider) => provider.category))];

  return (
    <Page>
      <PageHeader
        title="Integrations"
        subtitle="Connect specialist tools once, then route their capabilities where your teams work"
        actions={<Slot name="integrations.page.actions" can={can} />}
      />
      <ErrorBar error={state.error} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <SummaryStat label="Providers available" value={state.catalog.providers.length} />
        <SummaryStat label="Connections enabled" value={connected} tone={connected > 0 ? 'green' : 'zinc'} />
        <SummaryStat label="Needs attention" value={attention} tone={attention > 0 ? 'amber' : 'zinc'} />
      </div>

      <Section
        title="Default code review route"
        description={current
          ? `Used by repositories in ${current.name} until a repository overrides it.`
          : 'Used instance-wide until a workspace or repository overrides it.'}
      >
        <div className="card flex flex-col gap-4">
          <ErrorBar error={routeError} />
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Primary reviewer</span>
              <select
                className="input"
                value={primary}
                onChange={(event) => {
                  setPrimary(event.target.value);
                  if (!event.target.value) setFallback('');
                }}
                disabled={!can('integrations:manage') || !reviewRoute}
              >
                <option value="">Use inherited platform default</option>
                {primary && !reviewOptions.some((option) => option.value === primary) ? (
                  <option value={primary}>Unavailable · {routeTargetName(primary, state.catalog.connections)}</option>
                ) : null}
                {reviewOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Unavailable fallback</span>
              <select
                className="input"
                value={fallback}
                onChange={(event) => setFallback(event.target.value)}
                disabled={!can('integrations:manage') || !reviewRoute || !primary}
              >
                <option value="">No fallback</option>
                {fallback && !reviewOptions.some((option) => option.value === fallback) ? (
                  <option value={fallback}>Unavailable · {routeTargetName(fallback, state.catalog.connections)}</option>
                ) : null}
                {reviewOptions
                  .filter((option) => option.value !== primary)
                  .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <MetaSignal
              tone={reviewRoute?.sourceScope?.kind === reviewScope.kind ? 'green' : 'zinc'}
              label={reviewRoute?.sourceScope
                ? reviewRoute.sourceScope.kind === reviewScope.kind
                  ? `${reviewScope.kind} override`
                  : `inherited from ${reviewRoute.sourceScope.kind}`
                : 'platform default'}
            />
            <span className="dim text-xs">Fallback runs only when the primary is unavailable, never after a real review failure.</span>
            <span className="flex-1" />
            {can('integrations:manage') ? (
              <button
                className="btn"
                disabled={state.busy !== null || !reviewRoute}
                onClick={() => void (async () => {
                  const targets: IntegrationTargetRef[] = [];
                  const first = decodeIntegrationTarget(primary, undefined, state.catalog!.connections);
                  const second = decodeIntegrationTarget(fallback, undefined, state.catalog!.connections);
                  if (first) targets.push(first);
                  if (first && second && encodeIntegrationTarget(second) !== encodeIntegrationTarget(first)) {
                    targets.push(second);
                  }
                  try {
                    await state.setRoute('code-review', reviewScope, targets);
                  } catch (error) {
                    setRouteError(error instanceof Error ? error.message : String(error));
                  }
                })()}
              >
                {state.busy?.startsWith('route:') ? 'Saving…' : 'Save route'}
              </button>
            ) : null}
          </div>
        </div>
      </Section>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <input
          className="input min-w-52 flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search providers and capabilities…"
          aria-label="Search integrations"
        />
        <div className="flex flex-wrap gap-1" aria-label="Integration category">
          <FilterButton selected={category === 'all'} onClick={() => setCategory('all')}>All</FilterButton>
          {categories.map((value) => (
            <FilterButton key={value} selected={category === value} onClick={() => setCategory(value)}>
              {CATEGORY_LABELS[value] ?? value}
            </FilterButton>
          ))}
        </div>
      </div>

      {providers.length === 0 ? (
        <EmptyState title="No matching integrations" hint="Clear the search or choose another capability group." />
      ) : (
        <div className="card divide-y divide-zinc-200 overflow-hidden p-0 dark:divide-zinc-800">
          {providers.map((provider) => {
            const connections = pageConnections.filter((connection) => connection.providerId === provider.id);
            return (
              <ProviderCard
                key={provider.id}
                provider={provider}
                connections={connections}
                can={can}
                canManage={can('integrations:manage')}
                canSelf={can('integrations:self')}
                workspaceName={current?.name ?? null}
                canConnectHere={
                  provider.scopes.includes('instance') ||
                  (!!current && provider.scopes.includes('workspace'))
                }
                busy={state.busy}
                onConnect={() => setEditing({ provider })}
                onEdit={(connection) => setEditing({ provider, connection })}
                onToggle={(connection, enabled) =>
                  void state.update(connection.id, { enabled }, connection.ownerId !== null).catch(() => undefined)
                }
                onTest={(connection) =>
                  void state.test(connection.id, connection.ownerId !== null).catch(() => undefined)
                }
                onRemove={(connection) =>
                  void (async () => {
                    const ok = await confirmDanger({
                      title: `Remove “${connection.name}”?`,
                      message: 'Its credentials are deleted and any routing fallback that points to it is removed.',
                      confirmLabel: 'Remove connection',
                    });
                    if (ok) await state.remove(connection.id, connection.ownerId !== null);
                  })().catch(() => undefined)
                }
              />
            );
          })}
        </div>
      )}

      {unavailableConnections.length > 0 ? (
        <Section
          title="Provider unavailable"
          description="These credentials are preserved while their provider module is disabled. Re-enable the module to use or edit them, or remove the connection here."
        >
          <div className="card divide-y divide-zinc-200 overflow-hidden p-0 dark:divide-zinc-800">
            {unavailableConnections.map((connection) => {
              const manageable = connection.ownerId !== null
                ? can('integrations:self')
                : can('integrations:manage');
              return (
                <div key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{connection.name}</strong>
                      <MetaSignal tone="amber" label="provider disabled" />
                      {connection.ownerId ? <MetaSignal tone="zinc" label="just you" /> : null}
                    </div>
                    <p className="dim mt-1 text-xs">
                      {connection.providerId} · {scopeLabel(connection.scope, current?.name)}
                    </p>
                  </div>
                  {manageable ? (
                    <button
                      className="btn-ghost text-red-600 dark:text-red-400"
                      disabled={state.busy !== null}
                      onClick={() => void (async () => {
                        const ok = await confirmDanger({
                          title: `Remove “${connection.name}”?`,
                          message: 'Its preserved credentials and any routing references are deleted.',
                          confirmLabel: 'Remove connection',
                        });
                        if (ok) await state.remove(connection.id, connection.ownerId !== null);
                      })().catch(() => undefined)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}

      {editing ? (
        <ConnectionModal
          provider={editing.provider}
          connection={editing.connection}
          can={can}
          workspaceId={current?.id ?? null}
          canManage={can('integrations:manage')}
          canSelf={can('integrations:self')}
          busy={state.busy !== null}
          onClose={() => setEditing(null)}
          onCreate={async (draft, personal) => {
            await state.create(draft, personal);
            setEditing(null);
          }}
          onUpdate={async (connection, input) => {
            await state.update(connection.id, input, connection.ownerId !== null);
            setEditing(null);
          }}
        />
      ) : null}
      {confirmElement}
    </Page>
  );
}

function SummaryStat({ label, value, tone = 'zinc' }: { label: string; value: number; tone?: 'zinc' | 'green' | 'amber' }): JSX.Element {
  const color = tone === 'green' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : '';
  return (
    <div className="card flex items-baseline justify-between gap-3 py-3">
      <span className="dim text-xs">{label}</span>
      <strong className={`text-xl tabular-nums ${color}`}>{value}</strong>
    </div>
  );
}

function FilterButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button className={selected ? 'btn' : 'btn-ghost'} onClick={onClick} aria-pressed={selected}>
      {children}
    </button>
  );
}

function ProviderCard({
  provider,
  connections,
  can,
  canManage,
  canSelf,
  workspaceName,
  canConnectHere,
  busy,
  onConnect,
  onEdit,
  onToggle,
  onTest,
  onRemove,
}: {
  provider: IntegrationProviderDescriptor;
  connections: readonly IntegrationConnectionRecord[];
  can: (permission: Permission) => boolean;
  canManage: boolean;
  canSelf: boolean;
  workspaceName: string | null;
  canConnectHere: boolean;
  busy: string | null;
  onConnect: () => void;
  onEdit: (connection: IntegrationConnectionRecord) => void;
  onToggle: (connection: IntegrationConnectionRecord, enabled: boolean) => void;
  onTest: (connection: IntegrationConnectionRecord) => void;
  onRemove: (connection: IntegrationConnectionRecord) => void;
}): JSX.Element {
  const canConnect =
    canConnectHere &&
    provider.connectionMode !== 'none' &&
    (canManage || (canSelf && provider.supportsPersonal));
  return (
    <section aria-label={provider.title}>
      <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            {provider.vendor.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">{provider.title}</h2>
              <MetaSignal tone="zinc" label={provider.execution} />
              {provider.connectionMode === 'none' ? <MetaSignal tone="green" label="built in" /> : null}
            </div>
            <p className="dim mt-1 text-sm leading-relaxed">{provider.description}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {provider.capabilities.map((capability) => (
                <span className="chip" key={capability}>{capability.replace('-', ' ')}</span>
              ))}
            </div>
            <Slot name={`integrations.provider.${provider.id}.panel`} can={can} props={{ providerId: provider.id }} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {provider.connectionMode === 'none' ? (
            <MetaSignal tone="green" label="Ready" />
          ) : connections.length > 0 ? (
            <MetaSignal
              tone={connections.some((connection) => connection.enabled) ? 'green' : 'zinc'}
              label={`${connections.filter((connection) => connection.enabled).length}/${connections.length} enabled`}
            />
          ) : (
            <MetaSignal tone="zinc" label="Not connected" />
          )}
          {provider.docsUrl ? (
            <a className="btn-ghost" href={provider.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a>
          ) : null}
          {canConnect ? <button className="btn" onClick={onConnect}>Connect</button> : null}
        </div>
      </div>

      {connections.length > 0 ? (
        <div className="border-t border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/30">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              provider={provider}
              connection={connection}
              can={can}
              workspaceName={workspaceName}
              manage={connection.ownerId !== null ? canSelf : canManage}
              busy={busy === connection.id}
              onEdit={() => onEdit(connection)}
              onToggle={(enabled) => onToggle(connection, enabled)}
              onTest={() => onTest(connection)}
              onRemove={() => onRemove(connection)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ConnectionRow({
  provider,
  connection,
  can,
  workspaceName,
  manage,
  busy,
  onEdit,
  onToggle,
  onTest,
  onRemove,
}: {
  provider: IntegrationProviderDescriptor;
  connection: IntegrationConnectionRecord;
  can: (permission: Permission) => boolean;
  workspaceName: string | null;
  manage: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onRemove: () => void;
}): JSX.Element {
  const healthTone = connection.health.status === 'ready' ? 'green' : connection.health.status === 'degraded' ? 'amber' : connection.health.status === 'unavailable' ? 'red' : 'zinc';
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 not-last:border-b not-last:border-zinc-200 dark:not-last:border-zinc-800">
      <div className="min-w-48 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{connection.name}</span>
          {connection.ownerId ? <MetaSignal tone="zinc" label="just you" /> : null}
          <MetaSignal tone={healthTone} label={connection.health.status} title={connection.health.message} />
        </div>
        <p className="dim mt-1 text-xs">
          {scopeLabel(connection.scope, workspaceName ?? undefined)}
          {connection.health.checkedAt ? ` · checked ${timeAgo(connection.health.checkedAt)}` : ''}
        </p>
      </div>
      <Slot
        name={`integrations.connection.${provider.id}.actions`}
        can={can}
        props={{ providerId: provider.id, connectionId: connection.id }}
      />
      {manage ? (
        <div className="flex items-center gap-1.5">
          <button className="btn-ghost" disabled={busy} onClick={onTest}>Test</button>
          <button className="btn-ghost" disabled={busy} onClick={onEdit}>Edit</button>
          <Switch checked={connection.enabled} onChange={onToggle} disabled={busy} label={`Enable ${connection.name}`} />
          <button className="btn-ghost text-red-600 dark:text-red-400" disabled={busy} onClick={onRemove}>Remove</button>
        </div>
      ) : null}
    </div>
  );
}

export function ConnectionModal({
  provider,
  connection,
  can,
  workspaceId,
  fixedScope,
  canManage,
  canSelf,
  busy,
  onClose,
  onCreate,
  onUpdate,
}: {
  provider: IntegrationProviderDescriptor;
  connection?: IntegrationConnectionRecord;
  can: (permission: Permission) => boolean;
  workspaceId: string | null;
  fixedScope?: IntegrationScope;
  canManage: boolean;
  canSelf: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (draft: IntegrationConnectionDraft, personal: boolean) => Promise<void>;
  onUpdate: (
    connection: IntegrationConnectionRecord,
    input: { name: string; scope: IntegrationScope; config: Readonly<Record<string, IntegrationFieldValue | null>> },
  ) => Promise<void>;
}): JSX.Element {
  const availableScopes: Array<'instance' | 'workspace' | 'repository'> = fixedScope
    ? [fixedScope.kind]
    : provider.scopes.filter(
        (scope) => scope === 'instance' || (scope === 'workspace' && workspaceId) || scope === connection?.scope.kind,
      );
  const initialScope =
    fixedScope?.kind ??
    connection?.scope.kind ??
    (workspaceId && availableScopes.includes('workspace') ? 'workspace' : undefined) ??
    (availableScopes.includes('instance') ? 'instance' : undefined) ??
    availableScopes[0] ??
    'instance';
  const [name, setName] = useState(connection?.name ?? provider.title);
  const [scopeKind, setScopeKind] = useState<'instance' | 'workspace' | 'repository'>(initialScope);
  const [personal, setPersonal] = useState(
    connection
      ? connection.ownerId !== null
      : provider.supportsPersonal === true && canSelf && !canManage,
  );
  const [values, setValues] = useState<Record<string, IntegrationFieldValue | null>>(() => ({ ...(connection?.config ?? {}) }));
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const scopedWorkspaceId = connection && connection.scope.kind !== 'instance'
    ? connection.scope.workspaceId
    : workspaceId;
  const scope: IntegrationScope = fixedScope ?? (
    scopeKind === 'workspace' && scopedWorkspaceId
      ? { kind: 'workspace', workspaceId: scopedWorkspaceId }
      : { kind: 'instance' }
  );

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const config: Record<string, IntegrationFieldValue | null> = {};
    for (const field of provider.fields) {
      if (field.kind === 'secret') {
        if (clearSecrets.has(field.key)) config[field.key] = null;
        else if (typeof values[field.key] === 'string' && values[field.key] !== '') config[field.key] = values[field.key]!;
      } else if (values[field.key] !== undefined) {
        config[field.key] = values[field.key]!;
      }
    }
    try {
      if (connection) await onUpdate(connection, { name: name.trim(), scope, config });
      else await onCreate({ providerId: provider.id, name: name.trim(), scope, enabled: true, config: config as Record<string, IntegrationFieldValue> }, personal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal title={`${connection ? 'Edit' : 'Connect'} ${provider.title}`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {provider.setup ? (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-3 text-sm leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
            {provider.setup}
            {provider.docsUrl ? (
              <a className="ml-2 whitespace-nowrap font-medium text-zinc-900 hover:underline dark:text-zinc-100" href={provider.docsUrl} target="_blank" rel="noreferrer">
                Setup docs ↗
              </a>
            ) : null}
          </div>
        ) : null}
        <Field label="Connection name" hint="A human label used in routing and delivery history.">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </Field>

        {!fixedScope && availableScopes.length > 1 && connection?.scope.kind !== 'repository' ? (
          <Field label="Available to">
            <SegmentedControl
              value={scopeKind}
              onChange={setScopeKind}
              options={availableScopes.map((value) => ({
                value,
                label: value === 'instance' ? 'Every workspace' : value === 'workspace' ? 'Current workspace' : 'This repository',
              }))}
              label="Connection scope"
              name="integration-scope"
            />
          </Field>
        ) : null}

        {!connection && provider.supportsPersonal && canSelf && canManage ? (
          <Field
            label="Audience"
            hint={personal ? 'Only events addressed to you can use it.' : 'Shared routing and team events can use it.'}
          >
            <SegmentedControl
              value={personal ? 'personal' : 'shared'}
              onChange={(value) => setPersonal(value === 'personal')}
              options={[{ value: 'shared', label: 'Team' }, { value: 'personal', label: 'Just me' }]}
              label="Connection audience"
              name="integration-audience"
            />
          </Field>
        ) : !connection && provider.supportsPersonal && !canManage ? (
          <p className="dim text-xs">This connection is personal and receives only events addressed to you.</p>
        ) : null}

        {provider.fields.map((field) => (
          <ConnectionField
            key={field.key}
            field={field}
            value={values[field.key]}
            configured={connection?.configuredSecrets.includes(field.key) ?? false}
            clear={clearSecrets.has(field.key)}
            onClear={(clear) =>
              setClearSecrets((current) => {
                const next = new Set(current);
                if (clear) next.add(field.key);
                else next.delete(field.key);
                return next;
              })
            }
            onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
          />
        ))}

        <Slot
          name={`integrations.provider.${provider.id}.form`}
          can={can}
          props={{ providerId: provider.id, connectionId: connection?.id ?? null }}
        />
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save connection'}</button>
        </FormActions>
      </form>
    </Modal>
  );
}

function ConnectionField({
  field,
  value,
  configured,
  clear,
  onClear,
  onChange,
}: {
  field: IntegrationConfigField;
  value: IntegrationFieldValue | null | undefined;
  configured: boolean;
  clear: boolean;
  onClear: (value: boolean) => void;
  onChange: (value: IntegrationFieldValue) => void;
}): JSX.Element {
  const hint = field.kind === 'secret' && configured
    ? `${field.description ?? ''}${field.description ? ' ' : ''}A credential is stored; leave blank to keep it.`
    : field.description;
  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} hint={hint}>
        <Switch checked={Boolean(value ?? field.default)} onChange={onChange} label={field.label} />
      </Field>
    );
  }
  if (field.kind === 'select') {
    return (
      <Field label={field.label} hint={hint}>
        <select className="input" value={String(value ?? field.default ?? '')} onChange={(event) => onChange(event.target.value)} required={field.required}>
          <option value="" disabled={field.required}>{field.required ? 'Choose…' : 'Not set'}</option>
          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Field>
    );
  }
  return (
    <Field label={field.label} hint={hint}>
      <input
        className="input"
        type={field.kind === 'secret' ? 'password' : field.kind === 'url' ? 'url' : 'text'}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        required={field.required && !(field.kind === 'secret' && configured && !clear)}
        disabled={clear}
        autoComplete="off"
      />
      {field.kind === 'secret' && configured && !field.required ? (
        <label className="dim mt-2 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={clear} onChange={(event) => onClear(event.target.checked)} />
          Clear the stored credential
        </label>
      ) : null}
    </Field>
  );
}

function scopeLabel(scope: IntegrationScope, workspaceName?: string): string {
  switch (scope.kind) {
    case 'instance': return 'Every workspace';
    case 'workspace': return workspaceName ? `Workspace ${workspaceName}` : 'Current workspace';
    case 'repository': return scope.repo;
  }
}

function routeTargetName(value: string, connections: readonly IntegrationConnectionRecord[]): string {
  if (value.startsWith('provider:')) return value.slice('provider:'.length);
  if (value.startsWith('connection:')) {
    const id = value.slice('connection:'.length);
    const connection = connections.find((candidate) => candidate.id === id);
    return connection ? `${connection.providerId} · ${connection.name}` : id;
  }
  return value;
}

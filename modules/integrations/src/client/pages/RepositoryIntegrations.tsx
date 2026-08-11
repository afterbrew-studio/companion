import { useEffect, useMemo, useState } from 'react';
import { Slot } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import {
  Breadcrumb,
  ErrorBar,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  Section,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import type {
  EffectiveIntegrationRoute,
  IntegrationConnectionRecord,
  IntegrationProviderDescriptor,
  IntegrationScope,
  IntegrationTargetRef,
} from '../../contract/index.js';
import { integrationsApi } from '../api.js';
import { useIntegrations } from '../hooks/useIntegrations.js';
import { decodeIntegrationTarget, encodeIntegrationTarget, reviewTargetOptions } from '../review-targets.js';
import { ConnectionModal } from './Integrations.js';

export function RepositoryIntegrationsPage({ repo }: { repo: string }): React.JSX.Element {
  const { can } = useAuth();
  const { current } = useWorkspace();
  const state = useIntegrations();
  const [route, setRoute] = useState<EffectiveIntegrationRoute | null>(null);
  const [primary, setPrimary] = useState('');
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('');
  const [editing, setEditing] = useState<{
    provider: IntegrationProviderDescriptor;
    connection?: IntegrationConnectionRecord;
  } | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const scope: IntegrationScope | null = current ? { kind: 'repository', workspaceId: current.id, repo } : null;
  const scopeKey = scope ? JSON.stringify(scope) : '';

  const options = useMemo(
    () => scope
      ? reviewTargetOptions(state.catalog?.providers ?? [], state.catalog?.connections ?? [], scope, true)
      : [],
    [state.catalog, scopeKey],
  );

  useEffect(() => {
    setRoute(null);
    setPrimary('');
    setFallback('');
  }, [scopeKey]);

  useEffect(() => {
    if (!scope) return;
    let live = true;
    void integrationsApi
      .route('code-review', scope)
      .then(({ route: next }) => {
        if (!live) return;
        setRoute(next);
        setPrimary(next.targets[0] ? encodeIntegrationTarget(next.targets[0]) : '');
        setFallback(next.targets[1] ? encodeIntegrationTarget(next.targets[1]) : '');
        setError(null);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [scopeKey, state.catalog]);

  if (!scope || !state.catalog || !route) {
    return error || state.error ? <Page><ErrorBar error={error ?? state.error} /></Page> : <PageLoading label="Loading repository integrations…" />;
  }

  const providerOf = (value: string) => {
    const option = options.find((candidate) => candidate.value === value);
    return option ? state.catalog!.providers.find((provider) => provider.id === option.target.providerId) : undefined;
  };
  const primaryProvider = providerOf(primary);
  const repositoryProviders = state.catalog.providers.filter(
    (provider) =>
      provider.connectionMode !== 'none' &&
      provider.scopes.includes('repository') &&
      (can('integrations:manage') || (can('integrations:self') && provider.supportsPersonal)),
  );
  const repositoryConnections = state.catalog.connections.filter(
    (connection) =>
      connection.scope.kind === 'repository' &&
      connection.scope.workspaceId === scope.workspaceId &&
      connection.scope.repo === repo,
  );

  const save = async (): Promise<void> => {
    setError(null);
    const targets: IntegrationTargetRef[] = [];
    const first = decodeIntegrationTarget(primary, undefined, state.catalog!.connections);
    const second = decodeIntegrationTarget(fallback, undefined, state.catalog!.connections);
    if (first) targets.push(first);
    if (first && second && encodeIntegrationTarget(second) !== encodeIntegrationTarget(first)) targets.push(second);
    try {
      await state.setRoute('code-review', scope, targets);
      setRoute((await integrationsApi.route('code-review', scope)).route);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Repositories', href: '#/repos' }, { label: repo }, { label: 'Integrations' }]} />
      <PageHeader
        title="Repository integrations"
        subtitle={`Routing and external tools for ${repo}`}
      />
      <ErrorBar error={error ?? state.error} />

      <Section
        title="Repository connections"
        description="Credentials can be shared from the workspace, or narrowed to this repository. Repository connections never become available to another repo."
      >
        <div className="card overflow-hidden p-0">
          {repositoryProviders.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <select
                className="input min-w-52 flex-1"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                aria-label="Integration provider"
              >
                <option value="">Choose a provider…</option>
                {repositoryProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.title}</option>
                ))}
              </select>
              <button
                className="btn"
                disabled={!providerId}
                onClick={() => {
                  const provider = repositoryProviders.find((candidate) => candidate.id === providerId);
                  if (provider) setEditing({ provider });
                }}
              >
                Connect for this repo
              </button>
            </div>
          ) : null}
          {repositoryConnections.length === 0 ? (
            <p className="dim px-4 py-5 text-sm">
              No repository-only connection. Compatible instance and workspace connections remain available here.
            </p>
          ) : (
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {repositoryConnections.map((connection) => {
                const provider = state.catalog!.providers.find((candidate) => candidate.id === connection.providerId);
                if (!provider) {
                  const manageable = connection.ownerId !== null
                    ? can('integrations:self')
                    : can('integrations:manage');
                  return (
                    <div key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm">{connection.name}</strong>
                          <MetaSignal tone="amber" label="provider disabled" />
                        </div>
                        <p className="dim mt-1 text-xs">{connection.providerId}</p>
                      </div>
                      {manageable ? (
                        <button
                          className="btn-ghost text-red-600 dark:text-red-400"
                          disabled={state.busy !== null}
                          onClick={() => void (async () => {
                            const confirmed = await confirmDanger({
                              title: `Remove “${connection.name}”?`,
                              message: 'Its preserved credentials and any routing references are deleted.',
                              confirmLabel: 'Remove connection',
                            });
                            if (confirmed) await state.remove(connection.id, connection.ownerId !== null);
                          })().catch(() => undefined)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  );
                }
                const tone = connection.health.status === 'ready'
                  ? 'green'
                  : connection.health.status === 'unavailable'
                    ? 'red'
                    : connection.health.status === 'degraded'
                      ? 'amber'
                      : 'zinc';
                return (
                  <div key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm">{connection.name}</strong>
                        <MetaSignal tone={tone} label={connection.health.status} title={connection.health.message} />
                      </div>
                      <p className="dim mt-1 text-xs">{provider.title}{connection.ownerId ? ' · just you' : ''}</p>
                    </div>
                    {can('integrations:manage') || (connection.ownerId !== null && can('integrations:self')) ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          className="btn-ghost"
                          disabled={state.busy !== null}
                          onClick={() => void state.test(connection.id, connection.ownerId !== null).catch(() => undefined)}
                        >Test</button>
                        <button className="btn-ghost" disabled={state.busy !== null} onClick={() => setEditing({ provider, connection })}>Edit</button>
                        <button
                          className="btn-ghost"
                          disabled={state.busy !== null}
                          onClick={() => void state.update(connection.id, { enabled: !connection.enabled }, connection.ownerId !== null).catch(() => undefined)}
                        >{connection.enabled ? 'Disable' : 'Enable'}</button>
                        <button
                          className="btn-ghost text-red-600 dark:text-red-400"
                          disabled={state.busy !== null}
                          onClick={() => void (async () => {
                            const confirmed = await confirmDanger({
                              title: `Remove “${connection.name}”?`,
                              message: 'Its stored credentials and any route references are deleted.',
                              confirmLabel: 'Remove connection',
                            });
                            if (confirmed) await state.remove(connection.id, connection.ownerId !== null);
                          })().catch(() => undefined)}
                        >Remove</button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Section>

      <Section
        title="Code review routing"
        description="Choose who reviews first and what Companion should use only when that provider is unavailable. A reported review failure never silently falls through."
      >
        <div className="card flex flex-col gap-4">
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
                disabled={!can('integrations:manage')}
              >
                <option value="">Use platform default</option>
                {primary && !options.some((option) => option.value === primary) ? (
                  <option value={primary}>Unavailable · {routeTargetName(primary, state.catalog.connections)}</option>
                ) : null}
                {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Unavailable fallback</span>
              <select
                className="input"
                value={fallback}
                onChange={(event) => setFallback(event.target.value)}
                disabled={!can('integrations:manage') || !primary}
              >
                <option value="">No fallback</option>
                {fallback && !options.some((option) => option.value === fallback) ? (
                  <option value={fallback}>Unavailable · {routeTargetName(fallback, state.catalog.connections)}</option>
                ) : null}
                {options.filter((option) => option.value !== primary).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <MetaSignal
              tone={route.sourceScope?.kind === 'repository' ? 'green' : 'zinc'}
              label={route.sourceScope?.kind === 'repository' ? 'repository override' : route.sourceScope ? `inherited from ${route.sourceScope.kind}` : 'platform default'}
            />
            {primaryProvider?.execution === 'delegated' ? (
              <span className="dim text-xs">This provider posts directly on GitHub and cannot satisfy a verdict-based pipeline gate.</span>
            ) : (
              <span className="dim text-xs">Managed reviewers return a draft to Companion before anything is posted.</span>
            )}
            <span className="flex-1" />
            {can('integrations:manage') ? (
              <button className="btn" disabled={state.busy !== null} onClick={() => void save()}>
                {state.busy?.startsWith('route:') ? 'Saving…' : 'Save routing'}
              </button>
            ) : null}
          </div>
        </div>
      </Section>

      <Slot
        name="integrations.repository.sections"
        can={can}
        props={{ repo, workspaceId: scope.workspaceId }}
      />
      {editing ? (
        <ConnectionModal
          provider={editing.provider}
          connection={editing.connection}
          can={can}
          workspaceId={scope.workspaceId}
          fixedScope={scope}
          canManage={can('integrations:manage')}
          canSelf={can('integrations:self')}
          busy={state.busy !== null}
          onClose={() => setEditing(null)}
          onCreate={async (draft, personal) => {
            await state.create(draft, personal);
            setEditing(null);
            setProviderId('');
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

function routeTargetName(value: string, connections: readonly IntegrationConnectionRecord[]): string {
  if (value.startsWith('provider:')) return value.slice('provider:'.length);
  if (value.startsWith('connection:')) {
    const id = value.slice('connection:'.length);
    const connection = connections.find((candidate) => candidate.id === id);
    return connection ? `${connection.providerId} · ${connection.name}` : id;
  }
  return value;
}

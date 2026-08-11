import { useEffect, useMemo, useState } from 'react';
import type {
  EffectiveIntegrationRoute,
  IntegrationConnectionRecord,
  IntegrationProviderDescriptor,
  IntegrationScope,
  IntegrationTargetRef,
} from '../contract/index.js';
import { integrationsApi } from './api.js';
import { useIntegrations } from './hooks/useIntegrations.js';

const PREFIX_PROVIDER = 'provider:';
const PREFIX_CONNECTION = 'connection:';

export function encodeIntegrationTarget(target: IntegrationTargetRef): string {
  return target.connectionId ? `${PREFIX_CONNECTION}${target.connectionId}` : `${PREFIX_PROVIDER}${target.providerId}`;
}

export function decodeIntegrationTarget(
  value: string | null | undefined,
  providers?: readonly IntegrationProviderDescriptor[],
  connections?: readonly IntegrationConnectionRecord[],
): IntegrationTargetRef | undefined {
  if (!value) return undefined;
  if (value.startsWith(PREFIX_PROVIDER)) {
    const providerId = value.slice(PREFIX_PROVIDER.length);
    return providerId && (!providers || providers.some((provider) => provider.id === providerId))
      ? { providerId, connectionId: null }
      : undefined;
  }
  if (value.startsWith(PREFIX_CONNECTION)) {
    const id = value.slice(PREFIX_CONNECTION.length);
    const connection = connections?.find((candidate) => candidate.id === id);
    return connection ? { providerId: connection.providerId, connectionId: connection.id } : undefined;
  }
  return undefined;
}

function applies(connection: IntegrationConnectionRecord, scope: IntegrationScope): boolean {
  if (connection.scope.kind === 'instance') return true;
  if (scope.kind === 'instance') return false;
  if (connection.scope.workspaceId !== scope.workspaceId) return false;
  if (connection.scope.kind === 'workspace') return true;
  return scope.kind === 'repository' && connection.scope.repo === scope.repo;
}

export interface ReviewTargetOption {
  readonly value: string;
  readonly label: string;
  readonly execution: IntegrationProviderDescriptor['execution'];
  readonly target: IntegrationTargetRef;
  readonly personal: boolean;
}

export function reviewTargetOptions(
  providers: readonly IntegrationProviderDescriptor[],
  connections: readonly IntegrationConnectionRecord[],
  scope: IntegrationScope,
  sharedOnly = false,
): ReviewTargetOption[] {
  const byProvider = new Map(providers.map((provider) => [provider.id, provider]));
  const options: ReviewTargetOption[] = [];
  for (const provider of providers.filter((candidate) => candidate.capabilities.includes('code-review'))) {
    if (provider.connectionMode !== 'required') {
      const target = { providerId: provider.id, connectionId: null } as const;
      options.push({
        value: encodeIntegrationTarget(target),
        label: provider.title,
        execution: provider.execution,
        target,
        personal: false,
      });
    }
  }
  for (const connection of connections) {
    if (sharedOnly && connection.ownerId !== null) continue;
    const provider = byProvider.get(connection.providerId);
    if (!provider?.capabilities.includes('code-review') || !connection.enabled || !applies(connection, scope)) continue;
    const target = { providerId: provider.id, connectionId: connection.id } as const;
    options.push({
      value: encodeIntegrationTarget(target),
      label: `${provider.title} · ${connection.name}`,
      execution: provider.execution,
      target,
      personal: connection.ownerId !== null,
    });
  }
  return options;
}

export function useReviewTargets(scope: IntegrationScope): {
  readonly options: readonly ReviewTargetOption[];
  readonly route: EffectiveIntegrationRoute | null;
  readonly loading: boolean;
} {
  const { catalog } = useIntegrations();
  const [route, setRoute] = useState<EffectiveIntegrationRoute | null>(null);
  const key = JSON.stringify(scope);
  useEffect(() => {
    let live = true;
    void integrationsApi
      .route('code-review', scope)
      .then((result) => {
        if (live) setRoute(result.route);
      })
      .catch(() => {
        if (live) setRoute(null);
      });
    return () => {
      live = false;
    };
  }, [key, catalog]);
  const options = useMemo(
    () => reviewTargetOptions(catalog?.providers ?? [], catalog?.connections ?? [], scope),
    [catalog, key],
  );
  return { options, route, loading: catalog === null || route === null };
}

/** Shared picker used by the PR launcher and pipeline editor. Empty means the
 * effective repository/workspace route rather than a hard-coded vendor. */
export function ReviewProviderSelect({
  scope,
  value,
  onChange,
  className = '',
  sharedOnly = false,
}: {
  readonly scope: IntegrationScope;
  readonly value: string;
  readonly onChange: (value: string, target: IntegrationTargetRef | undefined) => void;
  readonly className?: string;
  /** Shared configuration (for example a reusable pipeline) must never pin a
   * personal connection that another maintainer cannot use. */
  readonly sharedOnly?: boolean;
}): React.JSX.Element {
  const state = useReviewTargets(scope);
  const options = sharedOnly ? state.options.filter((option) => !option.personal) : state.options;
  const { route } = state;
  const routed = route?.targets[0];
  const routedLabel = routed ? options.find((option) => option.value === encodeIntegrationTarget(routed))?.label : null;
  return (
    <select
      className={`input w-auto text-xs ${className}`}
      value={value}
      onChange={(event) => {
        const value = event.target.value;
        onChange(value, options.find((option) => option.value === value)?.target);
      }}
      aria-label="Code review provider"
    >
      <option value="">Repository route{routedLabel ? ` · ${routedLabel}` : ''}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}{option.execution === 'delegated' ? ' (delegated)' : ''}
        </option>
      ))}
    </select>
  );
}

import { useState } from 'react';
import { EmptyState, ErrorBar, ListCard, Page, PageHeader, Section, SettingRow, Switch, timeAgo } from '@companion/ui';
import type { CatalogMachine, CatalogProvider } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useProviders } from '../hooks/useProviders.js';

/**
 * Provider/model switchboard. Every machine reads its own models from moxxy and
 * the daemon merges them here, so a model appears once with the machines that
 * can serve it. Fetching is the daemon's job (on bind, after an import, off
 * live runs, and on a staleness timer) — the Refresh button is a nudge, not a
 * requirement. Toggles are instance-wide policy; which model a given machine
 * rides for an action stays per-runner (Runners → Model pins).
 */

export function ProvidersPage(): JSX.Element {
  const {
    catalog,
    error,
    setError,
    refresh,
    refetchFromMachines,
    refetching,
    isModelDisabled,
    toggleProvider,
    toggleModel,
    removeManualId,
  } = useProviders();
  const [note, setNote] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const reimport = async (): Promise<void> => {
    setImporting(true);
    setError(null);
    setNote(null);
    try {
      const { imported, missing } = await api.importProviders();
      setNote(
        imported.length > 0
          ? `Re-imported ${imported.join(', ')}${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''}. Models refresh in the background.`
          : `Nothing found to import${missing.length > 0 ? ` — missing in ~/.moxxy: ${missing.join(', ')}` : ''}.`,
      );
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  };

  const machines = catalog?.machines ?? [];
  const providers = catalog?.providers ?? [];
  const served = providers.filter((p) => p.machines.length > 0);
  const modelCount = new Set(providers.flatMap((p) => p.models.map((m) => m.id))).size;
  const catalogIds = new Set(providers.flatMap((p) => p.models.flatMap((m) => [m.id, `${p.name}/${m.id}`])));
  const manualIds = (catalog?.disabledModels ?? []).filter((id) => !catalogIds.has(id));

  return (
    <Page>
      <PageHeader
        title="Providers"
        subtitle="Which providers and models agents may use — disabled selections fall back to the default model"
        actions={
          <>
            <button className="btn-ghost" disabled={refetching} onClick={() => void refetchFromMachines()}>
              {refetching ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="btn-ghost" disabled={importing} onClick={() => void reimport()}>
              {importing ? 'Importing…' : 'Re-import from ~/.moxxy'}
            </button>
          </>
        }
      />
      <ErrorBar error={error} />
      {note ? (
        <div className="banner-info" role="status">
          {note}
        </div>
      ) : null}

      {catalog === null ? null : providers.length === 0 ? (
        <EmptyState
          title="No providers yet"
          hint="Import providers from your daily ~/.moxxy — credential files are linked so token rotation stays shared."
          action={
            <button className="btn" disabled={importing} onClick={() => void reimport()}>
              {importing ? 'Importing…' : 'Import from ~/.moxxy'}
            </button>
          }
        />
      ) : (
        <>
          <p className="dim mb-2 text-xs" role="status">
            {modelCount > 0
              ? `${modelCount} model${modelCount === 1 ? '' : 's'} from ${served.length} provider${served.length === 1 ? '' : 's'} across ${machines.length} machine${machines.length === 1 ? '' : 's'} · read ${timeAgo(catalog.fetchedAt ?? Date.now())}`
              : catalog.fetchedAt === null
                ? 'Machines report their models on their own — this fills in shortly after one connects.'
                : 'No machine has credentials for any provider yet.'}
          </p>
          <ListCard subtle>
            {providers.map((p) => (
              <ProviderRow
                key={p.name}
                provider={p}
                machines={machines}
                read={catalog.fetchedAt !== null}
                isModelDisabled={isModelDisabled}
                onToggleProvider={toggleProvider}
                onToggleModel={toggleModel}
              />
            ))}
          </ListCard>
        </>
      )}

      {manualIds.length > 0 ? (
        <Section
          title="Disabled ids outside the catalog"
          description="Model ids disabled earlier that no machine currently lists."
        >
          <div className="flex flex-wrap gap-1.5">
            {manualIds.map((id) => (
              <button
                key={id}
                type="button"
                className="chip cursor-pointer font-mono hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-400"
                title={`Re-enable ${id}`}
                onClick={() => removeManualId(id)}
              >
                {id} ✕
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </Page>
  );
}

function ProviderRow({
  provider,
  machines,
  read,
  isModelDisabled,
  onToggleProvider,
  onToggleModel,
}: {
  provider: CatalogProvider;
  machines: readonly CatalogMachine[];
  /** At least one machine has reported — otherwise "unserved" means "not read yet". */
  read: boolean;
  isModelDisabled: (provider: string, id: string) => boolean;
  onToggleProvider: (name: string) => void;
  onToggleModel: (provider: string, id: string) => void;
}): JSX.Element {
  const unserved = provider.machines.length === 0;
  return (
    <div className="px-4 py-3">
      <SettingRow
        title={provider.name}
        description={
          unserved
            ? read
              ? 'Configured in ~/.moxxy, but no machine has credentials for it.'
              : 'Reading models from your machines…'
            : !provider.enabled
              ? 'Hidden — selections fall back to the default model.'
              : `Ready on ${where(provider.machines, machines)}.`
        }
      >
        <Switch
          label={`Provider ${provider.name}`}
          checked={provider.enabled}
          onChange={() => onToggleProvider(provider.name)}
        />
      </SettingRow>
      {provider.enabled && provider.models.length > 0 ? (
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2" aria-label={`Models of ${provider.name}`}>
          {provider.models.map((m) => {
            const enabled = !isModelDisabled(provider.name, m.id);
            // Machine attribution only earns its space once a model is not on
            // every machine — on a single-machine install it never shows.
            const partial = machines.length > 1 && m.machines.length < machines.length;
            const meta = [
              m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : null,
              partial ? where(m.machines, machines) : null,
            ].filter(Boolean);
            return (
              <SettingRow
                key={m.id}
                className={`rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800 ${enabled ? '' : 'opacity-60'}`}
                title={<span className="block truncate font-mono text-xs">{m.id}</span>}
                description={meta.length > 0 ? meta.join(' · ') : undefined}
              >
                <Switch
                  label={`Model ${m.id} of ${provider.name}`}
                  checked={enabled}
                  onChange={() => onToggleModel(provider.name, m.id)}
                />
              </SettingRow>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** "all 3 machines" / "mbp-work" / "mbp-work, gpu-box +1" — names, not ids. */
function where(ids: readonly string[], machines: readonly CatalogMachine[]): string {
  if (machines.length > 1 && ids.length === machines.length) return `all ${machines.length} machines`;
  const names = ids.map((id) => machines.find((m) => m.id === id)?.name ?? id);
  if (names.length === 0) return 'no machine';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

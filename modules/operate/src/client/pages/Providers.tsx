import { useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  ListCard,
  Page,
  PageHeader,
  Section,
  SettingRow,
  StatusDot,
  Switch,
  timeAgo,
} from '@moxxy/companion-ui';
import type { CatalogMachine, CatalogProvider } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useProviders } from '../hooks/useProviders.js';

/**
 * Provider/model switchboard. Every machine reads its own models from moxxy, so
 * the toggles are per machine: the same provider can be credential-ready on one
 * and absent on the next, and one instance-wide list could not say so. The page
 * stays merged rather than moving onto each machine's own page because the
 * question it answers is a fleet question ("can agents use model X at all"),
 * and because providers get retuned far more often than machines get set up.
 *
 * Fetching is the daemon's job (on bind, after an import, off live runs, and on
 * a staleness timer). The Refresh button is a nudge, not a requirement.
 */

export function ProvidersPage(): JSX.Element {
  const {
    catalog,
    error,
    setError,
    refresh,
    refetchFromMachines,
    refetching,
    toggleProvider,
    toggleModel,
    enableStranded,
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

  return (
    <Page>
      <PageHeader
        title="Providers"
        subtitle="Which providers and models agents may use, per machine. The top list is what that adds up to"
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

      {catalog === null ? null : (
        <>
          {providers.length === 0 ? (
            <EmptyState
              title="No providers yet"
              hint="Import providers from your daily ~/.moxxy. Credential files are linked so token rotation stays shared."
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
                    ? 'Machines report their models on their own, so this fills in shortly after one connects.'
                    : 'No machine has credentials for any provider yet.'}
              </p>
              <ListCard subtle ariaLabel="Available to agents">
                {providers.map((p) => (
                  <EffectiveRow key={p.name} provider={p} machines={machines} read={catalog.fetchedAt !== null} />
                ))}
              </ListCard>
            </>
          )}

          {machines.map((machine) => (
            <MachineSection
              key={machine.id}
              machine={machine}
              onToggleProvider={toggleProvider}
              onToggleModel={toggleModel}
              onEnableStranded={enableStranded}
            />
          ))}
        </>
      )}
    </Page>
  );
}

/** Merged row: what agents can reach, and where. Read-only by design: a fleet
 *  answer has no single machine to write back to. */
function EffectiveRow({
  provider,
  machines,
  /** At least one machine has reported; otherwise "unserved" means "not read yet". */
  read,
}: {
  provider: CatalogProvider;
  machines: readonly CatalogMachine[];
  read: boolean;
}): JSX.Element {
  const models = provider.models.length;
  const description =
    provider.machines.length > 0
      ? `${models} model${models === 1 ? '' : 's'} on ${where(provider.machines, machines)}.`
      : provider.disabledOn.length > 0
        ? `Switched off on ${where(provider.disabledOn, machines)}, so agents cannot use it anywhere.`
        : read
          ? 'Configured in ~/.moxxy, but no machine has credentials for it.'
          : 'Reading models from your machines…';
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <StatusDot tone={provider.machines.length > 0 ? 'green' : 'zinc'} size="sm" label={provider.name} />
      <SettingRow title={provider.name} description={description}>
        {provider.models.length > 0 ? (
          <span className="dim font-mono text-[11px]" title={provider.models.map((m) => m.id).join('\n')}>
            {provider.models
              .slice(0, 3)
              .map((m) => m.id)
              .join(' · ')}
            {provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}
          </span>
        ) : null}
      </SettingRow>
    </div>
  );
}

function MachineSection({
  machine,
  onToggleProvider,
  onToggleModel,
  onEnableStranded,
}: {
  machine: CatalogMachine;
  onToggleProvider: (machine: CatalogMachine, name: string) => void;
  onToggleModel: (machine: CatalogMachine, provider: string, id: string) => void;
  onEnableStranded: (machine: CatalogMachine, id: string) => void;
}): JSX.Element {
  // Before a machine has reported, its whole catalog is unknown, so every
  // disabled id would look stranded. Only judge once something was listed.
  const listed = new Set(machine.providers.flatMap((p) => p.models.flatMap((m) => [m.id, `${p.name}/${m.id}`])));
  const stranded =
    machine.fetchedAt === null ? [] : machine.policy.disabledModels.filter((id) => !listed.has(id));

  return (
    <Section
      title={machine.name}
      description={
        machine.fetchedAt === null
          ? 'This machine reports its models on its own, usually within a minute of connecting.'
          : `${machine.modelCount} model${machine.modelCount === 1 ? '' : 's'} usable here${machine.online ? '' : ' · offline'} · read ${timeAgo(machine.fetchedAt)}`
      }
    >
      {machine.providers.length === 0 ? (
        <p className="dim rounded-lg border border-dashed border-zinc-300 p-3 text-xs dark:border-zinc-700">
          Nothing reported yet from this machine.
        </p>
      ) : (
        <ListCard subtle ariaLabel={`Providers on ${machine.name}`}>
          {machine.providers.map((provider) => (
            <div key={provider.name} className="px-4 py-3">
              <SettingRow
                title={provider.name}
                description={
                  !provider.ready
                    ? 'No credentials for it on this machine.'
                    : !provider.enabled
                      ? 'Off here. Agents place elsewhere for its models.'
                      : `Ready · ${provider.models.filter((m) => m.enabled).length} of ${provider.models.length} models on.`
                }
              >
                <Switch
                  label={`Provider ${provider.name} on ${machine.name}`}
                  checked={provider.enabled}
                  onChange={() => onToggleProvider(machine, provider.name)}
                  reason={provider.ready ? undefined : 'no credentials on this machine'}
                />
              </SettingRow>
              {provider.enabled && provider.models.length > 0 ? (
                <div
                  className="mt-3 grid gap-1.5 sm:grid-cols-2"
                  aria-label={`Models of ${provider.name} on ${machine.name}`}
                >
                  {provider.models.map((m) => (
                    <SettingRow
                      key={m.id}
                      className={`rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800 ${m.enabled ? '' : 'opacity-60'}`}
                      title={<span className="block truncate font-mono text-xs">{m.id}</span>}
                      description={m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined}
                    >
                      <Switch
                        label={`Model ${m.id} of ${provider.name} on ${machine.name}`}
                        checked={m.enabled}
                        onChange={() => onToggleModel(machine, provider.name, m.id)}
                      />
                    </SettingRow>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </ListCard>
      )}

      {stranded.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="dim text-xs">Disabled here but no longer listed:</span>
          {stranded.map((id) => (
            <button
              key={id}
              type="button"
              className="chip cursor-pointer font-mono hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-400"
              title={`Re-enable ${id} on ${machine.name}`}
              onClick={() => onEnableStranded(machine, id)}
            >
              {id} ✕
            </button>
          ))}
        </div>
      ) : null}
    </Section>
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

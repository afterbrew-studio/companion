import { useState } from 'react';
import { EmptyState, ErrorBar, ListCard, Page, PageHeader, Section, SettingRow, Switch } from '@companion/ui';
import { operateApi as api } from '../api.js';
import { useProviders } from '../hooks/useProviders.js';

/**
 * Provider/model switchboard. The model catalog is delivered by moxxy's
 * gateway (live if a run is up, else the last cached copy) — providers list
 * their models as toggles. Disabled selections fall back to the default model.
 * Per-action model choices now live per runner (Runners → Model pins), so a
 * given machine rides the model it can actually serve.
 */

export function ProvidersPage(): JSX.Element {
  const { providers, disabledModels, catalog, catalogFresh, error, setError, refresh, isModelDisabled, toggleProvider, toggleModel, removeManualId } =
    useProviders();
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
          ? `Re-imported ${imported.join(', ')}${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''}. New runs pick this up.`
          : `Nothing found to import${missing.length > 0 ? ` — missing in ~/.moxxy: ${missing.join(', ')}` : ''}.`,
      );
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  };

  const catalogIds = new Set(catalog.flatMap((p) => p.models.flatMap((m) => [m.id, `${p.name}/${m.id}`])));
  const manualIds = disabledModels.filter((id) => !catalogIds.has(id));

  return (
    <Page>
      <PageHeader
        title="Providers"
        subtitle="Which providers and models agents may use — disabled selections fall back to the default model"
        actions={
          <button className="btn-ghost" disabled={importing} onClick={() => void reimport()}>
            {importing ? 'Importing…' : 'Re-import from ~/.moxxy'}
          </button>
        }
      />
      <ErrorBar error={error} />
      {note ? (
        <div className="banner-info" role="status">
          {note}
        </div>
      ) : null}

      {providers === null ? null : providers.length === 0 ? (
        <EmptyState
          title="No providers imported yet"
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
            {catalog.length > 0
              ? catalogFresh
                ? 'Model catalog read live from the moxxy gateway.'
                : 'Model catalog cached from the last live run — start any run to refresh it.'
              : 'Model catalog not loaded yet — start any run once and moxxy reports each provider’s models here.'}
          </p>
          <ListCard subtle>
            {providers.map((p) => {
              const models = catalog.find((c) => c.name === p.name)?.models ?? [];
              return (
                <div key={p.name} className="px-4 py-3">
                  <SettingRow
                    title={p.name}
                    description={
                      p.enabled
                        ? 'Available to runs and model pickers.'
                        : 'Hidden — selections fall back to the default model.'
                    }
                  >
                    <Switch label={`Provider ${p.name}`} checked={p.enabled} onChange={() => toggleProvider(p.name)} />
                  </SettingRow>
                  {p.enabled && models.length > 0 ? (
                    <div className="mt-3 grid gap-1.5 sm:grid-cols-2" aria-label={`Models of ${p.name}`}>
                      {models.map((m) => {
                        const enabled = !isModelDisabled(p.name, m.id);
                        return (
                          <SettingRow
                            key={m.id}
                            className={`rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800 ${
                              enabled ? '' : 'opacity-60'
                            }`}
                            title={<span className="block truncate font-mono text-xs">{m.id}</span>}
                            description={
                              m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined
                            }
                          >
                            <Switch
                              label={`Model ${m.id} of ${p.name}`}
                              checked={enabled}
                              onChange={() => toggleModel(p.name, m.id)}
                            />
                          </SettingRow>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </ListCard>
        </>
      )}

      {manualIds.length > 0 ? (
        <Section
          title="Disabled ids outside the catalog"
          description="Model ids disabled earlier that moxxy's current catalog does not list."
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

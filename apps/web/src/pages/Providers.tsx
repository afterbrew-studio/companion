import { useCallback, useEffect, useState } from 'react';
import type { ModelCatalogProvider } from '@companion/contract';
import { api } from '../lib/api.js';
import { Page, EmptyState, PageHeader, Section, Switch } from '../components/ui.js';

/**
 * Provider/model switchboard. The model catalog is delivered by moxxy's
 * gateway (live if a run is up, else the last cached copy) — providers list
 * their models as toggles. Disabled selections fall back to the default model.
 * Per-action model choices now live per runner (Runners → Model pins), so a
 * given machine rides the model it can actually serve.
 */

export function ProvidersPage(): JSX.Element {
  const [providers, setProviders] = useState<Array<{ name: string; enabled: boolean }> | null>(null);
  const [disabledModels, setDisabledModels] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogProvider[]>([]);
  const [catalogFresh, setCatalogFresh] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [settings, cat] = await Promise.all([
        api.getProviderSettings(),
        api.getModelsCatalog().catch(() => null),
      ]);
      // Providers known to config plus providers the gateway reports.
      const names = new Set(settings.providers.map((p) => p.name));
      const merged = [...settings.providers];
      for (const p of cat?.providers ?? []) {
        if (!names.has(p.name)) merged.push({ name: p.name, enabled: p.enabled });
      }
      setProviders(merged.sort((a, b) => a.name.localeCompare(b.name)));
      setDisabledModels(settings.disabledModels);
      setCatalog(cat?.providers ?? []);
      setCatalogFresh(cat?.fresh ?? null);
      setError(null);
    } catch (err) {
      setError(String(err));
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const save = async (nextProviders: Array<{ name: string; enabled: boolean }>, nextModels: string[]): Promise<void> => {
    setError(null);
    setNote(null);
    try {
      await api.setProviderSettings(
        nextProviders.filter((p) => !p.enabled).map((p) => p.name),
        nextModels,
      );
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleProvider = (name: string): void => {
    if (!providers) return;
    const next = providers.map((p) => (p.name === name ? { ...p, enabled: !p.enabled } : p));
    setProviders(next);
    void save(next, disabledModels);
  };

  const isModelDisabled = (provider: string, id: string): boolean =>
    disabledModels.includes(id) || disabledModels.includes(`${provider}/${id}`);

  const toggleModel = (provider: string, id: string): void => {
    if (!providers) return;
    const next = isModelDisabled(provider, id)
      ? disabledModels.filter((m) => m !== id && m !== `${provider}/${id}`)
      : [...disabledModels, id];
    setDisabledModels(next);
    void save(providers, next);
  };

  const removeManualId = (id: string): void => {
    if (!providers) return;
    const next = disabledModels.filter((m) => m !== id);
    setDisabledModels(next);
    void save(providers, next);
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
      {error ? <div className="error-bar">{error}</div> : null}
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
          <div className="card divide-y divide-zinc-100 p-0 dark:divide-zinc-800/60">
            {providers.map((p) => {
              const models = catalog.find((c) => c.name === p.name)?.models ?? [];
              return (
                <div key={p.name} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{p.name}</div>
                      <p className="dim mt-0.5">
                        {p.enabled
                          ? 'Available to runs and model pickers.'
                          : 'Hidden — selections fall back to the default model.'}
                      </p>
                    </div>
                    <Switch label={`Provider ${p.name}`} checked={p.enabled} onChange={() => toggleProvider(p.name)} />
                  </div>
                  {p.enabled && models.length > 0 ? (
                    <div className="mt-3 grid gap-1.5 sm:grid-cols-2" aria-label={`Models of ${p.name}`}>
                      {models.map((m) => {
                        const enabled = !isModelDisabled(p.name, m.id);
                        return (
                          <div
                            key={m.id}
                            className={`flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800 ${
                              enabled ? '' : 'opacity-60'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-xs font-medium">{m.id}</div>
                              {m.contextWindow ? (
                                <div className="dim text-[11px]">{Math.round(m.contextWindow / 1000)}k context</div>
                              ) : null}
                            </div>
                            <Switch
                              label={`Model ${m.id} of ${p.name}`}
                              checked={enabled}
                              onChange={() => toggleModel(p.name, m.id)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
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

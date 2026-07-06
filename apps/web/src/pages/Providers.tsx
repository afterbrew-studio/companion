import { useCallback, useEffect, useState } from 'react';
import type { ModelCatalogProvider } from '@companion/contract';
import { api } from '../lib/api.js';
import { Page, EmptyState, PageHeader, Section, Switch } from '../components/ui.js';

/**
 * Provider/model switchboard. The model catalog is delivered by moxxy's
 * gateway (live if a run is up, else the last cached copy) — providers list
 * their models as toggles, and per-action model pins pick from dropdowns.
 * Disabled selections fall back to the daemon default model.
 */

const PIN_KINDS: ReadonlyArray<{ kind: string; label: string; hint: string }> = [
  { kind: 'triage', label: 'Issue triage', hint: 'labels + summaries for new issues' },
  { kind: 'analysis', label: 'Reviews & analyses', hint: 'AI code review, CI analysis, AI generation' },
  { kind: 'fix', label: 'Fix runs', hint: 'issue → branch agents' },
  { kind: 'implement', label: 'Implement runs', hint: 'proposal → branch agents' },
  { kind: 'report', label: 'Reports', hint: 'digests and sweeps' },
  { kind: 'interactive', label: 'Interactive chats', hint: 'default for new chats (switchable per run)' },
];

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

      <ModelPinsSection catalog={catalog} disabledModels={disabledModels} />
    </Page>
  );
}

/** Per-action model pins: each runner kind can ride its own model. */
function ModelPinsSection({
  catalog,
  disabledModels,
}: {
  catalog: ModelCatalogProvider[];
  disabledModels: string[];
}): JSX.Element {
  const [pins, setPins] = useState<Record<string, string>>({});
  const [defaultModel, setDefaultModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getModelPins()
      .then((r) => {
        setPins(Object.fromEntries(Object.entries(r.pins).map(([k, v]) => [k, v ?? ''])));
        setDefaultModel(r.defaultModel);
      })
      .catch((err) => setError(String(err)));
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.setModelPins(Object.fromEntries(Object.entries(pins).map(([k, v]) => [k, v.trim() || null])));
      setNote('Saved.');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const selectable = catalog
    .filter((p) => p.enabled)
    .map((p) => ({
      name: p.name,
      models: p.models.filter((m) => !disabledModels.includes(m.id) && !disabledModels.includes(`${p.name}/${m.id}`)),
    }))
    .filter((p) => p.models.length > 0);
  const hasCatalog = selectable.length > 0;
  const knownIds = new Set(selectable.flatMap((p) => p.models.map((m) => m.id)));

  return (
    <Section
      title="Model pins"
      description={`Pin a model per action so different runners ride different models. Empty = daemon default${defaultModel ? ` (${defaultModel})` : ''}. Disabled models fall back to the default.`}
    >
      <div className="card">
        <div className="grid gap-2.5 sm:grid-cols-2">
          {PIN_KINDS.map((k) => (
            <label key={k.kind} className="flex flex-col gap-1 text-sm">
              <span className="dim">
                {k.label} <span className="text-[11px]">— {k.hint}</span>
              </span>
              {hasCatalog ? (
                <select
                  className="input font-mono text-xs"
                  value={pins[k.kind] ?? ''}
                  onChange={(e) => setPins((prev) => ({ ...prev, [k.kind]: e.target.value }))}
                >
                  <option value="">default{defaultModel ? ` — ${defaultModel}` : ''}</option>
                  {pins[k.kind] && !knownIds.has(pins[k.kind]!) ? (
                    <option value={pins[k.kind]}>{pins[k.kind]} (not in catalog)</option>
                  ) : null}
                  {selectable.map((p) => (
                    <optgroup key={p.name} label={p.name}>
                      {p.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                          {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <input
                  className="input font-mono text-xs"
                  placeholder={defaultModel || 'daemon default'}
                  value={pins[k.kind] ?? ''}
                  onChange={(e) => setPins((prev) => ({ ...prev, [k.kind]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2.5">
          {note ? <span className="text-[13px] text-emerald-600 dark:text-emerald-400">{note}</span> : null}
          <button className="btn" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save pins'}
          </button>
        </div>
        {error ? <div className="error-bar">{error}</div> : null}
      </div>
    </Section>
  );
}

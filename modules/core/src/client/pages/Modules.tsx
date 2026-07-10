import { useCallback, useState } from 'react';
import { useLive, type ModuleDescriptor } from '@companion/core/client';
import { Page, PageHeader, Section, Switch } from '@companion/ui';
import { modulesApi } from '../api.js';

/**
 * Runtime module toggles (admin). The kernel broadcasts `modules.changed` after
 * every enable/disable, so this list — like the sidebar — stays live across
 * browsers; required modules (identity, workspace scoping) cannot be turned off.
 */
export function ModulesPage(): JSX.Element {
  const [modules, setModules] = useState<readonly ModuleDescriptor[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { modules } = await modulesApi.list();
      setModules(modules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useLive(refresh, (msg) => msg.t === 'modules.changed');

  const toggle = async (mod: ModuleDescriptor): Promise<void> => {
    setBusy(mod.id);
    setError(null);
    try {
      const { modules } = await (mod.enabled ? modulesApi.disable(mod.id) : modulesApi.enable(mod.id));
      setModules(modules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHeader title="Modules" subtitle="The feature modules installed on this instance" />
      {error ? <div className="error-bar">{error}</div> : null}

      <Section
        title="Installed"
        description="Disabling a module hides its pages and stops its services. Modules that others depend on can only be disabled once their dependents are off."
      >
        <div className="card divide-y divide-zinc-200 p-0 dark:divide-zinc-800">
          {modules.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate font-medium">{m.title}</span>
                  <span className="dim text-xs">v{m.version}</span>
                  {m.required ? <span className="badge shrink-0">required</span> : null}
                </span>
                <span className="dim mt-0.5 block truncate text-xs">
                  {m.id}
                  {m.dependsOn.length > 0 ? <> · depends on {m.dependsOn.join(', ')}</> : null}
                </span>
              </span>
              <Switch
                checked={m.enabled}
                disabled={m.required || busy === m.id}
                label={`${m.enabled ? 'Disable' : 'Enable'} ${m.title}`}
                onChange={() => void toggle(m)}
              />
            </div>
          ))}
        </div>
      </Section>
    </Page>
  );
}

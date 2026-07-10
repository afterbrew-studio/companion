import { useState } from 'react';
import { useKernel, type ModuleDescriptor } from '@companion/core/client';
import { ErrorBar, ListCard, Page, PageHeader, Section, Switch } from '@companion/ui';
import { modulesApi } from '../api.js';

/**
 * Runtime module toggles (admin). The catalog comes from the kernel host
 * (ModulesProvider already fetches it and refreshes on `modules.changed`), so
 * this page — like the sidebar — stays live across browsers without its own
 * fetch; required modules (identity, workspace scoping) cannot be turned off.
 */
export function ModulesPage(): JSX.Element {
  const modules = useKernel().descriptors;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (mod: ModuleDescriptor): Promise<void> => {
    setBusy(mod.id);
    setError(null);
    try {
      // The kernel broadcasts modules.changed on success; ModulesProvider
      // refetches and this list updates through useKernel().
      await (mod.enabled ? modulesApi.disable(mod.id) : modulesApi.enable(mod.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHeader title="Modules" subtitle="The feature modules installed on this instance" />
      <ErrorBar error={error} />

      <Section
        title="Installed"
        description="Disabling a module hides its pages and stops its services. Modules that others depend on can only be disabled once their dependents are off."
      >
        <ListCard>
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
        </ListCard>
      </Section>
    </Page>
  );
}

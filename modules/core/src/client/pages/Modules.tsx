import { useState } from 'react';
import { useKernel, type ModuleDescriptor } from '@moxxy/companion-core/client';
import type { ModuleConfigState, ModuleConfigValue } from '@moxxy/companion-core';
import { ErrorBar, IconButton, ListCard, Modal, Page, PageHeader, Section, Switch, useConfirm } from '@moxxy/companion-ui';
import { modulesApi } from '../api.js';
import { ModuleConfigForm } from '../components/ModuleConfigForm.js';
import { OutOfTree } from '../components/OutOfTree.js';

/**
 * Runtime module lifecycle (admin). The catalog comes from the kernel host
 * (ModulesProvider already fetches it and refreshes on `modules.changed`), so
 * this page — like the sidebar — stays live across browsers without its own
 * fetch. Installed modules toggle/configure/uninstall; "Available" ones (in the
 * compiled catalog, not adopted) install here — collecting their declared
 * config first when they have one.
 */
export function ModulesPage(): JSX.Element {
  const modules = useKernel().descriptors;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();

  // The config modal: install collects values before adoption; configure edits
  // stored ones (fetched on open — the page never holds values it doesn't need).
  const [target, setTarget] = useState<{ mod: ModuleDescriptor; mode: 'install' | 'configure' } | null>(null);
  const [targetState, setTargetState] = useState<ModuleConfigState | undefined>(undefined);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const installed = modules.filter((m) => m.installed);
  const available = modules.filter((m) => !m.installed);

  const run = async (id: string, op: () => Promise<unknown>): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      // The kernel broadcasts modules.changed on success; ModulesProvider
      // refetches and this list updates through useKernel().
      await op();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (m: ModuleDescriptor): Promise<void> =>
    run(m.id, () => (m.enabled ? modulesApi.disable(m.id) : modulesApi.enable(m.id)));

  const uninstall = async (m: ModuleDescriptor): Promise<void> => {
    const ok = await confirmDanger({
      title: `Uninstall ${m.title}`,
      message: `This removes all of ${m.title}'s data and configuration. The module stays in the catalog and can be reinstalled from scratch.`,
      confirmLabel: 'Uninstall',
    });
    if (ok) await run(m.id, () => modulesApi.uninstall(m.id));
  };

  const openInstall = (m: ModuleDescriptor): void | Promise<void> => {
    if (m.config.length === 0) return run(m.id, () => modulesApi.install(m.id));
    setTarget({ mod: m, mode: 'install' });
    setTargetState(undefined);
    setModalError(null);
  };

  const openConfigure = async (m: ModuleDescriptor): Promise<void> => {
    setTarget({ mod: m, mode: 'configure' });
    setTargetState(undefined);
    setModalError(null);
    try {
      setTargetState(await modulesApi.getConfig(m.id));
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err));
    }
  };

  const submitModal = async (patch: Record<string, ModuleConfigValue | null>): Promise<void> => {
    if (!target) return;
    setModalBusy(true);
    setModalError(null);
    try {
      if (target.mode === 'install') {
        // Clearing is meaningless before anything is stored — drop the nulls.
        const config = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
        await modulesApi.install(target.mod.id, config);
      } else if (Object.keys(patch).length) {
        await modulesApi.setConfig(target.mod.id, patch);
      }
      setTarget(null);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setModalBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader title="Modules" subtitle="The feature modules available on this instance" />
      <ErrorBar error={error} />

      <Section
        title="Installed"
        description="Disabling a module hides its pages and stops its services but keeps its data. Modules that others depend on can only be disabled once their dependents are off."
      >
        <ListCard>
          {installed.map((m) => (
            <div key={m.id} className="flex items-center gap-1.5 px-4 py-3">
              <ModuleInfo mod={m} />
              {m.config.length > 0 ? (
                <IconButton label={`Configure ${m.title}`} disabled={busy === m.id} onClick={() => void openConfigure(m)}>
                  <SlidersIcon />
                </IconButton>
              ) : null}
              {!m.entitled ? (
                <span className="dim text-xs" title={`Requires the '${m.entitlement}' entitlement`}>
                  unlicensed
                </span>
              ) : null}
              {!m.enabled && !m.required ? (
                <IconButton label={`Uninstall ${m.title}`} danger disabled={busy === m.id} onClick={() => void uninstall(m)}>
                  <TrashIcon />
                </IconButton>
              ) : null}
              <Switch
                checked={m.enabled}
                disabled={blocked(m, modules) !== null || busy === m.id}
                reason={blocked(m, modules) ?? undefined}
                label={`${m.enabled ? 'Disable' : 'Enable'} ${m.title}`}
                onChange={() => void toggle(m)}
              />
            </div>
          ))}
        </ListCard>
      </Section>

      {available.length > 0 ? (
        <Section
          title="Available"
          description="Part of this build but not installed — installing runs the module's migrations and enables it. Modules that need configuration ask for it first."
        >
          <ListCard subtle>
            {available.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <ModuleInfo mod={m} />
                <button className="btn" disabled={busy === m.id || !m.entitled} onClick={() => void openInstall(m)}>
                  {busy === m.id ? 'Installing…' : 'Install'}
                </button>
              </div>
            ))}
          </ListCard>
        </Section>
      ) : null}

      <OutOfTree modules={modules} />

      {target ? (
        <Modal
          title={`${target.mode === 'install' ? 'Install' : 'Configure'} ${target.mod.title}`}
          onClose={() => setTarget(null)}
        >
          {target.mode === 'configure' && targetState === undefined && modalError === null ? (
            <p className="dim py-4 text-center text-sm">Loading…</p>
          ) : (
            <ModuleConfigForm
              fields={target.mod.config}
              state={targetState}
              busy={modalBusy}
              error={modalError}
              submitLabel={target.mode === 'install' ? 'Install' : 'Save'}
              onSubmit={(patch) => void submitModal(patch)}
              onCancel={() => setTarget(null)}
            />
          )}
        </Modal>
      ) : null}
      {confirmElement}
    </Page>
  );
}

function ModuleInfo({ mod }: { mod: ModuleDescriptor }): JSX.Element {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-1.5">
        <span className="truncate font-medium">{mod.title}</span>
        <span className="dim text-xs">v{mod.version}</span>
        {mod.required ? <span className="badge shrink-0">required</span> : null}
        {mod.external ? <span className="badge shrink-0">out of tree</span> : null}
        {mod.installed && !mod.configured ? <span className="badge shrink-0">needs configuration</span> : null}
      </span>
      <span className="dim mt-0.5 block truncate text-xs">
        {mod.id}
        {mod.dependsOn.length > 0 ? <> · depends on {mod.dependsOn.join(', ')}</> : null}
      </span>
    </span>
  );
}

function SlidersIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="size-4" aria-hidden>
      <path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h12" />
      <circle cx="14" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}

function TrashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden>
      <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6" />
    </svg>
  );
}

/**
 * Why this module's switch cannot be moved, or null when it can.
 *
 * The kernel already refuses each of these; saying so on the control means you
 * find out by hovering rather than by clicking and reading an error. Dependents
 * are computed here rather than served, because the catalog already carries
 * every module's `dependsOn` and a derived field would be a second source for
 * the same fact.
 */
function blocked(m: ModuleDescriptor, all: readonly ModuleDescriptor[]): string | null {
  if (m.required) return 'Required: the instance cannot run without it.';
  if (m.enabled) {
    const dependents = all.filter((o) => o.enabled && o.dependsOn.includes(m.id));
    if (dependents.length) {
      const names = dependents.map((d) => d.title).join(', ');
      return `Disable ${names} first: ${dependents.length === 1 ? 'it depends' : 'they depend'} on ${m.title}.`;
    }
    return null;
  }
  if (!m.entitled) return 'This instance has no licence for it.';
  if (!m.configured) return 'Configure it first: a required setting has no value.';
  const missing = m.dependsOn.filter((d) => !all.some((o) => o.id === d && o.enabled));
  if (missing.length) return `Enable ${missing.join(', ')} first: ${m.title} depends on ${missing.length === 1 ? 'it' : 'them'}.`;
  return null;
}

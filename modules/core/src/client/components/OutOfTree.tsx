import { useState } from 'react';
import { ApiError, type ModuleDescriptor } from '@moxxy/companion-core/client';
import { CopyText, ErrorBar, ListCard, MetaSignal, Section, useConfirm } from '@moxxy/companion-ui';
import type { ExternalModuleRecord, Supervisor } from '../../contract/index.js';
import { modulesApi } from '../api.js';
import { useAuth } from '../lib/auth.js';
import { useExternalModules } from '../hooks/useExternalModules.js';

/**
 * Out-of-tree modules: the ones whose code lives in `$COMPANION_HOME/modules`
 * rather than in this build, which means an admin can put it there and take it
 * away without a redeploy.
 *
 * The section exists because the kernel catalog above cannot answer two
 * questions on its own. The scan runs once at boot, so files added since are
 * real and dormant, and only this list knows about them. And nothing has ever
 * read the provenance ledger back, so "where did this module come from" needed
 * a shell on the host.
 */
export function OutOfTree({ modules }: { modules: readonly ModuleDescriptor[] }): React.JSX.Element {
  const { can } = useAuth();
  const { state, error: loadError, reload } = useExternalModules();
  const { confirmDanger, confirmElement } = useConfirm();
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ label: string; notes: readonly string[] } | null>(null);
  /** The spec whose add failed because that module is already here. */
  const [replaceable, setReplaceable] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const mayDeploy = can('modules:deploy');
  const artifacts = state?.modules ?? [];
  // Files the running daemon has never scanned. Until it restarts they are
  // bytes on a disk, not a module, and the page should not pretend otherwise.
  const dormant = artifacts.filter((a) => !a.loaded);

  /**
   * Replacing is a second decision, so it is a second click rather than a
   * checkbox nobody reads: the first attempt fails naming the version already
   * installed, and only then is there a Replace button to press.
   */
  const add = async (value: string, force: boolean): Promise<void> => {
    if (!value) return;
    setBusy('add');
    setError(null);
    setAdded(null);
    setReplaceable(null);
    try {
      const result = await modulesApi.add(value, force);
      const p = result.provenance;
      setAdded({
        label: `${result.replaced ? `Replaced ${result.id} ${result.replaced} with` : `Added ${result.id}`} ${p.name}@${p.version}`,
        notes: result.notes,
      });
      setSpec('');
      reload();
    } catch (err) {
      // 409 is the daemon saying those files are already there. Upgrading in
      // place is the common case, and the only other way (remove, then add)
      // would drop the module's tables on the way.
      if (err instanceof ApiError && err.status === 409) setReplaceable(value);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const replace = async (value: string): Promise<void> => {
    const ok = await confirmDanger({
      title: 'Replace the installed files',
      message:
        `The files under this module's directory are deleted and written again from ${value}. ` +
        `Its tables and configuration are untouched, but the running daemon keeps the old code until it restarts.`,
      confirmLabel: 'Replace',
    });
    if (ok) await add(value, true);
  };

  const remove = async (a: ExternalModuleRecord): Promise<void> => {
    const ok = await confirmDanger({
      title: `Remove ${a.id}`,
      message:
        `This rolls back ${a.id}'s migrations (dropping its tables), wipes its configuration, and ` +
        `deletes ${a.dir}. Getting it back means adding it again from its registry.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setBusy(a.id);
    setError(null);
    try {
      await modulesApi.remove(a.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Restart, then wait for the daemon to answer again. The session survives
   * (nothing touched the database), so this reloads rather than signing out.
   */
  const restart = async (): Promise<void> => {
    setRestarting(true);
    setError(null);
    try {
      await modulesApi.restart();
    } catch (err) {
      // A dropped connection means the daemon is already going down, which is
      // the expected outcome. Only a real refusal stops here.
      if (err instanceof ApiError) {
        setError(err.message);
        setRestarting(false);
        return;
      }
    }
    const start = Date.now();
    let sawItStop = false;
    while (Date.now() - start < 120_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        // A daemon that is shutting down keeps serving until its modules have
        // wound down, so an early success can be the process that is leaving.
        // Wait to have seen it stop, or long enough that it must have.
        if ((await fetch('/api/auth/state')).ok && (sawItStop || Date.now() - start > 10_000)) {
          return void location.reload();
        }
      } catch {
        sawItStop = true;
      }
    }
    setRestarting(false);
    setError('Companion did not come back within two minutes. Start it again on the host, then reload this page.');
  };

  return (
    <Section
      title="Out of tree"
      description={
        <>
          Modules whose code lives in{' '}
          <code className="code-inline">{state?.root ?? '<home>/modules'}</code> instead of this build. Removing one
          uninstalls it first, so its tables and configuration go with it.
        </>
      }
    >
      <ErrorBar error={error ?? loadError} />

      {dormant.length > 0 ? (
        <div className="banner-info mb-3" role="status">
          <span className="min-w-0">
            {dormant.length === 1 ? `${dormant[0]!.id} is` : `${dormant.length} modules are`} on disk but not loaded:
            Companion scans this directory once, at startup. {restartCopy(state?.supervisor ?? null)}
          </span>
          {mayDeploy ? (
            <button className="btn shrink-0" disabled={restarting} onClick={() => void restart()}>
              {restarting ? 'Restarting…' : 'Restart Companion'}
            </button>
          ) : null}
        </div>
      ) : null}

      {mayDeploy ? (
        <div className="card mb-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input min-w-0 flex-1"
              placeholder="companion-module-reports@1.2.0"
              aria-label="Package to add"
              value={spec}
              disabled={busy === 'add'}
              onChange={(e) => setSpec(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add(spec.trim(), false);
              }}
            />
            <button className="btn" disabled={busy === 'add' || !spec.trim()} onClick={() => void add(spec.trim(), false)}>
              {busy === 'add' ? 'Adding…' : 'Add module'}
            </button>
          </div>
          {replaceable ? (
            <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
              <span>
                That module is already in <code className="code-inline">{state?.root ?? 'the modules directory'}</code>.
                Replacing writes its files again; its tables and configuration stay.
              </span>
              <button className="btn-danger shrink-0" disabled={busy === 'add'} onClick={() => void replace(replaceable)}>
                Replace it
              </button>
            </div>
          ) : null}
          <span className="dim text-xs">
            A package in the configured npm registry: <code className="code-inline">name</code>,{' '}
            <code className="code-inline">@scope/name</code>, optionally with{' '}
            <code className="code-inline">@version</code> or a tag. Paths, tarball URLs and git remotes are only
            accepted by <code className="code-inline">companion module add</code> on the host, because npm builds those
            and would run their install scripts here.
          </span>
          {added ? (
            <span className="text-xs" role="status">
              {added.label}. Restart Companion to load it, then install it above.
              {added.notes.map((n) => (
                <span key={n} className="dim mt-0.5 block">
                  {n}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {artifacts.length === 0 ? (
        <p className="dim text-[13px]">
          {state === null ? 'Loading…' : 'Nothing here. Every module on this instance is compiled into the build.'}
        </p>
      ) : (
        <ListCard subtle>
          {artifacts.map((a) => (
            <Artifact
              key={a.id}
              artifact={a}
              descriptor={modules.find((m) => m.id === a.id)}
              busy={busy === a.id}
              mayDeploy={mayDeploy}
              onRemove={() => void remove(a)}
            />
          ))}
        </ListCard>
      )}
      {confirmElement}
    </Section>
  );
}

function Artifact({
  artifact: a,
  descriptor,
  busy,
  mayDeploy,
  onRemove,
}: {
  artifact: ExternalModuleRecord;
  descriptor: ModuleDescriptor | undefined;
  busy: boolean;
  mayDeploy: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  const p = a.provenance;
  // The kernel refuses to uninstall a running module, so say so on the control
  // rather than after the click.
  const blocked = descriptor?.enabled === true ? `Disable ${a.id} first.` : null;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-1.5">
          <span className="truncate font-medium">{a.id}</span>
          {a.version ? <span className="dim text-xs">v{a.version}</span> : null}
          {a.loaded ? null : <MetaSignal tone="amber" label="restart to load" />}
        </span>
        <span className="dim mt-0.5 block text-xs">
          {a.name ?? a.dir}
          {p ? (
            <>
              {' · from '}
              <code className="code-inline">{p.spec}</code>
              {p.registry ? ` via ${p.registry}` : null}
              {' · added '}
              {new Date(p.addedAt).toLocaleString()}
            </>
          ) : (
            ' · no provenance recorded: these files were copied in, not added'
          )}
        </span>
        {p?.integrity ? (
          <CopyText value={p.integrity} className="dim mt-0.5 block max-w-full text-xs">
            <code className="code-inline truncate">{p.integrity}</code>
          </CopyText>
        ) : null}
      </span>
      {mayDeploy ? (
        <button className="btn-danger" disabled={busy || blocked !== null} title={blocked ?? undefined} onClick={onRemove}>
          {busy ? 'Removing…' : 'Remove'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * What restarting actually does here, which is not the same everywhere and must
 * not be guessed at: under a supervisor the process exits and something starts
 * it again, and under a bare `npx @moxxy/companion` nothing would, so the
 * daemon starts its own replacement before it goes.
 */
function restartCopy(supervisor: Supervisor): string {
  if (supervisor === 'container') {
    return 'Companion runs as PID 1 in a container, so it exits and the container comes back if its restart policy says so.';
  }
  if (supervisor === 'pm2' || supervisor === 'systemd') {
    return `Companion exits and ${supervisor} starts it again.`;
  }
  return 'Nothing is supervising this process, so Companion starts a replacement of itself and then exits. If that fails, start it again on the host.';
}

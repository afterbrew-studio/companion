import { useState } from 'react';
import { ErrorBar, FormActions } from '@moxxy-ai/companion-sdk/ui';
import type { AreaStorageState } from '../../contract/index.js';

/**
 * First-visit storage choice for a knowledge area (Specifications /
 * Documentation): keep items virtual (Companion DB only) or mirror them as
 * markdown under a repo directory — picked from the dirs that exist across
 * the workspace clones, or a new name to be created on first write. Also
 * reused later to change the choice.
 */
export function AreaStorageSetup({
  area,
  defaultDir,
  state,
  onSave,
  onCancel,
}: {
  /** Lowercase area noun for the copy, e.g. "specifications". */
  area: string;
  /** Suggested directory name, e.g. "specs". */
  defaultDir: string;
  state: AreaStorageState;
  onSave: (dir: string | null) => Promise<void>;
  /** Present when reconfiguring (a choice already exists). */
  onCancel?: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<'repo' | 'virtual'>(state.config?.dir === null ? 'virtual' : 'repo');
  const [dir, setDir] = useState(state.config?.dir ?? defaultDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirValid = /^[\w.-]+(\/[\w.-]+)*$/.test(dir.trim());
  const listId = `dirs-${area}`;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSave(mode === 'repo' ? dir.trim() : null);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="card mb-4">
      <h2 className="text-sm font-semibold">Where should {area} live?</h2>
      <p className="dim mt-1 text-[13px]">
        One choice per workspace — individual items can still override it later.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <label
          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${
            mode === 'repo' ? 'border-zinc-500 dark:border-zinc-400' : 'border-zinc-200 dark:border-zinc-800'
          }`}
        >
          <input type="radio" className="mt-0.5" checked={mode === 'repo'} onChange={() => setMode('repo')} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">In the repository</span>
            <span className="dim block text-xs">
              Markdown files under a directory in each repo's clone — agents working on the code see them
              directly. Existing files in the directory are adopted on save.
            </span>
            {mode === 'repo' ? (
              <span className="mt-2 flex items-center gap-2">
                <input
                  className="input w-56 font-mono text-xs"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  list={listId}
                  placeholder={defaultDir}
                  aria-label="Directory name"
                  aria-invalid={dir.trim().length > 0 && !dirValid}
                />
                <datalist id={listId}>
                  {state.dirs.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
                <span className="dim text-xs">pick an existing directory or type a new one</span>
              </span>
            ) : null}
          </span>
        </label>

        <label
          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${
            mode === 'virtual' ? 'border-zinc-500 dark:border-zinc-400' : 'border-zinc-200 dark:border-zinc-800'
          }`}
        >
          <input type="radio" className="mt-0.5" checked={mode === 'virtual'} onChange={() => setMode('virtual')} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Virtual</span>
            <span className="dim block text-xs">Only in Companion — nothing is written into the repos.</span>
          </span>
        </label>
      </div>

      <ErrorBar error={error} />
      <FormActions className="mt-3">
        {onCancel ? (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button className="btn" disabled={busy || (mode === 'repo' && !dirValid)} onClick={() => void save()}>
          {busy ? 'Saving…' : mode === 'repo' ? `Use ${dir.trim() || defaultDir}/` : 'Keep virtual'}
        </button>
      </FormActions>
    </div>
  );
}

/** Header affordance showing the active choice with a change action. */
export function StorageSummary({
  config,
  canManage,
  onChange,
}: {
  config: { dir: string | null };
  canManage: boolean;
  onChange: () => void;
}): JSX.Element {
  return (
    <div className="dim mb-3 flex items-center gap-2 text-xs">
      <span>
        Storage:{' '}
        {config.dir ? <code className="code-inline">{config.dir}/</code> : 'virtual'}
      </span>
      {canManage ? (
        <button className="linkish text-xs" onClick={onChange}>
          change
        </button>
      ) : null}
    </div>
  );
}

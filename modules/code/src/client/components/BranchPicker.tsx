import { useEffect, useMemo, useState } from 'react';
import { Dropdown } from '@companion/ui';
import type { RepoBranchRecord } from '../../contract/index.js';
import { codeApi } from '../api.js';

/** Searchable selector for an existing remote branch of a connected repo. */
export function BranchPicker({
  repo,
  value,
  onChange,
  defaultBranch,
  disabled = false,
  compact = false,
  ariaLabel = 'Branch',
}: {
  repo: string | null;
  value: string;
  onChange: (branch: string) => void;
  defaultBranch?: string;
  disabled?: boolean;
  compact?: boolean;
  ariaLabel?: string;
}): JSX.Element {
  const [branches, setBranches] = useState<RepoBranchRecord[]>([]);
  const [remoteDefault, setRemoteDefault] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setBranches([]);
    setRemoteDefault(null);
    setFailed(false);
    setLoading(Boolean(repo));
    if (!repo) return;
    let cancelled = false;
    void codeApi
      .repoBranches(repo)
      .then((result) => {
        if (cancelled) return;
        setBranches(result.branches);
        setRemoteDefault(result.defaultBranch);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const effectiveDefault = remoteDefault ?? defaultBranch ?? null;
  const options = useMemo(() => {
    const current = value.trim();
    const rows = [...branches];
    if (current && !rows.some((branch) => branch.name === current)) {
      rows.push({ name: current, protected: false });
    }
    return rows
      .sort((a, b) => {
        if (a.name === effectiveDefault) return -1;
        if (b.name === effectiveDefault) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((branch) => {
        const hints = [branch.name === effectiveDefault ? 'default' : '', branch.protected ? 'protected' : ''].filter(Boolean);
        return { value: branch.name, label: branch.name, hint: hints.join(' · ') || undefined };
      });
  }, [branches, effectiveDefault, value]);

  return (
    <div className={compact ? 'w-52 min-w-0' : 'min-w-0'}>
      <Dropdown
        ariaLabel={ariaLabel}
        value={value || null}
        onChange={onChange}
        options={options}
        placeholder={loading ? 'Loading branches…' : 'Select branch…'}
        searchable
        maxVisible={100}
        disabled={disabled || !repo}
        triggerClassName={
          compact
            ? 'flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-zinc-300 bg-white px-2.5 text-left font-mono text-xs transition-colors hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-500'
            : undefined
        }
      />
      {failed ? <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">Could not refresh branches from GitHub.</p> : null}
    </div>
  );
}

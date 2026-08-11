import { useCallback, useEffect, useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  Field,
  ListCard,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  SearchInput,
  timeAgo,
} from '@moxxy/companion-ui';
import type { AuditRecord, ForwarderState } from '../../contract/index.js';
import { coreApi as api } from '../api.js';

const WINDOWS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '0', label: 'Everything' },
];

/**
 * The audit trail, read.
 *
 * The API has been complete for a while (keyset-paged list plus an NDJSON
 * export); what was missing was anywhere to look without curl, which in practice
 * meant the trail existed for compliance and not for use.
 *
 * Paging is keyset, following the API rather than fighting it: "load more" passes
 * the last id it saw. An OFFSET-based page control would have looked identical
 * and quietly scanned the whole table on page 40.
 */
export function AuditPage(): React.JSX.Element {
  const [entries, setEntries] = useState<AuditRecord[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [actor, setActor] = useState('');
  const [days, setDays] = useState('7');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [forwarding, setForwarding] = useState<ForwarderState | null>(null);

  const since = days === '0' ? undefined : Date.now() - Number(days) * 24 * 60 * 60_000;

  const load = useCallback(
    async (before?: number): Promise<void> => {
      setLoading(true);
      try {
        const page = await api.audit({ actor: actor.trim() || undefined, since, before, limit: 100 });
        setEntries((current) => (before === undefined ? page.entries : [...(current ?? []), ...page.entries]));
        // A short page means the end; nextBefore from the server would otherwise
        // offer a "load more" that returns nothing.
        setNextBefore(page.entries.length < 100 ? null : page.nextBefore);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    // `since` is derived from days and would change every render if included.
    [actor, days], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api
      .auditForwarding()
      .then(setForwarding)
      .catch(() => setForwarding(null));
  }, []);

  if (entries === null && error === null) return <PageLoading label="Loading the audit trail…" />;

  // Refusals are the reason this page exists, so they get their own filter.
  const shown = failuresOnly ? (entries ?? []).filter((e) => e.status >= 400) : (entries ?? []);

  return (
    <Page>
      <PageHeader
        title="Audit trail"
        subtitle="Every mutating call, including the ones that were refused"
        actions={
          <button className="btn-ghost" onClick={() => void downloadExport(since, setError)}>
            Export NDJSON
          </button>
        }
      />
      <ErrorBar error={error} />
      {forwarding?.configured ? <ForwardingLine state={forwarding} /> : null}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Actor">
          <SearchInput value={actor} onChange={setActor} placeholder="username" ariaLabel="Filter by actor" />
        </Field>
        <Field label="Window">
          <select className="input input-sm" value={days} onChange={(e) => setDays(e.target.value)}>
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} />
          Refusals only
        </label>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title="Nothing recorded in this window"
          hint="Reads are deliberately not audited: in an append-only table they would bury the writes."
        />
      ) : (
        <ListCard ariaLabel="Audit entries">
          {shown.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <span className="w-28 shrink-0 font-mono text-xs">{entry.actor ?? 'system'}</span>
              <MetaSignal
                tone={entry.status >= 400 ? 'red' : 'green'}
                label={String(entry.status)}
                title={entry.status >= 400 ? 'refused' : 'succeeded'}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.action}</span>
              <span className="dim shrink-0 text-xs">{entry.module ?? 'framework'}</span>
              <span className="dim shrink-0 text-xs" title={new Date(entry.at).toLocaleString()}>
                {timeAgo(entry.at)}
              </span>
              {entry.detail ? <span className="dim w-full text-xs">{entry.detail}</span> : null}
            </div>
          ))}
        </ListCard>
      )}

      {nextBefore !== null ? (
        <button className="btn-ghost mt-3" disabled={loading} onClick={() => void load(nextBefore)}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </Page>
  );
}

/** Whether the outbound stream is keeping up. Only rendered when one is configured. */
function ForwardingLine({ state }: { state: ForwarderState }): React.JSX.Element {
  const healthy = state.lastError === null;
  return (
    <div className={healthy ? 'banner-info mb-3 text-xs' : 'error-bar mb-3 text-xs'} role="status">
      Forwarding to an external collector.{' '}
      {healthy
        ? state.lastDeliveryAt === null
          ? 'Nothing has been shipped yet.'
          : `Last batch delivered ${timeAgo(state.lastDeliveryAt)}.`
        : `Last attempt failed: ${state.lastError}.`}
      {state.buffered > 0 ? ` ${state.buffered} waiting.` : ''}
      {state.dropped > 0
        ? ` ${state.dropped} dropped since boot because the buffer filled; export can backfill them.`
        : ''}
    </div>
  );
}

/**
 * Fetch the export with the browser's HttpOnly session cookie and hand it a blob.
 */
async function downloadExport(since: number | undefined, onError: (message: string) => void): Promise<void> {
  try {
    const res = await fetch(`/api/audit/export${since === undefined ? '' : `?since=${since}`}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`export failed: ${res.status} ${res.statusText}`.trim());
    const url = URL.createObjectURL(await res.blob());
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = 'companion-audit.ndjson';
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
}

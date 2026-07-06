import { useCallback, useEffect, useState } from 'react';
import type { MoxxyStatus } from '@companion/contract';
import { api } from '../lib/api.js';
import { Page, PageHeader } from '../components/ui.js';

/** Instance administration: moxxy runtime, GitHub PAT. */
export function SettingsPage(): JSX.Element {
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: string[]; missing: string[] } | null>(null);

  const reimport = async (): Promise<void> => {
    setImporting(true);
    setError(null);
    setImportResult(null);
    try {
      setImportResult(await api.importProviders());
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Runtime — GitHub accounts moved to their own page" />
      {error ? <div className="error-bar">{error}</div> : null}

      <section className="card" aria-labelledby="moxxy-heading">
        <h2 id="moxxy-heading" className="text-sm font-semibold">
          moxxy runtime
        </h2>
        {status ? (
          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="dim">CLI</dt>
            <dd>
              {status.cliPath ? (
                <>
                  <code>{status.cliPath}</code>{' '}
                  <span className={status.compatible ? 'badge-ok' : 'badge-danger'}>
                    {status.cliVersion} {status.compatible ? '' : '(too old)'}
                  </span>
                </>
              ) : (
                <span className="badge-danger">not found — npm i -g @moxxy/cli</span>
              )}
            </dd>
            <dt className="dim">Home</dt>
            <dd>
              <code>{status.homeDir}</code>{' '}
              <span className={status.homeReady ? 'badge-ok' : 'badge-warn'}>
                {status.homeReady ? 'ready' : 'not ready'}
              </span>
            </dd>
            <dt className="dim">Providers</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {status.providersImported ? <span className="badge-ok">imported</span> : null}
              <button
                className={status.providersImported ? 'btn-ghost' : 'btn'}
                disabled={importing}
                onClick={() => void reimport()}
                title="Copies config.yaml and re-links providers.json / vault to ~/.moxxy (shared token rotation)"
              >
                {importing ? 'Importing…' : status.providersImported ? 'Re-import from ~/.moxxy' : 'Import from ~/.moxxy'}
              </button>
            </dd>
          </dl>
        ) : (
          <p className="dim mt-2 text-[13px]">Loading…</p>
        )}
        {importResult ? (
          <div className="banner-info mb-0" role="status">
            <span className="min-w-0">
              {importResult.imported.length > 0 ? (
                <>
                  Imported: <code className="text-xs">{importResult.imported.join(', ')}</code>.{' '}
                </>
              ) : (
                'Nothing imported. '
              )}
              {importResult.missing.length > 0 ? (
                <>
                  Missing in <code className="text-xs">~/.moxxy</code>:{' '}
                  <code className="text-xs">{importResult.missing.join(', ')}</code>.{' '}
                </>
              ) : null}
              Live runs keep their old credentials — new runs pick this up.
            </span>
          </div>
        ) : null}
      </section>

    </Page>
  );
}

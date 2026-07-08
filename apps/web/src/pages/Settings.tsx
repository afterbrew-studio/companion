import { useRef, useState } from 'react';
import type { MoxxyStatus } from '@companion/contract';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useMoxxyStatus } from '../hooks/useMoxxyStatus.js';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme.js';
import { Page, Dropdown, PageHeader, Section } from '../components/ui.js';

/** Reduce an uploaded logo to a small inline data URL before it hits the DB. */
async function fileToLogoDataUrl(file: File): Promise<string> {
  if (file.type === 'image/svg+xml') {
    if (file.size > 200_000) throw new Error('SVG logo must be under 200 KB');
    const text = await file.text();
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    throw new Error('Use a PNG, JPEG, WebP, or SVG image');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read the image'));
      el.src = url;
    });
    const scale = Math.min(1, 128 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Instance administration: branding, appearance, moxxy runtime. */
export function SettingsPage(): JSX.Element {
  const { branding, setBranding } = useAuth();
  const { status, error, setError, refresh } = useMoxxyStatus();
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: string[]; missing: string[] } | null>(null);

  // Branding draft; Save pushes it to the daemon and into the auth context.
  const [name, setName] = useState(branding.name ?? '');
  const [logo, setLogo] = useState<string | null>(branding.logo);
  const [savingBrand, setSavingBrand] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const brandDirty = (name.trim() || null) !== (branding.name ?? null) || logo !== branding.logo;

  const [theme, setTheme] = useState<ThemePref>(getThemePref);

  const onLogoFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    try {
      setLogo(await fileToLogoDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveBranding = async (): Promise<void> => {
    setSavingBrand(true);
    setError(null);
    try {
      const { branding: saved } = await api.setBranding({ name: name.trim() || null, logo });
      setBranding(saved);
      setName(saved.name ?? '');
      setLogo(saved.logo);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBrand(false);
    }
  };

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

  const previewName = name.trim() || 'Companion';

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Branding, appearance, and the moxxy runtime" />
      {error ? <div className="error-bar">{error}</div> : null}

      <Section
        title="Branding"
        description="How this install presents itself — sidebar, tab title, and the sign-in screen."
      >
        <div className="card flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            {logo ? (
              <img src={logo} alt="Instance logo" className="size-11 shrink-0 rounded-xl object-cover" />
            ) : (
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-lg font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
                {previewName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  void onLogoFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button className="btn-ghost" onClick={() => fileInput.current?.click()}>
                {logo ? 'Replace logo' : 'Upload logo'}
              </button>
              {logo ? (
                <button className="btn-ghost" onClick={() => setLogo(null)}>
                  Remove
                </button>
              ) : null}
              <span className="dim">PNG, JPEG, WebP, or SVG — scaled down to 128 px.</span>
            </div>
          </div>
          <label className="flex max-w-sm flex-col gap-1 text-sm">
            <span className="dim">Instance name</span>
            <input
              className="input"
              maxLength={40}
              placeholder="Companion"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button className="btn" disabled={!brandDirty || savingBrand} onClick={() => void saveBranding()}>
              {savingBrand ? 'Saving…' : 'Save branding'}
            </button>
            {brandDirty && !savingBrand ? <span className="dim">Unsaved changes</span> : null}
          </div>
        </div>
      </Section>

      <Section title="Appearance" description="Theme is a per-browser preference; it applies immediately.">
        <div className="card flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-medium">Theme</span>
          <Dropdown
            ariaLabel="Theme"
            value={theme}
            onChange={(v) => {
              setTheme(v as ThemePref);
              setThemePref(v as ThemePref);
            }}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </Section>

      <Section title="moxxy runtime" description="The CLI and home directory agent runs execute against.">
        <div className="card" aria-labelledby="moxxy-heading">
          {status ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
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
            <p className="dim text-[13px]">Loading…</p>
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
        </div>
      </Section>
    </Page>
  );
}

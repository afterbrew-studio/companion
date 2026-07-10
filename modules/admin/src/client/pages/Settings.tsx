import { useEffect, useRef, useState } from 'react';
import { ApiError, refreshAuth } from '@companion/core/client';
import { useAuth } from '@companion/module-core/client';
import { useMoxxyStatus } from '@companion/module-operate/client';
import {
  Avatar,
  ErrorBar,
  Field,
  InlineLoading,
  ListCard,
  MetaSignal,
  Page,
  PageHeader,
  Section,
  SettingRow,
  Switch,
  useConfirm,
} from '@companion/ui';
import type { NotificationScope } from '../../contract/index.js';
import { adminApi as api } from '../api.js';

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
  const { branding, setBranding, logout } = useAuth();
  const { status, error, setError, refresh } = useMoxxyStatus();
  const { confirmDanger, confirmElement } = useConfirm();
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: string[]; missing: string[] } | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeResult, setUpgradeResult] = useState<string | null>(null);

  // Branding draft; Save pushes it to the daemon and into the auth context.
  const [name, setName] = useState(branding.name ?? '');
  const [logo, setLogo] = useState<string | null>(branding.logo);
  const [savingBrand, setSavingBrand] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const brandDirty = (name.trim() || null) !== (branding.name ?? null) || logo !== branding.logo;

  // Instance-wide inbox default. Each user can override it in their profile;
  // this is only the fallback for anyone who hasn't.
  const [defaultScope, setDefaultScope] = useState<NotificationScope | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getNotificationSettings()
      .then((s) => alive && setDefaultScope(s.defaultScope))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const saveScope = async (next: NotificationScope): Promise<void> => {
    const prev = defaultScope;
    setDefaultScope(next);
    try {
      await api.setNotificationSettings(next);
      // Re-resolve the session so an admin who inherits the default sees their
      // own inbox update immediately.
      refreshAuth();
    } catch (err) {
      setDefaultScope(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Wipe-and-restart: the daemon acknowledges, drops the recreate marker and
  // exits; its supervisor restarts it onto a fresh database. We poll the public
  // state endpoint until it's back, then drop the (now-invalid) session and
  // reload into first-boot setup.
  const [recreating, setRecreating] = useState(false);
  const recreate = async (): Promise<void> => {
    const ok = await confirmDanger({
      title: 'Recreate database',
      message:
        'Every user, workspace, repository connection, run and setting on this instance will be permanently deleted, and first-boot setup will run again. Repository clones on disk are kept.',
      confirmLabel: 'Recreate database',
    });
    if (!ok) return;
    setRecreating(true);
    setError(null);
    try {
      await api.recreateDb();
    } catch (err) {
      // A real rejection (403, 404) stops here; a dropped connection just means
      // the daemon is already going down — proceed to waiting for it.
      if (err instanceof ApiError) {
        setError(err.message);
        setRecreating(false);
        return;
      }
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const res = await fetch('/api/auth/state');
        if (res.ok) {
          await logout().catch(() => undefined);
          location.hash = '';
          location.reload();
          return;
        }
      } catch {
        // still restarting
      }
    }
    setRecreating(false);
    setError('The daemon did not come back within two minutes — restart it manually, then reload this page.');
  };

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

  // In-place `npm i -g @moxxy/cli@latest`; the daemon re-detects and the local
  // runner re-advertises, so a refresh is all the UI needs afterwards.
  const upgradeCli = async (): Promise<void> => {
    setUpgrading(true);
    setError(null);
    setUpgradeResult(null);
    try {
      const r = await api.upgradeMoxxyCli();
      setUpgradeResult(
        r.previous === r.version
          ? `Already the latest (v${r.version}).`
          : `Upgraded ${r.previous ? `v${r.previous} → ` : 'to '}v${r.version}. Live runs keep their gateway; new runs use it.`,
      );
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setUpgrading(false);
    }
  };

  const previewName = name.trim() || 'Companion';

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Branding, appearance, and the moxxy runtime" />
      <ErrorBar error={error} />

      <Section
        title="Branding"
        description="How this install presents itself — sidebar, tab title, and the sign-in screen."
      >
        <div className="card flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Same brand tile as the sign-in screen, so the preview is honest. */}
            <Avatar name={previewName} src={logo ?? undefined} size="xl" brand />
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
          <Field label="Instance name" className="max-w-sm">
            <input
              className="input"
              maxLength={40}
              placeholder="Companion"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2">
            <button className="btn" disabled={!brandDirty || savingBrand} onClick={() => void saveBranding()}>
              {savingBrand ? 'Saving…' : 'Save branding'}
            </button>
            {brandDirty && !savingBrand ? <span className="dim">Unsaved changes</span> : null}
          </div>
        </div>
      </Section>

      <Section
        title="Notifications"
        description="The default inbox scope for everyone. Each user can override it under their own profile."
      >
        <div className="card">
          <SettingRow
            title="Show notifications from all workspaces by default"
            description="Off — the inbox is scoped to the workspace you have open (plus instance-wide events). On — it aggregates every workspace a user can access."
          >
            <Switch
              label="Show notifications from all workspaces by default"
              checked={defaultScope === 'global'}
              disabled={defaultScope === null}
              onChange={(v) => void saveScope(v ? 'global' : 'workspace')}
            />
          </SettingRow>
        </div>
      </Section>

      {/* Run scheduling (reserved runner slots) lives in module config now — Modules → Operate → Configure. */}

      <Section title="moxxy runtime" description="The CLI and home directory agent runs execute against.">
        {status ? (
          <ListCard subtle>
            <SettingRow
              className="px-3.5 py-2.5"
              title={
                <span className="flex flex-wrap items-center gap-2">
                  CLI
                  {status.cliPath ? (
                    <MetaSignal
                      tone={status.compatible ? 'green' : 'red'}
                      label={`v${status.cliVersion}${status.compatible ? '' : ' — too old'}`}
                    />
                  ) : (
                    <MetaSignal tone="red" label="not found" />
                  )}
                </span>
              }
              description={
                <>
                  <code className="code-inline">{status.cliPath ?? 'npm i -g @moxxy/cli'}</code>
                  {upgradeResult ? (
                    <span role="status"> · {upgradeResult}</span>
                  ) : null}
                </>
              }
            >
              <button
                className={status.compatible ? 'btn-ghost' : 'btn'}
                disabled={upgrading}
                onClick={() => void upgradeCli()}
                title="Runs npm i -g @moxxy/cli@latest on the daemon's machine"
              >
                {upgrading ? 'Upgrading…' : status.cliPath ? 'Upgrade to latest' : 'Install CLI'}
              </button>
            </SettingRow>
            <SettingRow
              className="px-3.5 py-2.5"
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Home
                  <MetaSignal tone={status.homeReady ? 'green' : 'amber'} label={status.homeReady ? 'ready' : 'not ready'} />
                </span>
              }
              description={<code className="code-inline">{status.homeDir}</code>}
            />
            <SettingRow
              className="px-3.5 py-2.5"
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Providers
                  {status.providersImported ? <MetaSignal tone="green" label="imported" /> : null}
                </span>
              }
              description="Copies config.yaml and re-links providers.json / vault from ~/.moxxy."
            >
              <button
                className={status.providersImported ? 'btn-ghost' : 'btn'}
                disabled={importing}
                onClick={() => void reimport()}
              >
                {importing ? 'Importing…' : status.providersImported ? 'Re-import from ~/.moxxy' : 'Import from ~/.moxxy'}
              </button>
            </SettingRow>
          </ListCard>
        ) : (
          <div className="card">
            <InlineLoading />
          </div>
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
      </Section>

      <Section title="Danger zone" description="Destructive instance-level operations. There is no undo.">
        <div className="card">
          <SettingRow
            title="Recreate database"
            description={
              recreating
                ? 'Waiting for the daemon to come back with a fresh database…'
                : 'Deletes every user, workspace, repository connection, run and setting, then restarts into first-boot setup.'
            }
          >
            <button className="btn-danger" disabled={recreating} onClick={() => void recreate()}>
              {recreating ? 'Restarting…' : 'Recreate database…'}
            </button>
          </SettingRow>
        </div>
      </Section>
      {confirmElement}
    </Page>
  );
}

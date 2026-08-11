import { useEffect, useMemo, useState } from 'react';
import type { AuthMode, NavigationPerspective } from '@moxxy/companion-contracts';
import {
  navigationEntryVisible,
  refreshAuth,
  useKernel,
  type NavEntry,
  type NavSection,
} from '@moxxy/companion-core/client';
import {
  CopyText,
  DetailGrid,
  DetailRow,
  Dropdown,
  ErrorBar,
  Field,
  ListCard,
  Page,
  PageHeader,
  Section,
  SettingRow,
  Skeleton,
  Switch,
} from '@moxxy/companion-ui';
import type { AccountInfo, MfaEnrollment, NotificationScope } from '../../contract/index.js';
import { coreApi } from '../api.js';
import { useAuth } from '../lib/auth.js';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme.js';

/** null = "use the instance default"; the concrete scopes override it. */
type ScopeChoice = NotificationScope | 'default';

/**
 * The signed-in user's own settings — reachable from the sidebar name. The
 * account (name, email, password) is theirs to edit; role stays admin-managed.
 * Appearance is per-browser; an unset inbox scope inherits the instance default.
 */
export function ProfilePage(): React.JSX.Element {
  const {
    authMode,
    can,
    navOverrides,
    navigationAudience,
    navPerspective,
    setNavOverrides,
    setNavPerspective,
  } = useAuth();
  const kernel = useKernel();
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [error, setError] = useState<string | null>(null);
  const navigationSections = useMemo(
    () =>
      kernel.sections
        .filter((section) => section.placement === undefined || section.placement === 'sidebar')
        .map((section) => ({
          section,
          entries: kernel.nav.filter(
            (entry) =>
              entry.section === section.id &&
              can(entry.permission) &&
              (!entry.authModes || entry.authModes.includes(authMode)),
          ),
        }))
        .filter(({ entries }) => entries.length > 0),
    [authMode, can, kernel.nav, kernel.sections],
  );
  const currentOverrides = useMemo(
    () => navOverrides.filter((override) => override.perspective === navigationAudience),
    [navOverrides, navigationAudience],
  );
  const viewLabel = navigationAudience === 'business'
    ? 'Business'
    : navigationAudience === 'developer'
      ? 'Developer'
      : 'Admin';

  const setPageVisible = (entry: NavEntry, section: NavSection, visible: boolean): void => {
    const withoutEntry = navOverrides.filter(
      (override) => override.perspective !== navigationAudience || override.key !== entry.key,
    );
    const presetVisible = navigationEntryVisible(entry, section, navigationAudience, []);
    const next = visible === presetVisible
      ? withoutEntry
      : [...withoutEntry, { perspective: navigationAudience, key: entry.key, visible }];
    setError(null);
    void setNavOverrides(next).catch((err) => setError(String(err)));
  };

  return (
    <Page>
      <PageHeader title="Your profile" subtitle="Your navigation, account, appearance, and notifications" />
      <ErrorBar error={error} />

      <Section
        title="Navigation"
        description="Each view starts from a useful preset. The switches below customise that view and always mirror the current sidebar. Hidden pages remain available in Search and through links."
      >
        <SettingRow
          className="card"
          title="Menu view"
          description={`Business shows planning, Developer shows delivery, and Admin starts with every permitted area. The active preset is ${viewLabel}.`}
        >
          <Dropdown<NavigationPerspective>
            ariaLabel="Menu view"
            value={navPerspective}
            onChange={(value) => void setNavPerspective(value).catch((err) => setError(String(err)))}
            options={[
              { value: 'auto', label: 'Automatic', hint: 'Uses the best menu for your role' },
              { value: 'business', label: 'Business', hint: 'Home, workspace and planning' },
              { value: 'developer', label: 'Developer', hint: 'Home, workspace, code and agents' },
              { value: 'admin', label: 'Admin', hint: 'Every permitted area' },
            ]}
          />
        </SettingRow>

        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium">Pages in the sidebar</div>
            <div className="dim mt-0.5 text-xs">Customising the {viewLabel} view</div>
          </div>
          {currentOverrides.length > 0 ? (
            <button
              type="button"
              className="linkish text-xs"
              onClick={() => {
                const next = navOverrides.filter((override) => override.perspective !== navigationAudience);
                void setNavOverrides(next).catch((err) => setError(String(err)));
              }}
            >
              Reset view
            </button>
          ) : null}
        </div>
        <ListCard className="mt-2" ariaLabel="Sidebar page visibility">
          {navigationSections.map(({ section, entries }) => (
            <div key={section.id} className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
              <div className="dim bg-zinc-50/70 px-3 py-2 text-[10px] font-medium tracking-widest uppercase dark:bg-zinc-900/40">
                {section.label}
              </div>
              {entries.map((entry) => {
                const presetVisible = navigationEntryVisible(entry, section, navigationAudience, []);
                const visible = navigationEntryVisible(entry, section, navigationAudience, navOverrides);
                const customised = currentOverrides.some((override) => override.key === entry.key);
                const status = customised
                  ? visible
                    ? `Added to ${viewLabel}`
                    : `Hidden from ${viewLabel}`
                  : presetVisible
                    ? null
                    : `Not in the ${viewLabel} preset`;
                return (
                  <div key={entry.key} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="dim shrink-0">{entry.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{entry.label}</span>
                      {status ? <span className="dim mt-0.5 block text-[11px]">{status}</span> : null}
                    </span>
                    <Switch
                      checked={visible}
                      label={`Show ${entry.label} in the ${navigationAudience} sidebar`}
                      onChange={(nextVisible) => setPageVisible(entry, section, nextVisible)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </ListCard>
      </Section>

      <AccountSection authMode={authMode} onError={setError} />

      {authMode === 'password' ? <MfaSection onError={setError} /> : null}

      <Section title="Appearance" description="How Companion looks on this browser.">
        <SettingRow className="card" title="Theme">
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
        </SettingRow>
      </Section>

      <NotificationSection onError={setError} />
    </Page>
  );
}

/** Editable account details plus a separate password change. */
function AccountSection({
  authMode,
  onError,
}: {
  authMode: AuthMode;
  onError: (e: string | null) => void;
}): React.JSX.Element {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [saved, setSaved] = useState(false);

  // Password change (kept apart from the profile save).
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    coreApi
      .getAccount()
      .then(({ account }) => {
        if (!alive) return;
        setAccount(account);
        setDisplayName(account.displayName);
        setEmail(account.email);
      })
      .catch((e) => alive && onError(String(e)));
    return () => {
      alive = false;
    };
  }, [onError]);

  const dirty =
    account !== null && (displayName.trim() !== account.displayName || email.trim() !== account.email);

  const saveProfile = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!dirty) return;
    setSavingProfile(true);
    setSaved(false);
    onError(null);
    try {
      const { account: updated } = await coreApi.updateAccount({
        displayName: displayName.trim(),
        email: email.trim(),
      });
      setAccount(updated);
      setDisplayName(updated.displayName);
      setEmail(updated.email);
      setSaved(true);
      // The display name shows in the sidebar — re-resolve the session so it updates.
      refreshAuth();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProfile(false);
    }
  };

  const canChangePw =
    currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  const changePassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canChangePw) return;
    setChangingPw(true);
    setPwMsg(null);
    onError(null);
    try {
      await coreApi.updateAccount({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwMsg('Password changed.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setChangingPw(false);
    }
  };

  return (
    <Section title="Account" description="Your name and email. Only an admin can change your role.">
      <form className="card flex flex-col gap-4" onSubmit={(e) => void saveProfile(e)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name">
            <input
              className="input"
              maxLength={60}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={account === null}
            />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              maxLength={200}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={account === null}
            />
          </Field>
        </div>
        <DetailGrid>
          <DetailRow label="Username">
            <code>{account?.username ?? '…'}</code>
          </DetailRow>
          <DetailRow label="Role">
            <span className="capitalize">{account?.role ?? '…'}</span>
          </DetailRow>
        </DetailGrid>
        <div className="flex items-center gap-2">
          <button className="btn" type="submit" disabled={!dirty || savingProfile}>
            {savingProfile ? 'Saving…' : 'Save changes'}
          </button>
          {saved && !dirty ? <span className="dim text-[13px]">Saved.</span> : null}
        </div>
      </form>

      {authMode === 'password' ? (
        <form className="card mt-3 flex flex-col gap-4" onSubmit={(e) => void changePassword(e)}>
          {/* Password managers associate this otherwise separate form with the
              signed-in account through the standard autocomplete pair. */}
          <input
            className="sr-only"
            type="text"
            name="username"
            autoComplete="username"
            value={account?.username ?? ''}
            readOnly
            tabIndex={-1}
            aria-label="Username"
          />
          <div className="text-[13px] font-medium">Change password</div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Current password">
              <input
                className="input"
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </Field>
            <Field label="New password">
              <input
                className="input"
                type="password"
                name="newPassword"
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
            <Field label="Confirm new password">
              <input
                className="input"
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn" type="submit" disabled={!canChangePw || changingPw}>
              {changingPw ? 'Changing…' : 'Change password'}
            </button>
            {newPassword.length > 0 && newPassword.length < 8 ? (
              <span className="dim text-[13px]">At least 8 characters.</span>
            ) : confirmPassword.length > 0 && newPassword !== confirmPassword ? (
              <span className="dim text-[13px]">Passwords don&apos;t match.</span>
            ) : pwMsg ? (
              <span className="dim text-[13px]">{pwMsg}</span>
            ) : null}
          </div>
        </form>
      ) : null}
    </Section>
  );
}

/**
 * TOTP second factor: enroll (secret shown as copyable text, no QR; every
 * authenticator app accepts manual entry), confirm, recovery codes, turn off.
 */
function MfaSection({ onError }: { onError: (e: string | null) => void }): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [manageCode, setManageCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    coreApi
      .getAccount()
      .then(({ account }) => alive && setEnabled(account.mfaEnabled))
      .catch((e) => alive && onError(String(e)));
    return () => {
      alive = false;
    };
  }, [onError]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Two-factor authentication"
      description="A one-time code from an authenticator app, required at every password sign-in."
    >
      <div className="card flex flex-col gap-3">
        {enabled === null ? (
          <Skeleton className="h-9 w-64" />
        ) : recoveryCodes ? (
          <>
            <div className="text-[13px] font-medium">Recovery codes</div>
            <p className="dim text-xs">
              Each signs you in once if you lose the authenticator. They are shown only now; store them
              somewhere safe.
            </p>
            <ul className="grid gap-1 font-mono text-xs sm:grid-cols-2">
              {recoveryCodes.map((code) => (
                <li key={code}>
                  <CopyText value={code} ariaLabel={`Copy recovery code ${code}`}>
                    <code>{code}</code>
                  </CopyText>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <CopyText value={recoveryCodes.join('\n')} ariaLabel="Copy all recovery codes">
                <span className="linkish text-xs">Copy all</span>
              </CopyText>
              <button className="btn" type="button" onClick={() => setRecoveryCodes(null)}>
                I saved them
              </button>
            </div>
          </>
        ) : enrollment ? (
          <>
            <div className="text-[13px] font-medium">Add to your authenticator app</div>
            <p className="dim text-xs">
              Enter this key manually (Companion shows it as text rather than a QR code), or paste the
              full otpauth link if your app takes one. Then confirm with the 6-digit code it produces.
            </p>
            <DetailGrid>
              <DetailRow label="Key">
                <CopyText value={enrollment.secret} ariaLabel="Copy the setup key">
                  <code className="break-all">{enrollment.secret}</code>
                </CopyText>
              </DetailRow>
              <DetailRow label="otpauth link">
                <CopyText value={enrollment.otpauthUri} ariaLabel="Copy the otpauth link">
                  <code className="break-all text-[11px]">{enrollment.otpauthUri}</code>
                </CopyText>
              </DetailRow>
            </DetailGrid>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const { recoveryCodes: codes } = await coreApi.confirmMfa(confirmCode.trim());
                  setRecoveryCodes(codes);
                  setEnrollment(null);
                  setConfirmCode('');
                  setEnabled(true);
                });
              }}
            >
              <Field label="Code from the app">
                <input
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                />
              </Field>
              <button className="btn" type="submit" disabled={busy || confirmCode.trim().length < 6}>
                Turn on
              </button>
              <button className="btn-ghost" type="button" onClick={() => setEnrollment(null)}>
                Cancel
              </button>
            </form>
          </>
        ) : enabled ? (
          <>
            <div className="flex items-center gap-2 text-[13px]">
              <span className="badge-ok">on</span>
              Signing in requires your password and a code.
            </div>
            <form className="flex items-end gap-2" onSubmit={(e) => e.preventDefault()}>
              <Field label="Current code (or a recovery code)">
                <input
                  className="input"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={manageCode}
                  onChange={(e) => setManageCode(e.target.value)}
                />
              </Field>
              <button
                className="btn-ghost"
                type="button"
                disabled={busy || manageCode.trim().length < 6}
                onClick={() =>
                  void run(async () => {
                    const { recoveryCodes: codes } = await coreApi.regenerateRecoveryCodes(manageCode.trim());
                    setRecoveryCodes(codes);
                    setManageCode('');
                  })
                }
              >
                New recovery codes
              </button>
              <button
                className="btn-danger-ghost"
                type="button"
                disabled={busy || manageCode.trim().length < 6}
                onClick={() =>
                  void run(async () => {
                    await coreApi.disableMfa(manageCode.trim());
                    setManageCode('');
                    setEnabled(false);
                  })
                }
              >
                Turn off
              </button>
            </form>
            <p className="dim text-xs">
              Regenerating replaces every previous recovery code. Lost the authenticator and the codes?
              An administrator can reset two-factor from the Users page.
            </p>
          </>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="dim text-[13px]">
              Off. Protect this account with one-time codes from an authenticator app.
            </p>
            <button className="btn" type="button" disabled={busy} onClick={() => void run(async () => setEnrollment(await coreApi.enrollMfa()))}>
              Set up
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

/** Inbox scope preference (per-user override of the instance default). */
function NotificationSection({ onError }: { onError: (e: string | null) => void }): React.JSX.Element {
  const [choice, setChoice] = useState<ScopeChoice | null>(null);
  const [defaultScope, setDefaultScope] = useState<NotificationScope>('workspace');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    coreApi
      .getProfile()
      .then((p) => {
        if (!alive) return;
        setChoice(p.profile.notificationScope ?? 'default');
        setDefaultScope(p.defaults.notificationScope);
      })
      .catch((e) => alive && onError(String(e)));
    return () => {
      alive = false;
    };
  }, [onError]);

  const saveScope = async (next: ScopeChoice): Promise<void> => {
    const prev = choice;
    setChoice(next);
    setSaving(true);
    onError(null);
    try {
      await coreApi.updateProfile({ notificationScope: next === 'default' ? null : next });
      // The effective scope lives on the session — re-resolve so the bell and
      // Inbox page pick up the change immediately.
      refreshAuth();
    } catch (e) {
      setChoice(prev);
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const defaultLabel = defaultScope === 'global' ? 'All workspaces' : 'This workspace only';

  return (
    <Section
      title="Notifications"
      description="Which workspaces' notifications reach your inbox and the header bell."
    >
      <SettingRow
        className="card"
        title="Inbox scope"
        description={
          choice === null
            ? undefined
            : saving
              ? 'Saving…'
              : choice === 'global'
                ? 'You see notifications from every workspace you can access.'
                : choice === 'workspace'
                  ? 'You only see the workspace you have open (plus instance-wide events).'
                  : 'Follows whatever the administrator sets for the instance.'
        }
      >
        {choice === null ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <Dropdown<ScopeChoice>
            ariaLabel="Inbox scope"
            value={choice}
            onChange={(v) => void saveScope(v)}
            options={[
              { value: 'default', label: `Use instance default (${defaultLabel})` },
              { value: 'workspace', label: 'This workspace only' },
              { value: 'global', label: 'All workspaces' },
            ]}
          />
        )}
      </SettingRow>
    </Section>
  );
}

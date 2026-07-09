import { useEffect, useState } from 'react';
import type { AccountInfo, NotificationScope } from '@companion/contract';
import { api, refreshAuth } from '../lib/api.js';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme.js';
import { Page, PageHeader, Section, Dropdown } from '../components/ui.js';

/** null = "use the instance default"; the concrete scopes override it. */
type ScopeChoice = NotificationScope | 'default';

/**
 * The signed-in user's own settings — reachable from the sidebar name. The
 * account (name, email, password) is theirs to edit; role stays admin-managed.
 * Appearance is per-browser; an unset inbox scope inherits the instance default.
 */
export function ProfilePage(): JSX.Element {
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [error, setError] = useState<string | null>(null);

  return (
    <Page>
      <PageHeader title="Your profile" subtitle="Your account, appearance, and notification preferences" />
      {error ? <div className="error-bar">{error}</div> : null}

      <AccountSection onError={setError} />

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

      <NotificationSection onError={setError} />
    </Page>
  );
}

/** Editable account details plus a separate password change. */
function AccountSection({ onError }: { onError: (e: string | null) => void }): JSX.Element {
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
    api
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
      const { account: updated } = await api.updateAccount({
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
      await api.updateAccount({ currentPassword, newPassword });
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
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Display name</span>
            <input
              className="input"
              maxLength={60}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={account === null}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Email</span>
            <input
              className="input"
              type="email"
              maxLength={200}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={account === null}
            />
          </label>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
          <div className="flex gap-2">
            <dt className="dim">Username</dt>
            <dd>
              <code>{account?.username ?? '…'}</code>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="dim">Role</dt>
            <dd className="capitalize">{account?.role ?? '…'}</dd>
          </div>
        </dl>
        <div className="flex items-center gap-2">
          <button className="btn" type="submit" disabled={!dirty || savingProfile}>
            {savingProfile ? 'Saving…' : 'Save changes'}
          </button>
          {saved && !dirty ? <span className="dim text-[13px]">Saved.</span> : null}
        </div>
      </form>

      <form className="card mt-3 flex flex-col gap-4" onSubmit={(e) => void changePassword(e)}>
        <div className="text-[13px] font-medium">Change password</div>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Current password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">New password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Confirm new password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>
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
    </Section>
  );
}

/** Inbox scope preference (per-user override of the instance default). */
function NotificationSection({ onError }: { onError: (e: string | null) => void }): JSX.Element {
  const [choice, setChoice] = useState<ScopeChoice | null>(null);
  const [defaultScope, setDefaultScope] = useState<NotificationScope>('workspace');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
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
      await api.updateProfile({ notificationScope: next === 'default' ? null : next });
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
      <div className="card flex flex-wrap items-center gap-3">
        <span className="text-[13px] font-medium">Inbox scope</span>
        {choice === null ? (
          <span className="dim text-[13px]">Loading…</span>
        ) : (
          <>
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
            <span className="dim text-[13px]">
              {saving
                ? 'Saving…'
                : choice === 'global'
                  ? 'You see notifications from every workspace you can access.'
                  : choice === 'workspace'
                    ? 'You only see the workspace you have open (plus instance-wide events).'
                    : 'Follows whatever the administrator sets for the instance.'}
            </span>
          </>
        )}
      </div>
    </Section>
  );
}

import { useEffect, useState } from 'react';
import { Spinner } from '@companion/ui';
import { authApi } from '../api.js';
import { useAuth } from '../lib/auth.js';

/** First-boot onboarding: a clean install creates its admin account here. */
export function SetupPage(): JSX.Element {
  const { branding } = useAuth();
  const brandName = branding.name?.trim() || 'Companion';

  useEffect(() => {
    document.title = `Welcome · ${brandName}`;
  }, [brandName]);
  const [username, setUsername] = useState('admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = username.trim().length >= 2 && email.includes('@') && password.length >= 8 && password === confirm;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.setup(username.trim(), email.trim(), password);
      // AuthProvider picks the session up via onAuthChanged.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="anim-in w-full max-w-md">
        <div className="mb-6 text-center">
          {branding.logo ? (
            <img src={branding.logo} alt="" className="mx-auto mb-3 size-11 rounded-xl object-cover" />
          ) : (
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-accent-600 text-lg font-bold text-white dark:bg-accent-500 dark:text-zinc-950">
              {brandName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <h1 className="text-xl font-semibold">Welcome to {brandName}</h1>
          <p className="dim mt-1">First boot — create the administrator account for this install.</p>
        </div>

        <form className="card flex flex-col gap-3 bg-white dark:bg-zinc-900" onSubmit={(e) => void submit(e)} aria-label="Create admin account">
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Admin username</span>
            <input
              className="input"
              required
              minLength={2}
              maxLength={40}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Email</span>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Password (min 8 characters)</span>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Confirm password</span>
            <input
              className="input"
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              aria-invalid={mismatch}
            />
            {mismatch ? <span className="text-xs text-red-500">Passwords do not match.</span> : null}
          </label>
          {error ? (
            <div className="error-bar" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn mt-1 justify-center" type="submit" disabled={!ready || busy}>
            {busy ? (
              <>
                <Spinner /> Creating…
              </>
            ) : (
              'Create admin & enter'
            )}
          </button>
        </form>

        <p className="dim mt-4 text-center text-xs">
          You can add maintainer and business accounts later under <strong>Users</strong>.
        </p>
      </div>
    </main>
  );
}

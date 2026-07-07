import { useState } from 'react';
import { useAuth } from '../lib/auth.js';

export function LoginPage(): JSX.Element {
  const { login, branding } = useAuth();
  const brandName = branding.name?.trim() || 'Companion';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {branding.logo ? (
            <img src={branding.logo} alt="" className="mx-auto mb-3 size-11 rounded-xl object-cover" />
          ) : (
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-accent-600 text-lg font-bold text-white dark:bg-accent-500 dark:text-zinc-950">
              {brandName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <h1 className="text-xl font-semibold">{brandName}</h1>
          <p className="dim mt-1">Sign in to your workspace</p>
        </div>

        <form
          className="card flex flex-col gap-3 bg-white dark:bg-zinc-900"
          onSubmit={(e) => void submit(e)}
          aria-label="Sign in"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Username</span>
            <input
              className="input"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error ? (
            <div className="error-bar" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn mt-1 justify-center" type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="dim mt-4 text-center text-xs">
          Accounts are configured in the daemon&apos;s <code>.env</code> file.
        </p>
      </div>
    </main>
  );
}

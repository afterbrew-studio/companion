import { useEffect, useState } from 'react';
import { ErrorBar, Field, Spinner } from '@companion/ui';
import { AuthLayout } from '../components/AuthLayout.js';
import { useAuth } from '../lib/auth.js';

export function LoginPage(): JSX.Element {
  const { login, branding } = useAuth();
  const brandName = branding.name?.trim() || 'Companion';

  useEffect(() => {
    document.title = `Sign in · ${brandName}`;
  }, [brandName]);
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
    <AuthLayout
      title={brandName}
      subtitle="Sign in to your workspace"
      footer={
        <>
          Accounts are configured in the daemon&apos;s <code>.env</code> file.
        </>
      }
    >
      <form
        className="card flex flex-col gap-3 bg-white dark:bg-zinc-900"
        onSubmit={(e) => void submit(e)}
        aria-label="Sign in"
      >
        <Field label="Username">
          <input
            className="input"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBar error={error} />
        <button className="btn mt-1 justify-center" type="submit" disabled={busy || !username || !password}>
          {busy ? (
            <>
              <Spinner /> Signing in…
            </>
          ) : (
            'Sign in'
          )}
        </button>
      </form>
    </AuthLayout>
  );
}

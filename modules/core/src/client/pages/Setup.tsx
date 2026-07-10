import { useEffect, useState } from 'react';
import { ErrorBar, Field, Spinner } from '@companion/ui';
import { authApi } from '../api.js';
import { AuthLayout } from '../components/AuthLayout.js';
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
    <AuthLayout
      title={`Welcome to ${brandName}`}
      subtitle="First boot — create the administrator account for this install."
      className="anim-in max-w-md"
      footer={
        <>
          You can add maintainer and business accounts later under <strong>Users</strong>.
        </>
      }
    >
      <form className="card flex flex-col gap-3 bg-white dark:bg-zinc-900" onSubmit={(e) => void submit(e)} aria-label="Create admin account">
        <Field label="Admin username">
          <input
            className="input"
            required
            minLength={2}
            maxLength={40}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </Field>
        <Field label="Email">
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password (min 8 characters)">
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm password">
          <input
            className="input"
            type="password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={mismatch}
          />
        </Field>
        <ErrorBar error={mismatch ? 'Passwords do not match.' : null} />
        <ErrorBar error={error} />
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
    </AuthLayout>
  );
}

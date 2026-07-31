import { useEffect, useState } from 'react';
import { ErrorBar, Field, Spinner } from '@moxxy/companion-ui';
import { AuthLayout } from '../components/AuthLayout.js';
import { useAuth } from '../lib/auth.js';

export function LoginPage(): JSX.Element {
  const { login, branding, providers, localCredentials } = useAuth();
  const brandName = branding.name?.trim() || 'Companion';

  useEffect(() => {
    document.title = `Sign in · ${brandName}`;
  }, [brandName]);
  // Prefilled from the seed when there is one: the box exists so nobody types
  // a credential this machine generated for itself.
  const [username, setUsername] = useState(localCredentials?.username ?? '');
  const [password, setPassword] = useState(localCredentials?.password ?? '');
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
      footer={localCredentials ? <>Anyone who can reach this machine can sign in.</> : undefined}
    >
      {localCredentials ? (
        <div className="card mb-3 border-amber-500/40 bg-amber-500/10">
          <div className="text-sm font-medium">Local instance, no account needed</div>
          <p className="dim mt-1 text-xs">
            This daemon only listens on your own machine, so it created an admin for you and filled the form
            in. Change the password in Settings, and this box disappears.
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
            <dt className="dim">user</dt>
            <dd>{localCredentials.username}</dd>
            <dt className="dim">password</dt>
            <dd>{localCredentials.password}</dd>
          </dl>
        </div>
      ) : null}
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
        {providers.length > 0 ? (
          <>
            <div className="dim my-1 flex items-center gap-3 text-xs">
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              or
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>
            {/* A plain link, not a fetch: the handshake is a browser redirect the
                identity module owns end to end. */}
            {providers.map((p) => (
              <a key={p.id} className="btn justify-center" href={p.startUrl}>
                {p.label}
              </a>
            ))}
          </>
        ) : null}
      </form>
    </AuthLayout>
  );
}

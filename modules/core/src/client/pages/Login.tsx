import { useEffect, useState } from 'react';
import { ErrorBar, Field, Spinner } from '@moxxy/companion-ui';
import type { MfaChallenge } from '../../contract/index.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { useAuth } from '../lib/auth.js';

export function LoginPage(): React.JSX.Element {
  const { login, completeMfa, authMode, branding, providers } = useAuth();
  const brandName = branding.name?.trim() || 'Companion';
  const ssoOnly = authMode === 'sso';

  useEffect(() => {
    document.title = `Sign in · ${brandName}`;
  }, [brandName]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const mfa = await login(username.trim(), password);
      if (mfa) {
        setChallenge(mfa);
        setBusy(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !challenge) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(challenge.mfaToken, code.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (challenge) {
    return (
      <AuthLayout title={brandName} subtitle="Verify it's you">
        <form
          className="card flex flex-col gap-3 bg-white dark:bg-zinc-900"
          onSubmit={(e) => void submitCode(e)}
          aria-label="Two-factor verification"
        >
          <Field label={useRecovery ? 'Recovery code' : 'Authenticator code'}>
            <input
              className="input"
              autoComplete="one-time-code"
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoFocus
              required
              placeholder={useRecovery ? 'xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx' : '123456'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <ErrorBar error={error} />
          <button className="btn mt-1 justify-center" type="submit" disabled={busy || !code.trim()}>
            {busy ? (
              <>
                <Spinner /> Verifying…
              </>
            ) : (
              'Verify'
            )}
          </button>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setUseRecovery((v) => !v);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
            </button>
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setPassword('');
                setError(null);
              }}
            >
              Back to sign in
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={brandName}
      subtitle="Sign in to your workspace"
    >
      {ssoOnly ? (
        <div className="card flex flex-col gap-3 bg-white dark:bg-zinc-900" aria-label="Sign in">
          {providers.length > 0 ? (
            <>
              <p className="dim text-[13px]">This instance uses single sign-on.</p>
              {providers.map((p) => (
                <a key={p.id} className="btn justify-center" href={p.startUrl}>
                  {p.label}
                </a>
              ))}
            </>
          ) : (
            <p className="dim text-[13px]">
              This instance requires single sign-on, but no identity provider is enabled yet. An
              administrator must enable one before anyone can sign in here.
            </p>
          )}
        </div>
      ) : (
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
      )}
    </AuthLayout>
  );
}

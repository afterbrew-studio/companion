import { useEffect, useState } from 'react';
import type { MoxxyStatus, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

export function ReposPage(): JSX.Element {
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [{ repos }, status] = await Promise.all([api.listRepos(), api.status()]);
      setRepos(repos);
      setStatus(status);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'repos.changed' || msg.t === 'issues.changed') void refresh();
    });
  }, []);

  const addRepo = async (): Promise<void> => {
    const fullName = input.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      setError('use the owner/name form, e.g. facebook/react');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addRepo(fullName);
      setInput('');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Repositories</h1>
      </header>

      {status && !status.githubConfigured ? (
        <div className="banner-warn">
          GitHub is not connected yet — add a fine-grained PAT in{' '}
          <a className="linkish" href="#/settings">
            Settings
          </a>
          .
        </div>
      ) : null}

      <div className="my-4 flex items-center gap-2.5">
        <input
          className="input w-72"
          value={input}
          placeholder="owner/name"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addRepo()}
        />
        <button className="btn" disabled={busy || !status?.githubConfigured} onClick={() => void addRepo()}>
          {busy ? 'Connecting…' : 'Connect repo'}
        </button>
      </div>
      {error ? <div className="error-bar">{error}</div> : null}

      <ul className="flex flex-col gap-2.5">
        {repos.map((repo) => (
          <li key={repo.fullName} className="card flex items-center gap-3">
            <div className="flex flex-1 flex-col gap-0.5">
              <a className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400" href={`#/repos/${repo.fullName}`}>
                {repo.fullName}
              </a>
              <span className="dim">
                {repo.private ? 'private' : 'public'} · base {repo.defaultBranch} ·{' '}
                {repo.cloneReady ? 'clone ready' : 'cloning…'} ·{' '}
                {repo.lastSyncAt ? `synced ${new Date(repo.lastSyncAt).toLocaleTimeString()}` : 'never synced'}
              </span>
            </div>
            <span className="badge">{repo.openIssues} open</span>
            <button
              className="btn-ghost"
              onClick={() =>
                void api
                  .syncRepo(repo.fullName)
                  .then(refresh)
                  .catch((e) => setError(String(e)))
              }
            >
              Sync
            </button>
          </li>
        ))}
        {repos.length === 0 ? <li className="dim py-5">No repositories connected.</li> : null}
      </ul>
    </div>
  );
}

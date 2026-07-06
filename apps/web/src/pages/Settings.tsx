import { useEffect, useState } from 'react';
import type { MoxxyStatus, SkillFile } from '@companion/contract';
import { api } from '../lib/api.js';

export function SettingsPage(): JSX.Element {
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await api.status());
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const saveToken = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { login } = await api.setGithubToken(pat.trim());
      setMessage(`Connected as ${login}`);
      setPat('');
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}
      {message ? <div className="banner-info">{message}</div> : null}

      <h2 className="mt-6 mb-2.5 text-[15px] font-semibold">moxxy runtime</h2>
      <div className="card flex flex-col gap-2 text-sm">
        {status ? (
          <>
            <div>
              CLI:{' '}
              {status.cliPath ? (
                <code className="text-[13px]">
                  {status.cliPath} (v{status.cliVersion}, {status.compatible ? 'supported' : 'too old'})
                </code>
              ) : (
                <span className="error-bar">
                  not found — <code>npm i -g @moxxy/cli</code>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2.5">
              Home: <code className="text-[13px]">{status.homeDir}</code> · providers{' '}
              {status.providersImported ? 'imported ✓' : 'not imported'}
              {!status.providersImported ? (
                <button className="btn-ghost" onClick={() => void api.importProviders().then(refresh)}>
                  Import from ~/.moxxy
                </button>
              ) : null}
            </div>
          </>
        ) : (
          'Loading…'
        )}
      </div>

      <h2 className="mt-6 mb-2.5 text-[15px] font-semibold">GitHub</h2>
      <div className="card flex flex-col gap-2.5 text-sm">
        <div>
          {status?.githubConfigured ? (
            <span>Connected{status.githubUser ? ` as ${status.githubUser}` : ''} ✓ — paste a new token to replace it.</span>
          ) : (
            <span>
              Not connected. Create a fine-grained PAT with Contents R/W, Issues R/W, Pull requests R/W, Metadata R.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <input
            className="input w-96"
            type="password"
            placeholder="github_pat_… or ghp_…"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
          />
          <button className="btn" disabled={busy || pat.trim().length < 10} onClick={() => void saveToken()}>
            {busy ? 'Validating…' : 'Save token'}
          </button>
        </div>
      </div>

      <h2 className="mt-6 mb-2.5 text-[15px] font-semibold">Skills</h2>
      <SkillsEditor />
    </div>
  );
}

function SkillsEditor(): JSX.Element {
  const [skills, setSkills] = useState<SkillFile[]>([]);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const { skills } = await api.listSkills();
      setSkills(skills);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.saveSkill(name.trim(), content);
      setEditing(null);
      setName('');
      setContent('');
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="card flex flex-col gap-2.5">
      <p className="dim">
        Markdown skills every Companion agent run can use (moxxy user-scope discovery). Frontmatter is added
        automatically if you omit it.
      </p>
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {skills.map((s) => (
          <li key={s.name} className="flex items-center py-2">
            <button
              className="linkish text-sm"
              onClick={() => {
                setEditing(s.name);
                setName(s.name);
                setContent(s.content);
              }}
            >
              {s.name}
            </button>
            <span className="flex-1" />
            <button
              className="btn-danger"
              onClick={() => void api.deleteSkill(s.name).then(refresh).catch((e) => setError(String(e)))}
            >
              Delete
            </button>
          </li>
        ))}
        {skills.length === 0 ? <li className="dim py-3">No skills yet.</li> : null}
      </ul>
      <div className="flex flex-col gap-2.5">
        <input
          className="input"
          placeholder="skill-name (lowercase-kebab)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={editing !== null}
        />
        <textarea
          className="input resize-y font-mono text-xs"
          rows={8}
          placeholder={'---\nname: my-skill\ndescription: when to use it\n---\n\nInstructions for the agent…'}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="btn" disabled={!name.trim() || !content.trim()} onClick={() => void save()}>
            {editing ? `Save ${editing}` : 'Create skill'}
          </button>
          {editing ? (
            <button
              className="btn-ghost"
              onClick={() => {
                setEditing(null);
                setName('');
                setContent('');
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="error-bar">{error}</div> : null}
    </div>
  );
}

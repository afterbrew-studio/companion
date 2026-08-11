import { useEffect, useState } from 'react';
import type { GitHubAccountRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * "Act as" GitHub account select for posting actions. Renders nothing unless
 * several accounts are connected — with one account there is nothing to pick.
 * Empty value = automatic resolution (repo pin → purpose bindings).
 */
export function AccountPicker({
  value,
  onChange,
  className = '',
}: {
  value: string;
  onChange: (id: string) => void;
  className?: string;
}): React.JSX.Element | null {
  const [accounts, setAccounts] = useState<GitHubAccountRecord[]>([]);
  useEffect(() => {
    api
      .listGithubAccounts()
      .then(({ accounts }) => setAccounts(accounts))
      .catch(() => setAccounts([]));
  }, []);
  if (accounts.length < 2) return null;
  return (
    <select
      className={`input ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="GitHub account to act as"
      title="Which connected GitHub account posts this action"
    >
      <option value="">act as: auto</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          act as: {a.login}
        </option>
      ))}
    </select>
  );
}

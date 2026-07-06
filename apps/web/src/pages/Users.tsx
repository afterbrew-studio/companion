import { useCallback, useState } from 'react';
import type { Role, UserRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { ListFooter, PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { Page, EmptyState, Modal, PageHeader, timeAgo, useConfirm } from '../components/ui.js';

const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything, including settings, workspaces, and users',
  maintainer: 'Issues, PRs, proposals, pipelines, runs, automations',
  business: 'Proposals only',
};

/** User management (admin): accounts, roles/scopes, resets, disable/delete. */
export function UsersPage(): JSX.Element {
  const { user: me } = useAuth();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'all' | Role>('all');
  const { confirmDanger, confirmElement } = useConfirm();

  const q = useDebounced(search.trim());
  const fetchPage = useCallback(
    async (offset: number) => {
      const { users, total } = await api.listUsers({
        q: q || undefined,
        role: role === 'all' ? undefined : role,
        limit: PAGE_SIZE,
        offset,
      });
      return { items: users, total };
    },
    [q, role],
  );
  const { items: users, total, loading, hasMore, loadMore, reload, error: listError } = useInfiniteList(fetchPage);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const filtered = q !== '' || role !== 'all';

  return (
    <Page>
      <PageHeader
        title="Users"
        subtitle="Accounts and role scopes for this install"
        actions={
          <>
            <input
              className="input w-56"
              type="search"
              placeholder="Search users…"
              aria-label="Search users by name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="input"
              aria-label="Filter by role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'all' | Role)}
            >
              <option value="all">All roles</option>
              <option value="admin">admin</option>
              <option value="maintainer">maintainer</option>
              <option value="business">business</option>
            </select>
            <button className="btn" onClick={() => setAdding(true)}>
              Add user
            </button>
          </>
        }
      />
      {(error ?? listError) ? <div className="error-bar">{error ?? listError}</div> : null}

      {users.length === 0 && !loading ? (
        <EmptyState title={filtered ? 'No users match the filters' : 'No users'} />
      ) : (
        <div className="card divide-y divide-zinc-200 p-0 dark:divide-zinc-800">
          {users.map((u) => (
            <div key={u.username} className="flex flex-wrap items-center gap-2.5 px-4 py-2.5 text-sm">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-[11px] font-semibold uppercase dark:bg-zinc-800">
                {u.username.slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {u.username}
                  {me?.username === u.username ? <span className="dim ml-1.5 text-xs">(you)</span> : null}
                  {u.disabled ? <span className="badge-danger ml-1.5">disabled</span> : null}
                </div>
                <div className="dim truncate text-xs">
                  {u.email || 'no email'} · joined {timeAgo(u.createdAt)}
                </div>
              </div>
              <label className="dim flex items-center gap-1.5 text-xs">
                role
                <select
                  className="input py-1.5"
                  value={u.role}
                  disabled={me?.username === u.username}
                  aria-label={`Role for ${u.username}`}
                  title={me?.username === u.username ? 'You cannot change your own role' : ROLE_HELP[u.role]}
                  onChange={(e) => void act(() => api.updateUser(u.username, { role: e.target.value as Role }))}
                >
                  <option value="admin">admin</option>
                  <option value="maintainer">maintainer</option>
                  <option value="business">business</option>
                </select>
              </label>
              <button className="btn-ghost" onClick={() => setResetting(u)}>
                Reset password
              </button>
              <button
                className="btn-ghost"
                onClick={() => void act(() => api.updateUser(u.username, { disabled: !u.disabled }))}
              >
                {u.disabled ? 'Enable' : 'Disable'}
              </button>
              <button
                className="btn-danger"
                disabled={me?.username === u.username}
                title={me?.username === u.username ? 'You cannot delete your own account' : undefined}
                onClick={() =>
                  void (async () => {
                    const ok = await confirmDanger({
                      title: `Delete user ${u.username}`,
                      message: `"${u.username}" loses access immediately and their sessions end. Past runs and actions are kept.`,
                    });
                    if (ok) await act(() => api.deleteUser(u.username));
                  })()
                }
              >
                Delete
              </button>
            </div>
          ))}
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={users.length}
            total={total}
            noun="users"
            onVisible={loadMore}
          />
        </div>
      )}

      <p className="dim mt-3 text-xs">
        Role scopes — admin: {ROLE_HELP.admin.toLowerCase()}. Maintainer: {ROLE_HELP.maintainer.toLowerCase()}.
        Business: {ROLE_HELP.business.toLowerCase()}.
      </p>

      {adding ? (
        <AddUserModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            reload();
          }}
        />
      ) : null}
      {resetting ? (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            reload();
          }}
        />
      ) : null}
      {confirmElement}
    </Page>
  );
}

function AddUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('maintainer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser({ username: username.trim(), email: email.trim() || undefined, password, role });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Username</span>
          <input
            className="input"
            required
            minLength={2}
            maxLength={40}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Email (optional — can also be used to sign in)</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">admin — {ROLE_HELP.admin}</option>
            <option value="maintainer">maintainer — {ROLE_HELP.maintainer}</option>
            <option value="business">business — {ROLE_HELP.business}</option>
          </select>
        </label>
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !username.trim() || password.length < 8}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: UserRecord;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(user.username, { password });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Reset password — ${user.username}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">New password (min 8 characters; their sessions end)</span>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || password.length < 8}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { Role, UserRecord } from '@companion/contract';
import { api, refreshAuth } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { ListFooter, PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { Page, Dropdown, EmptyState, FilterField, FiltersPopover, Modal, PageHeader, timeAgo, useConfirm } from '../components/ui.js';

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
  const [viewing, setViewing] = useState<UserRecord | null>(null);
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

  // Keep the open modal on the fresh record after an action reloads the list.
  useEffect(() => {
    setViewing((v) => (v ? (users.find((u) => u.username === v.username) ?? v) : v));
  }, [users]);

  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
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
              placeholder="Search users…  ( / )"
              data-shortcut="search"
              aria-label="Search users by name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <FiltersPopover active={role === 'all' ? 0 : 1} onClear={() => setRole('all')}>
              <FilterField label="Role">
                <Dropdown
                  ariaLabel="Filter by role"
                  value={role}
                  onChange={(v) => setRole(v as 'all' | Role)}
                  options={[
                    { value: 'all', label: 'All roles' },
                    { value: 'admin', label: 'admin' },
                    { value: 'maintainer', label: 'maintainer' },
                    { value: 'business', label: 'business' },
                  ]}
                />
              </FilterField>
            </FiltersPopover>
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
            <button
              key={u.username}
              className="row-link w-full cursor-pointer text-left"
              onClick={() => setViewing(u)}
              aria-label={`Open ${u.username}`}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-[11px] font-semibold uppercase dark:bg-zinc-800">
                {u.displayName.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate font-medium">{u.displayName}</span>
                  {me?.username === u.username ? <span className="dim text-xs">(you)</span> : null}
                  {u.disabled ? <span className="badge-danger shrink-0">disabled</span> : null}
                </span>
                <span className="dim mt-0.5 block truncate text-xs">
                  @{u.username} · {u.email || 'no email'} · joined {timeAgo(u.createdAt)}
                </span>
              </span>
              <svg viewBox="0 0 16 16" fill="none" className="dim size-4 shrink-0" aria-hidden>
                <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
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

      {viewing ? (
        <UserModal
          user={viewing}
          isSelf={me?.username === viewing.username}
          error={error}
          onClose={() => setViewing(null)}
          onRename={(displayName) =>
            void act(() => api.updateUser(viewing.username, { displayName })).then((ok) => {
              // Your own rename shows up in the sidebar immediately.
              if (ok && me?.username === viewing.username) refreshAuth();
            })
          }
          onChangeRole={(r) => void act(() => api.updateUser(viewing.username, { role: r }))}
          onToggleDisabled={() => void act(() => api.updateUser(viewing.username, { disabled: !viewing.disabled }))}
          onResetPassword={() => setResetting(viewing)}
          onDelete={() =>
            void (async () => {
              const ok = await confirmDanger({
                title: `Delete user ${viewing.username}`,
                message: `"${viewing.username}" loses access immediately and their sessions end. Past runs and actions are kept.`,
              });
              if (ok && (await act(() => api.deleteUser(viewing.username)))) setViewing(null);
            })()
          }
        />
      ) : null}
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

/** A user's data plus every account action — the row itself stays clean. */
function UserModal({
  user,
  isSelf,
  error,
  onClose,
  onRename,
  onChangeRole,
  onToggleDisabled,
  onResetPassword,
  onDelete,
}: {
  user: UserRecord;
  isSelf: boolean;
  error: string | null;
  onClose: () => void;
  onRename: (displayName: string) => void;
  onChangeRole: (role: Role) => void;
  onToggleDisabled: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
}): JSX.Element {
  // Display name edits commit on blur/Enter; escape-hatch back to the stored
  // value when left empty.
  const [name, setName] = useState(user.displayName);
  useEffect(() => {
    setName(user.displayName);
  }, [user.displayName]);
  const commitName = (): void => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== user.displayName) onRename(trimmed);
    else setName(user.displayName);
  };

  return (
    <Modal title={user.displayName} onClose={onClose}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-[13px] font-semibold uppercase dark:bg-zinc-800">
          {user.displayName.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {user.displayName}
            {isSelf ? <span className="dim ml-1.5 text-xs">(you)</span> : null}
          </div>
          <div className="dim truncate text-xs">
            @{user.username} · {user.email || 'no email'}
          </div>
        </div>
        {user.disabled ? (
          <span className="badge-danger shrink-0">disabled</span>
        ) : (
          <span className="badge-ok shrink-0">active</span>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[13px]">
        <dt className="dim">Display name</dt>
        <dd>
          <input
            className="input py-1.5"
            maxLength={60}
            value={name}
            aria-label={`Display name for ${user.username}`}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </dd>
        <dt className="dim">Joined</dt>
        <dd>
          {new Date(user.createdAt).toLocaleDateString()} · {timeAgo(user.createdAt)}
        </dd>
        <dt className="dim">Role</dt>
        <dd>
          <select
            className="input py-1.5"
            value={user.role}
            disabled={isSelf}
            aria-label={`Role for ${user.username}`}
            onChange={(e) => onChangeRole(e.target.value as Role)}
          >
            <option value="admin">admin</option>
            <option value="maintainer">maintainer</option>
            <option value="business">business</option>
          </select>
          <p className="dim mt-1">{isSelf ? 'You cannot change your own role.' : ROLE_HELP[user.role]}</p>
        </dd>
      </dl>

      {error ? <div className="error-bar mt-2">{error}</div> : null}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button className="btn-ghost" onClick={onResetPassword}>
          Reset password
        </button>
        <button className="btn-ghost" onClick={onToggleDisabled}>
          {user.disabled ? 'Enable' : 'Disable'}
        </button>
        <span className="action-sep" aria-hidden />
        <button
          className="btn-danger-ghost"
          disabled={isSelf}
          title={isSelf ? 'You cannot delete your own account' : undefined}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}

function AddUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
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
      await api.createUser({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        password,
        role,
      });
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
          <span className="dim">Display name</span>
          <input
            className="input"
            maxLength={60}
            placeholder="Shown across the UI; defaults to the username"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Username (sign-in, cannot change later)</span>
          <input
            className="input"
            required
            minLength={2}
            maxLength={40}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
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

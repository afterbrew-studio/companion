import { useEffect, useState } from 'react';
import type { Role } from '@companion/types';
import { refreshAuth } from '@companion/core/client';
import {
  Avatar,
  DetailGrid,
  DetailRow,
  Dropdown,
  EmptyState,
  ErrorBar,
  Field,
  FilterField,
  FiltersPopover,
  FormActions,
  ListCard,
  ListFooter,
  Modal,
  Page,
  PageHeader,
  SearchInput,
  Spinner,
  timeAgo,
  useConfirm,
} from '@companion/ui';
import type { UserRecord } from '../../contract/index.js';
import { coreApi } from '../api.js';
import { useAuth } from '../lib/auth.js';
import { useUsers } from '../hooks/useUsers.js';

const ROLE_HELP: Record<Role, string> = {
  admin: 'Platform settings and users, plus full capabilities in accessible workspaces',
  maintainer: 'Ideas, issues, PRs, planning, pipelines, runs, automations',
  business: 'Guided Ideas workflow and workspace visibility',
};

/** User management (admin): accounts, roles/scopes, resets, disable/delete. */
export function UsersPage(): JSX.Element {
  const { user: me } = useAuth();
  const { search, setSearch, role, setRole, users, total, loading, hasMore, loadMore, reload, error, listError, act } = useUsers();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserRecord | null>(null);
  const [viewing, setViewing] = useState<UserRecord | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();

  // Keep the open modal on the fresh record after an action reloads the list.
  useEffect(() => {
    setViewing((v) => (v ? (users.find((u) => u.username === v.username) ?? v) : v));
  }, [users]);

  const filtered = search.trim() !== '' || role !== 'all';

  return (
    <Page>
      <PageHeader
        title="Users"
        subtitle="Accounts and role scopes for this install"
        actions={
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search users…  ( / )"
              ariaLabel="Search users by name or email"
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
      <ErrorBar error={error ?? listError} />

      {users.length === 0 && !loading ? (
        <EmptyState title={filtered ? 'No users match the filters' : 'No users'} />
      ) : (
        <ListCard>
          {users.map((u) => (
            <button
              key={u.username}
              className="row-link w-full cursor-pointer text-left"
              onClick={() => setViewing(u)}
              aria-label={`Open ${u.username}`}
            >
              <Avatar name={u.displayName} size="md" />
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
        </ListCard>
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
            void act(() => coreApi.updateUser(viewing.username, { displayName })).then((ok) => {
              // Your own rename shows up in the sidebar immediately.
              if (ok && me?.username === viewing.username) refreshAuth();
            })
          }
          onChangeRole={(r) => void act(() => coreApi.updateUser(viewing.username, { role: r }))}
          onToggleDisabled={() => void act(() => coreApi.updateUser(viewing.username, { disabled: !viewing.disabled }))}
          onResetPassword={() => setResetting(viewing)}
          onDelete={() =>
            void (async () => {
              const ok = await confirmDanger({
                title: `Delete user ${viewing.username}`,
                message: `"${viewing.username}" loses access immediately and their sessions end. Past runs and actions are kept.`,
              });
              if (ok && (await act(() => coreApi.deleteUser(viewing.username)))) setViewing(null);
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
        <Avatar name={user.displayName} size="lg" />
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

      <DetailGrid className="mt-4">
        <DetailRow label="Display name">
          <input
            className="input input-sm"
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
        </DetailRow>
        <DetailRow label="Joined">
          {new Date(user.createdAt).toLocaleDateString()} · {timeAgo(user.createdAt)}
        </DetailRow>
        <DetailRow label="Role">
          <select
            className="input input-sm"
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
        </DetailRow>
      </DetailGrid>

      <ErrorBar error={error} className="mt-2" />

      <FormActions divider>
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
      </FormActions>
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
      await coreApi.createUser({
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
        <Field label="Display name">
          <input
            className="input"
            maxLength={60}
            placeholder="Shown across the UI; defaults to the username"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Username (sign-in, cannot change later)">
          <input
            className="input"
            required
            minLength={2}
            maxLength={40}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Email (optional — can also be used to sign in)">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password (min 8 characters)">
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Role">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">admin — {ROLE_HELP.admin}</option>
            <option value="maintainer">maintainer — {ROLE_HELP.maintainer}</option>
            <option value="business">business — {ROLE_HELP.business}</option>
          </select>
        </Field>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !username.trim() || password.length < 8}>
            {busy ? (
              <>
                <Spinner /> Creating…
              </>
            ) : (
              'Create user'
            )}
          </button>
        </FormActions>
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
      await coreApi.updateUser(user.username, { password });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Reset password — ${user.username}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="New password (min 8 characters; their sessions end)">
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || password.length < 8}>
            {busy ? (
              <>
                <Spinner /> Saving…
              </>
            ) : (
              'Set password'
            )}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'react';
import {
  ErrorBar,
  IconButton,
  ListCard,
  Modal,
  Page,
  PageHeader,
  Section,
  Switch,
  useConfirm,
} from '@companion/ui';
import type { Permission } from '@moxxy/companion-contracts';
import type { AclMap, RoleDetail, RoleRecord } from '../../contract/index.js';
import { coreApi } from '../api.js';
import { useRoles } from '../hooks/useRoles.js';

/**
 * Role administration. Modules grant capabilities to the three built-in roles;
 * this page is where an instance adds roles of its own and adjusts what any role
 * holds. Edits take effect on the live grid immediately, including for sessions
 * already open.
 *
 * The three-way state per permission is the whole design: a role either follows
 * what the modules grant (the default), or carries an explicit grant/revoke that
 * beats it. Toggling therefore has to know the default, or turning a permission
 * off would write a `revoke` row for a custom role that never had it.
 */
export function RolesPage(): JSX.Element {
  const { roles, reload } = useRoles();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoleDetail | null>(null);
  const [catalog, setCatalog] = useState<AclMap | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();

  useEffect(() => {
    void coreApi
      .acl()
      .then(setCatalog)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const openRole = useCallback(async (id: string): Promise<void> => {
    setSelected(id);
    setDetail(null);
    setError(null);
    try {
      setDetail((await coreApi.getRole(id)).role);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const run = async (key: string, op: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      await op();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /**
   * ON: a default permission just needs its override cleared; anything else
   * needs an explicit grant. OFF: mirror image. This is what keeps the override
   * table free of rows that say the same thing as the default.
   */
  const toggle = async (permission: Permission, want: boolean): Promise<void> => {
    if (!detail) return;
    const isDefault = detail.defaults.includes(permission);
    const mode = want ? (isDefault ? 'reset' : 'grant') : isDefault ? 'revoke' : 'reset';
    const ok = await run(permission, async () => {
      setDetail((await coreApi.adjustRole(detail.id, mode, [permission])).role);
    });
    // The keystone guard can refuse; re-read so the switch matches the server.
    if (!ok) void openRole(detail.id);
  };

  const remove = async (role: RoleRecord): Promise<void> => {
    const ok = await confirmDanger({
      title: `Delete role ${role.title}`,
      message: `Its grant overrides are deleted with it. Users holding it must be reassigned first.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    if (await run(role.id, () => coreApi.deleteRole(role.id))) {
      if (selected === role.id) setSelected(null);
      reload();
    }
  };

  return (
    <Page>
      <PageHeader
        title="Roles"
        subtitle="Who can do what on this instance"
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            New role
          </button>
        }
      />
      <ErrorBar error={error} />

      <Section
        title="Roles"
        description="Built-in roles come with every install and cannot be deleted, but what they hold is yours to tune. A custom role starts empty unless you clone one."
      >
        <ListCard>
          {roles.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-3">
              <button className="min-w-0 flex-1 text-left" onClick={() => void openRole(r.id)}>
                <span className="block truncate text-[13px] font-medium">{r.title}</span>
                <span className="dim block truncate text-xs">
                  {r.id}
                  {r.builtin ? ' · built-in' : ''}
                  {r.description ? ` · ${r.description}` : ''}
                </span>
              </button>
              {!r.builtin ? (
                <IconButton label={`Delete ${r.title}`} danger disabled={busy === r.id} onClick={() => void remove(r)}>
                  <TrashIcon />
                </IconButton>
              ) : null}
            </div>
          ))}
        </ListCard>
      </Section>

      {selected && catalog ? (
        <Modal title={detail ? detail.title : selected} onClose={() => setSelected(null)}>
          {!detail ? (
            <p className="dim">Loading…</p>
          ) : (
            <PermissionEditor detail={detail} catalog={catalog} busy={busy} onToggle={toggle} />
          )}
        </Modal>
      ) : null}

      {creating ? (
        <CreateRoleModal
          roles={roles}
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            reload();
            void openRole(id);
          }}
        />
      ) : null}
      {confirmElement}
    </Page>
  );
}

function PermissionEditor({
  detail,
  catalog,
  busy,
  onToggle,
}: {
  detail: RoleDetail;
  catalog: AclMap;
  busy: string | null;
  onToggle: (permission: Permission, want: boolean) => Promise<void>;
}): JSX.Element {
  const held = new Set<string>(detail.permissions);
  const defaults = new Set<string>(detail.defaults);
  const owners = [...new Set(catalog.permissions.map((p) => p.owner))].sort();

  return (
    <div className="flex flex-col gap-4">
      <p className="dim text-xs">
        {detail.permissions.length} of {catalog.permissions.length} permissions · {detail.userCount} user
        {detail.userCount === 1 ? '' : 's'}
        {detail.builtin ? ' · built-in' : ' · custom'}
      </p>
      {owners.map((owner) => (
        <div key={owner}>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide opacity-60">{owner}</p>
          <ListCard subtle>
            {catalog.permissions
              .filter((p) => p.owner === owner)
              .map((p) => {
                const on = held.has(p.id);
                // "Changed" means the instance decided differently from the
                // modules, which is exactly what an admin wants highlighted.
                const changed = on !== defaults.has(p.id);
                return (
                  <div key={p.id} className="flex items-center gap-3 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{p.title}</span>
                      <span className="dim block truncate text-xs">
                        {p.id}
                        {changed ? (on ? ' · granted here' : ' · revoked here') : ''}
                      </span>
                    </div>
                    <Switch
                      checked={on}
                      disabled={busy === p.id}
                      label={`${on ? 'Revoke' : 'Grant'} ${p.id} for ${detail.id}`}
                      onChange={() => void onToggle(p.id, !on)}
                    />
                  </div>
                );
              })}
          </ListCard>
        </div>
      ))}
    </div>
  );
}

function CreateRoleModal({
  roles,
  onClose,
  onDone,
}: {
  roles: readonly RoleRecord[];
  onClose: () => void;
  onDone: (id: string) => void;
}): JSX.Element {
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await coreApi.createRole({
        id: id.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        from: from || undefined,
      });
      onDone(created.role.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New role" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Id</span>
          <input className="input" value={id} onChange={(e) => setId(e.target.value)} placeholder="release-manager" />
          <span className="dim text-xs">Lowercase letters, digits and dashes. Cannot be changed later.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Release Manager" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Start from</span>
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Nothing (no permissions)</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                Copy of {r.title}
              </option>
            ))}
          </select>
          <span className="dim text-xs">A copy takes the source's permissions as its own; it does not stay linked.</span>
        </label>
        <ErrorBar error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !id.trim() || !title.trim()}>
            {busy ? 'Creating…' : 'Create role'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TrashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </svg>
  );
}

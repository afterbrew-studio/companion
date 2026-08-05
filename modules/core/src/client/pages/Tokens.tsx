import { useMemo, useState } from 'react';
import type { Permission } from '@moxxy/companion-contracts';
import {
  Checkbox,
  CopyText,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  ListCard,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  Section,
  timeAgo,
  useConfirm,
} from '@moxxy/companion-ui';
import type {
  ApiTokenCapability,
  ApiTokenRecord,
  CreateApiTokenResponse,
} from '../../contract/index.js';
import { useApiTokens } from '../hooks/useApiTokens.js';
import { useAuth } from '../lib/auth.js';

const EXPIRIES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
] as const;

/** Personal API credentials, plus instance-wide revocation for administrators. */
export function TokensPage(): JSX.Element {
  const { can, user } = useAuth();
  const admin = can('tokens:admin');
  const state = useApiTokens(admin);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateApiTokenResponse | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();

  const revoke = async (token: ApiTokenRecord, anyUser = false): Promise<void> => {
    const confirmed = await confirmDanger({
      title: `Revoke ${token.name}`,
      message: `Anything using this credential will lose access immediately. This cannot be undone.`,
      confirmLabel: 'Revoke token',
    });
    if (confirmed) await state.revoke(token.id, anyUser);
  };

  const others = state.all.filter((token) => token.username !== user?.username);
  const otherTotal = Math.max(state.total - (state.mine?.length ?? 0), 0);
  const canCreate = state.mine !== null && state.capabilities.length > 0;

  return (
    <Page>
      <PageHeader
        title="API tokens"
        subtitle="Scoped credentials for MCP, scripts and external tools"
        actions={
          <button className="btn btn-primary" disabled={!canCreate} onClick={() => setCreating(true)}>
            New token
          </button>
        }
      />
      <ErrorBar error={state.error} />

      <Section
        title="Your tokens"
        description="A token can only use the permissions you select and your account still holds. Its secret is shown once."
      >
        {state.mine === null ? (
          <PageLoading label="Loading tokens…" />
        ) : state.mine.length === 0 ? (
          <EmptyState
            title="No API tokens"
            hint="Create a short-lived, scoped credential instead of sharing your password or local CLI bootstrap token."
            action={
              <button className="btn" disabled={!canCreate} onClick={() => setCreating(true)}>
                Create the first token
              </button>
            }
          />
        ) : (
          <TokenList tokens={state.mine} busy={state.busy} onRevoke={(token) => void revoke(token)} />
        )}
      </Section>

      {admin ? (
        <Section
          title="Other users"
          description={`${otherTotal} active token${otherTotal === 1 ? '' : 's'} belonging to other users. Administrators can revoke a credential, but can never reveal its secret.`}
        >
          {others.length === 0 ? (
            <p className="dim text-[13px]">No other users have active API tokens.</p>
          ) : (
            <TokenList
              tokens={others}
              busy={state.busy}
              showOwner
              onRevoke={(token) => void revoke(token, true)}
            />
          )}
          {otherTotal > others.length ? (
            <p className="dim mt-2 text-xs">Showing the newest {others.length} tokens.</p>
          ) : null}
        </Section>
      ) : null}

      {creating ? (
        <CreateTokenModal
          capabilities={state.capabilities}
          busy={state.busy === 'create'}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const response = await state.create(input);
            if (response) {
              setCreating(false);
              setCreated(response);
            }
          }}
        />
      ) : null}
      {created ? <TokenSecretModal created={created} onClose={() => setCreated(null)} /> : null}
      {confirmElement}
    </Page>
  );
}

function TokenList({
  tokens,
  busy,
  showOwner = false,
  onRevoke,
}: {
  tokens: readonly ApiTokenRecord[];
  busy: string | null;
  showOwner?: boolean;
  onRevoke: (token: ApiTokenRecord) => void;
}): JSX.Element {
  return (
    <ListCard ariaLabel="API tokens">
      {tokens.map((token) => (
        <div key={token.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{token.name}</span>
              {showOwner ? <span className="badge normal-case">{token.username}</span> : null}
            </div>
            <p className="dim mt-0.5 text-xs">
              Created {timeAgo(token.createdAt)} · expires {new Date(token.expiresAt).toLocaleDateString()} ·{' '}
              {token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt)}` : 'never used'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {token.permissions.slice(0, 5).map((permission) => (
                <span key={permission} className="chip font-mono text-[10px]">
                  {permission}
                </span>
              ))}
              {token.permissions.length > 5 ? (
                <span className="chip text-[10px]">+{token.permissions.length - 5} more</span>
              ) : null}
            </div>
          </div>
          <button className="btn-danger" disabled={busy === token.id} onClick={() => onRevoke(token)}>
            {busy === token.id ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      ))}
    </ListCard>
  );
}

function CreateTokenModal({
  capabilities,
  busy,
  onClose,
  onCreate,
}: {
  capabilities: readonly ApiTokenCapability[];
  busy: boolean;
  onClose: () => void;
  onCreate: (input: {
    readonly name: string;
    readonly permissions: readonly Permission[];
    readonly expiresInDays: number;
  }) => Promise<void>;
}): JSX.Element {
  const readOnly = useMemo(
    () => capabilities.filter((capability) => capability.id.endsWith(':read')).map((capability) => capability.id),
    [capabilities],
  );
  const [name, setName] = useState('MCP');
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [selected, setSelected] = useState<readonly Permission[]>(readOnly);
  const [customizing, setCustomizing] = useState(false);
  const owners = [...new Set(capabilities.map((capability) => capability.owner))];

  const toggle = (permission: Permission): void => {
    setSelected((current) =>
      current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission],
    );
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || selected.length === 0) return;
    await onCreate({ name: name.trim(), permissions: selected, expiresInDays });
  };

  return (
    <Modal title="New API token" onClose={onClose} wide>
      <form onSubmit={(event) => void submit(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Where you will use it, for example Codex MCP or release script.">
            <input className="input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Expires">
            <select
              className="input"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
            >
              {EXPIRIES.map((expiry) => (
                <option key={expiry.days} value={expiry.days}>
                  {expiry.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-5">
          <div>
            <div className="text-sm font-medium">Permissions</div>
            <p className="dim text-xs">Start narrow. You can create another token later; scopes cannot be edited.</p>
          </div>
        </div>

        {customizing ? (
          <>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
              <span className="dim text-xs">Choose only what this client needs.</span>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost" onClick={() => setSelected(readOnly)}>
                  Use read-only
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setSelected(capabilities.map((capability) => capability.id))}
                >
                  Select all
                </button>
                <button type="button" className="btn-ghost" onClick={() => setSelected([])}>
                  Clear
                </button>
              </div>
            </div>
            <div className="mt-3 max-h-[42vh] space-y-3 overflow-y-auto pr-1">
              {owners.map((owner) => (
                <div key={owner}>
                  <p className="dim mb-1 text-[10px] font-medium tracking-widest uppercase">{owner}</p>
                  <ListCard subtle>
                    {capabilities
                      .filter((capability) => capability.owner === owner)
                      .map((capability) => (
                        <div key={capability.id} className="flex items-center gap-3 px-3 py-2.5">
                          <Checkbox
                            checked={selected.includes(capability.id)}
                            label={`Allow ${capability.title}`}
                            onToggle={() => toggle(capability.id)}
                          />
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => toggle(capability.id)}
                          >
                            <span className="block text-[13px]">{capability.title}</span>
                            <code className="dim block text-[11px]">{capability.id}</code>
                          </button>
                        </div>
                      ))}
                  </ListCard>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-3.5 py-3 dark:border-zinc-800">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">Read-only access</p>
              <p className="dim mt-0.5 text-xs">
                {readOnly.length} viewing permissions — the safest default for an MCP client.
              </p>
            </div>
            <button type="button" className="btn" onClick={() => setCustomizing(true)}>
              Customize permissions
            </button>
          </div>
        )}

        <FormActions divider>
          <span className="dim mr-auto text-xs">{selected.length} selected</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || selected.length === 0}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

function TokenSecretModal({
  created,
  onClose,
}: {
  created: CreateApiTokenResponse;
  onClose: () => void;
}): JSX.Element {
  const config = JSON.stringify(
    {
      command: 'companion',
      args: ['mcp'],
      env: {
        COMPANION_URL: window.location.origin,
        COMPANION_TOKEN: created.token,
      },
    },
    null,
    2,
  );

  return (
    <Modal title="Token created" onClose={onClose} wide>
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-[13px]">
        Copy this secret now. Companion stores only its hash and cannot show it again.
      </div>
      <div className="mt-4">
        <p className="dim mb-1 text-xs">Bearer token</p>
        <CopyText value={created.token} className="w-full">
          <code className="block w-full overflow-x-auto rounded-lg bg-zinc-100 px-3 py-2.5 text-left text-xs dark:bg-zinc-950">
            {created.token}
          </code>
        </CopyText>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between gap-3">
          <p className="dim text-xs">MCP server configuration</p>
          <CopyText value={config} className="text-xs font-medium">Copy config</CopyText>
        </div>
        <pre className="max-h-72 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-950">{config}</pre>
      </div>
      <FormActions>
        <button className="btn btn-primary" onClick={onClose}>
          I saved it
        </button>
      </FormActions>
    </Modal>
  );
}

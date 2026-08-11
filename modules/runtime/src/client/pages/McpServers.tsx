import { useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  ListCard,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  Section,
  SegmentedControl,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import type {
  CreateMcpServerRequest,
  McpServerRecord,
  RuntimeAccess,
  UpdateMcpServerRequest,
} from '../../contract/index.js';
import { useMcpServers } from '../hooks/useMcpServers.js';

/**
 * Which run may reach which server, stated as the run's own access rather than
 * as a role. A review has no shell and a coding run has one; that difference is
 * already the hard per-run boundary, so an integration is attached to it rather
 * than to a second idea of privilege nobody would keep in sync.
 */
const ACCESS_OPTIONS: ReadonlyArray<{ value: RuntimeAccess; label: string; hint: string }> = [
  { value: 'read-only', label: 'Read-only runs', hint: 'Reviews and triage: they read a checkout and cannot change it.' },
  { value: 'workspace-write', label: 'Coding runs', hint: 'Runs that change a checkout and run commands in it.' },
  { value: 'trusted-assistant', label: 'AI Help', hint: 'Operates this Companion instance and never touches a checkout.' },
];

/**
 * The MCP servers this instance may attach to a run.
 *
 * A server's one secret is never sent back to a browser: an existing record
 * shows only whether one is stored, and an empty field means "keep it".
 */
export function McpServersPage(): React.JSX.Element {
  const { can } = useAuth();
  const { servers, error, busy, create, update, remove, check } = useMcpServers();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, string>>({});
  const { confirmDanger, confirmElement } = useConfirm();
  const manage = can('runtime:manage');

  if (servers === null) return <PageLoading label="Loading MCP servers…" />;

  const runCheck = async (id: string): Promise<void> => {
    const result = await check(id);
    if (!result) return;
    setChecked((current) => ({
      ...current,
      // Everything the server offers, not the narrowed set: this is what an
      // operator fills the allowlist from.
      [id]: result.ok
        ? `connected. The server offers ${result.tools.length} tool(s): ${result.tools.join(', ') || 'none'}`
        : `failed: ${result.detail ?? 'no detail'}`,
    }));
  };

  return (
    <Page>
      <PageHeader
        title="MCP servers"
        subtitle="External tools the built-in runtime may call, attached per run access and workspace"
        actions={
          manage && !adding ? (
            <button className="btn" onClick={() => setAdding(true)}>
              Add server
            </button>
          ) : undefined
        }
      />
      <ErrorBar error={error} />

      {adding && manage && (
        <ServerForm onCancel={() => setAdding(false)} onCreate={create} onUpdate={update} busy={busy} error={error} />
      )}

      {servers.length === 0 && !adding ? (
        <EmptyState
          title="No MCP servers"
          hint="Attach a Model Context Protocol server to give agent runs tools beyond this repository. Nothing is attached by default, and every server names the kind of run it serves."
          action={
            manage ? (
              <button className="btn" onClick={() => setAdding(true)}>
                Add server
              </button>
            ) : undefined
          }
        />
      ) : (
        <Section title="Configured servers">
          <ListCard ariaLabel="MCP servers">
            {servers.map((server) =>
              editing === server.id && manage ? (
                <ServerForm
                  key={server.id}
                  server={server}
                  onCancel={() => setEditing(null)}
                  onCreate={create}
                  onUpdate={update}
                  busy={busy}
                  error={error}
                />
              ) : (
              <ServerRow
                key={server.id}
                server={server}
                manage={manage}
                busy={busy}
                checked={checked[server.id]}
                onCheck={() => void runCheck(server.id)}
                onEdit={() => setEditing(server.id)}
                onToggle={() => void update(server.id, { enabled: !server.enabled })}
                onRemove={async () => {
                  const ok = await confirmDanger({
                    title: `Remove "${server.label}"?`,
                    message: 'Its stored secret is deleted with it, and runs stop being offered its tools.',
                    confirmLabel: 'Remove',
                  });
                  if (ok) void remove(server.id);
                }}
              />
              ),
            )}
          </ListCard>
        </Section>
      )}
      {confirmElement}
    </Page>
  );
}

function ServerRow({
  server,
  manage,
  busy,
  checked,
  onCheck,
  onEdit,
  onToggle,
  onRemove,
}: {
  server: McpServerRecord;
  manage: boolean;
  busy: boolean;
  checked: string | undefined;
  onCheck: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{server.label}</div>
          <div className="text-sm text-zinc-500">
            {server.transport === 'http' ? hostOf(server.url ?? '') : server.command}
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            <MetaSignal tone="zinc" label={server.transport} />
            <MetaSignal tone={server.enabled ? 'green' : 'zinc'} label={server.enabled ? 'enabled' : 'disabled'} />
            <MetaSignal
              tone={server.access.length > 0 ? 'zinc' : 'amber'}
              label={server.access.length > 0 ? server.access.join(', ') : 'no run may use it'}
            />
            <MetaSignal tone="zinc" label={server.tools === null ? 'all tools' : `${server.tools.length} tool(s)`} />
            <MetaSignal
              tone="zinc"
              label={server.workspaceIds === null ? 'every workspace' : `${server.workspaceIds.length} workspace(s)`}
            />
            {server.hasSecret && <MetaSignal tone="green" label="secret stored" />}
          </div>
          {checked && <div className="mt-2 text-sm text-zinc-500">{checked}</div>}
        </div>
        {manage && (
          <div className="flex gap-2">
            <button className="btn btn-ghost" disabled={busy} onClick={onEdit}>
              Edit
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={onCheck}>
              Test
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={onToggle}>
              {server.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ServerForm({
  server,
  onCancel,
  onCreate,
  onUpdate,
  busy,
  error,
}: {
  /** Present when editing; the stored secret is represented only by `hasSecret`. */
  server?: McpServerRecord;
  onCancel: () => void;
  onCreate: (draft: CreateMcpServerRequest) => Promise<boolean>;
  onUpdate: (id: string, fields: UpdateMcpServerRequest) => Promise<boolean>;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport ?? 'http');
  const [label, setLabel] = useState(server?.label ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? []).join('\n'));
  const [pairs, setPairs] = useState(
    server ? pairsText(server.transport === 'http' ? server.headers : server.env) : '',
  );
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [access, setAccess] = useState<readonly RuntimeAccess[]>(server?.access ?? ['workspace-write']);
  const [tools, setTools] = useState((server?.tools ?? []).join('\n'));
  const [workspaces, setWorkspaces] = useState((server?.workspaceIds ?? []).join('\n'));

  const ready = label.trim() !== '' && (transport === 'http' ? url.trim() !== '' : command.trim() !== '');

  const submit = async (): Promise<void> => {
    const values = parsePairs(pairs);
    const allowed = lines(tools);
    const scoped = lines(workspaces);
    const fields = {
      label: label.trim(),
      transport,
      ...(transport === 'http'
        ? { url: url.trim(), headers: values }
        : { command: command.trim(), args: lines(args), env: values }),
      access,
      tools: allowed.length > 0 ? allowed : null,
      workspaceIds: scoped.length > 0 ? scoped : null,
    };
    // Closed only on success: a rejected save keeps the draft and shows why.
    const ok = server
      ? await onUpdate(server.id, {
          ...fields,
          ...(clearSecret ? { secret: null } : secret.trim() === '' ? {} : { secret: secret.trim() }),
        })
      : await onCreate({ ...fields, ...(secret.trim() === '' ? {} : { secret: secret.trim() }) });
    if (ok) onCancel();
  };

  const body = (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        label="Transport"
        name="mcp-transport"
        value={transport}
        onChange={(value) => setTransport(value === 'stdio' ? 'stdio' : 'http')}
        options={[
          { value: 'http', label: 'HTTP' },
          { value: 'stdio', label: 'Command' },
        ]}
      />
      <p className="text-sm text-zinc-500">
        {transport === 'http'
          ? 'A server reached over Streamable HTTP. This is the one that works on a runner you do not install software on.'
          : 'A server started as a subprocess on whichever machine runs the agent. That machine must have the command installed.'}
      </p>
      <Field label="Name">
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ACME issue tracker" />
      </Field>
      {transport === 'http' ? (
        <Field label="Endpoint" hint="The MCP endpoint, e.g. https://mcp.acme.com/mcp">
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>
      ) : (
        <>
          <Field label="Command" hint="Run directly, never through a shell.">
            <input className="input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <textarea className="input" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} />
          </Field>
        </>
      )}
      <Field
        label={transport === 'http' ? 'Headers' : 'Environment'}
        hint={'One NAME=value per line. Write ${secret} where the value below belongs.'}
      >
        <textarea
          className="input"
          rows={3}
          value={pairs}
          onChange={(e) => setPairs(e.target.value)}
          placeholder={transport === 'http' ? 'authorization=Bearer ${secret}' : 'API_TOKEN=${secret}'}
        />
      </Field>
      <Field
        label="Secret"
        hint={
          server?.hasSecret
            ? 'A secret is stored; leave blank to keep it.'
            : 'Stored server-side and never sent back to a browser.'
        }
      >
        <input
          className="input"
          type="password"
          value={secret}
          disabled={clearSecret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </Field>
      {server?.hasSecret && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} />
          <span>Clear the stored secret</span>
        </label>
      )}
      <Field label="Available to" hint="A run whose access is not ticked is never offered this server's tools.">
        <div className="flex flex-col gap-1">
          {ACCESS_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={access.includes(option.value)}
                onChange={(e) =>
                  setAccess((current) =>
                    e.target.checked
                      ? [...current, option.value]
                      : current.filter((entry) => entry !== option.value),
                  )
                }
              />
              <span>
                {option.label}
                <span className="text-zinc-500"> — {option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>
      <Field label="Tools" hint="One name per line to offer only those. Leave empty to offer everything the server lists.">
        <textarea className="input" rows={3} value={tools} onChange={(e) => setTools(e.target.value)} />
      </Field>
      <Field
        label="Workspaces"
        hint="One workspace id per line to offer this server only there. Leave empty to serve every workspace."
      >
        <textarea className="input" rows={2} value={workspaces} onChange={(e) => setWorkspaces(e.target.value)} />
      </Field>
      <ErrorBar error={error} />
      <FormActions>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" disabled={busy || !ready} onClick={() => void submit()}>
          {server ? 'Save' : 'Add server'}
        </button>
      </FormActions>
    </div>
  );

  if (server) {
    return (
      <div className="p-4">
        <div className="mb-4 font-medium">Edit "{server.label}"</div>
        {body}
      </div>
    );
  }
  return <Section title="Add MCP server">{body}</Section>;
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `NAME=value` per line; the first `=` splits, so a value may contain more. */
function parsePairs(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines(value)) {
    const split = line.indexOf('=');
    if (split <= 0) continue;
    out[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return out;
}

function pairsText(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

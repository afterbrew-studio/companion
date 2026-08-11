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
  type StatusTone,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import type {
  CreateProviderRequest,
  ModelProviderRecord,
  ModelRecord,
  ProviderKind,
  UpdateProviderRequest,
} from '../../contract/index.js';
import { useProviders } from '../hooks/useProviders.js';

const KIND_OPTIONS: ReadonlyArray<{ value: ProviderKind; label: string; hint: string }> = [
  { value: 'anthropic', label: 'Anthropic', hint: 'The Anthropic API, or a compatible gateway' },
  { value: 'openai', label: 'OpenAI', hint: 'The OpenAI API' },
  { value: 'azure', label: 'Azure', hint: 'Azure OpenAI or AI Foundry: model ids are deployment names' },
  {
    value: 'openai-compatible',
    label: 'Compatible',
    hint: 'Any gateway or self-hosted endpoint speaking the OpenAI API',
  },
];

/**
 * Which endpoints this instance may call, and which models each serves.
 *
 * A credential is never sent back to a browser, so an existing provider shows
 * only whether one is stored and an empty key field means "keep what is there".
 */
export function ProvidersPage(): React.JSX.Element {
  const { can } = useAuth();
  const { providers, ready, error, busy, create, update, remove, probe, discover } = useProviders();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const manage = can('runtime:manage');

  if (providers === null) return <PageLoading label="Loading providers…" />;

  return (
    <Page>
      <PageHeader
        title="Model endpoints"
        subtitle="Bring your own key: the endpoints and models Companion's built-in runtime may call"
        actions={
          manage && !adding ? (
            <button className="btn" onClick={() => setAdding(true)}>
              Add provider
            </button>
          ) : undefined
        }
      />
      <ErrorBar error={error} />
      <ErrorBar
        error={
          !ready && providers.length > 0
            ? 'No enabled provider has both a credential and a model, so the built-in runtime cannot take work yet.'
            : null
        }
      />

      {adding && manage && <AddProvider onCancel={() => setAdding(false)} onCreate={create} busy={busy} error={error} />}

      {providers.length === 0 && !adding ? (
        <EmptyState
          title="No model providers"
          hint="The built-in runtime calls a model you supply. Add an Anthropic, OpenAI, Azure or OpenAI-compatible endpoint to give it one."
          action={
            manage ? (
              <button className="btn" onClick={() => setAdding(true)}>
                Add provider
              </button>
            ) : undefined
          }
        />
      ) : (
        <Section title="Configured providers">
          <ListCard ariaLabel="Model providers">
            {providers.map((provider) =>
              editing === provider.id && manage ? (
                <EditProvider
                  key={provider.id}
                  provider={provider}
                  busy={busy}
                  error={error}
                  onCancel={() => setEditing(null)}
                  onSave={update}
                />
              ) : (
              <ProviderRow
                key={provider.id}
                provider={provider}
                manage={manage}
                busy={busy}
                onEdit={() => setEditing(provider.id)}
                onToggle={() => void update(provider.id, { enabled: !provider.enabled })}
                onProbe={(model) => void probe(provider.id, model)}
                onDiscover={async () => {
                  const found = await discover(provider.id);
                  if (!found) return;
                  // Discovery suggests; the operator still decides. Anything
                  // already configured keeps its price and probe result.
                  const known = new Set(provider.models.map((m) => m.id));
                  await update(provider.id, {
                    models: [
                      ...provider.models,
                      ...found
                        .filter((id) => !known.has(id))
                        .map((id) => ({
                          id,
                          label: null,
                          contextWindow: null,
                          inputPerMTok: null,
                          outputPerMTok: null,
                          probed: null,
                          options: null,
                        })),
                    ],
                  });
                }}
                onRemove={async () => {
                  const ok = await confirmDanger({
                    title: `Remove "${provider.label}"?`,
                    message:
                      'Its credential is deleted with it, and runs pinned to its models fall through to another provider.',
                    confirmLabel: 'Remove',
                  });
                  if (ok) void remove(provider.id);
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

function ProviderRow({
  provider,
  manage,
  busy,
  onEdit,
  onToggle,
  onProbe,
  onDiscover,
  onRemove,
}: {
  provider: ModelProviderRecord;
  manage: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onProbe: (model: string) => void;
  onDiscover: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{provider.label}</div>
          <div className="text-sm text-zinc-500">
            {provider.kind}
            {provider.baseUrl ? ` · ${hostOf(provider.baseUrl)}` : ''}
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            <MetaSignal
              tone={provider.hasKey ? 'green' : 'amber'}
              label={provider.hasKey ? 'credential stored' : 'no credential'}
            />
            <MetaSignal tone={provider.enabled ? 'green' : 'zinc'} label={provider.enabled ? 'enabled' : 'disabled'} />
            <MetaSignal tone="zinc" label={`${provider.models.length} model(s)`} />
            <MetaSignal
              tone="zinc"
              label={
                provider.workspaceIds === null
                  ? 'every workspace'
                  : `${provider.workspaceIds.length} workspace(s)`
              }
            />
          </div>
        </div>
        {manage && (
          <div className="flex gap-2">
            <button className="btn btn-ghost" disabled={busy} onClick={onEdit}>
              Edit
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={onDiscover}>
              Fetch models
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={onToggle}>
              {provider.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          </div>
        )}
      </div>
      {provider.models.length > 0 && (
        <ul className="mt-3 space-y-1">
          {provider.models.map((model) => (
            <li key={model.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {model.label ?? model.id}
                <span className="text-zinc-500"> · {priceLabel(model)}</span>
              </span>
              <span className="flex items-center gap-2">
                <MetaSignal tone={probeTone(model)} label={probeLabel(model)} />
                {manage && (
                  <button className="btn btn-ghost" disabled={busy} onClick={() => onProbe(model.id)}>
                    Test
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddProvider({
  onCancel,
  onCreate,
  busy,
  error,
}: {
  onCancel: () => void;
  onCreate: (draft: CreateProviderRequest) => Promise<boolean>;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  const [kind, setKind] = useState<ProviderKind>('anthropic');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [models, setModels] = useState('');

  const submit = async (): Promise<void> => {
    // Closed only on success: a rejected create keeps the draft and shows why.
    const ok = await onCreate({
      label: label.trim(),
      kind,
      baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      apiVersion: apiVersion.trim() === '' ? null : apiVersion.trim(),
      models: models
        .split(/[\n,]/)
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .map((id) => ({
          id,
          label: null,
          contextWindow: null,
          inputPerMTok: null,
          outputPerMTok: null,
          probed: null,
          options: null,
        })),
    });
    if (ok) onCancel();
  };

  return (
    <Section title="Add provider">
      {/* `Section` puts no space between its children, so a form built straight
          into one runs its labels into the field above. Same rhythm as the
          integration dialog's own form. */}
      <div className="flex flex-col gap-4">
      <SegmentedControl
        label="Provider kind"
        name="provider-kind"
        value={kind as string}
        onChange={(value) => setKind(value)}
        options={KIND_OPTIONS.map((option) => ({ value: option.value as string, label: option.label }))}
      />
      <p className="-mt-2 text-sm text-zinc-500">{KIND_OPTIONS.find((option) => option.value === kind)?.hint}</p>
      <Field label="Name">
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ACME gateway" />
      </Field>
      <Field
        label="Endpoint"
        hint={
          kind === 'openai-compatible'
            ? 'Required. The base URL this gateway serves, e.g. https://llm.acme.internal/v1'
            : 'Optional. Leave empty for the provider default; set it to point at your own gateway.'
        }
      >
        <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
      </Field>
      {kind === 'azure' && (
        <Field label="API version" hint="The version your resource serves.">
          <input className="input" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
        </Field>
      )}
      <Field label="API key" hint="Stored server-side and never sent back to a browser.">
        <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field
        label="Models"
        hint={
          kind === 'azure'
            ? 'One deployment name per line. On Azure the id you select is a deployment, not a model name.'
            : 'One model id per line, exactly as the provider names it.'
        }
      >
        <textarea className="input" rows={4} value={models} onChange={(e) => setModels(e.target.value)} />
      </Field>
      <ErrorBar error={error} />
      <FormActions>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" disabled={busy || label.trim() === ''} onClick={() => void submit()}>
          Add provider
        </button>
      </FormActions>
      </div>
    </Section>
  );
}

/** What the model table edits; numbers stay text until submit so a field can be emptied. */
interface ModelDraft {
  id: string;
  label: string;
  contextWindow: string;
  inputPerMTok: string;
  outputPerMTok: string;
}

function EditProvider({
  provider,
  busy,
  error,
  onCancel,
  onSave,
}: {
  provider: ModelProviderRecord;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (id: string, fields: UpdateProviderRequest) => Promise<boolean>;
}): React.JSX.Element {
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [apiVersion, setApiVersion] = useState(provider.apiVersion ?? '');
  const [headers, setHeaders] = useState(pairsText(provider.headers));
  const [query, setQuery] = useState(pairsText(provider.query));
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [workspaces, setWorkspaces] = useState((provider.workspaceIds ?? []).join('\n'));
  const [models, setModels] = useState<ModelDraft[]>(
    provider.models.map((model) => ({
      id: model.id,
      label: model.label ?? '',
      contextWindow: model.contextWindow?.toString() ?? '',
      inputPerMTok: model.inputPerMTok?.toString() ?? '',
      outputPerMTok: model.outputPerMTok?.toString() ?? '',
    })),
  );

  const editModel = (index: number, patch: Partial<ModelDraft>): void =>
    setModels((current) => current.map((model, at) => (at === index ? { ...model, ...patch } : model)));

  const submit = async (): Promise<void> => {
    const scoped = lines(workspaces);
    // Closed only on success: a rejected save keeps the draft and shows why.
    const ok = await onSave(provider.id, {
      label: label.trim(),
      baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
      apiVersion: apiVersion.trim() === '' ? null : apiVersion.trim(),
      headers: parsePairs(headers),
      query: parsePairs(query),
      workspaceIds: scoped.length > 0 ? scoped : null,
      models: models.filter((model) => model.id.trim() !== '').map((model) => toModelRecord(model, provider.models)),
      ...(clearKey ? { apiKey: null } : apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    });
    if (ok) onCancel();
  };

  return (
    <div className="p-4">
      <div className="mb-4 font-medium">Edit "{provider.label}"</div>
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field
          label="Endpoint"
          hint={
            provider.kind === 'openai-compatible'
              ? 'Required. The base URL this gateway serves.'
              : 'Optional. Leave empty for the provider default; set it to point at your own gateway.'
          }
        >
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
        </Field>
        {provider.kind === 'azure' && (
          <Field label="API version" hint="The version your resource serves.">
            <input className="input" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
          </Field>
        )}
        <Field label="Extra headers" hint="One NAME=value per line, sent on every call to this endpoint.">
          <textarea className="input" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} />
        </Field>
        <Field label="Extra query parameters" hint="One NAME=value per line, appended to every call to this endpoint.">
          <textarea className="input" rows={2} value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <Field
          label="API key"
          hint={
            provider.hasKey
              ? 'A credential is stored; leave blank to keep it.'
              : 'Stored server-side and never sent back to a browser.'
          }
        >
          <input
            className="input"
            type="password"
            value={apiKey}
            disabled={clearKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        {provider.hasKey && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
            <span>Clear the stored credential</span>
          </label>
        )}
        <Field
          label="Workspaces"
          hint="One workspace id per line to offer this provider only there. Leave empty to serve every workspace."
        >
          <textarea className="input" rows={2} value={workspaces} onChange={(e) => setWorkspaces(e.target.value)} />
        </Field>
        <Field
          label="Models"
          hint="An unpriced model is invisible to the spend ceiling, and without a context window compaction is off for it."
        >
          <div className="flex flex-col gap-2">
            {models.map((model, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <input
                  className="input min-w-44 flex-1"
                  placeholder={provider.kind === 'azure' ? 'deployment name' : 'model id'}
                  value={model.id}
                  onChange={(e) => editModel(index, { id: e.target.value })}
                />
                <input
                  className="input w-36"
                  placeholder="label"
                  value={model.label}
                  onChange={(e) => editModel(index, { label: e.target.value })}
                />
                <input
                  className="input w-28"
                  type="number"
                  min={1}
                  placeholder="context"
                  value={model.contextWindow}
                  onChange={(e) => editModel(index, { contextWindow: e.target.value })}
                />
                <input
                  className="input w-28"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="$/Mtok in"
                  value={model.inputPerMTok}
                  onChange={(e) => editModel(index, { inputPerMTok: e.target.value })}
                />
                <input
                  className="input w-28"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="$/Mtok out"
                  value={model.outputPerMTok}
                  onChange={(e) => editModel(index, { outputPerMTok: e.target.value })}
                />
                <button
                  className="btn btn-ghost"
                  onClick={() => setModels((current) => current.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  setModels((current) => [
                    ...current,
                    { id: '', label: '', contextWindow: '', inputPerMTok: '', outputPerMTok: '' },
                  ])
                }
              >
                Add model
              </button>
            </div>
          </div>
        </Field>
        <ErrorBar error={error} />
        <FormActions>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" disabled={busy || label.trim() === ''} onClick={() => void submit()}>
            Save
          </button>
        </FormActions>
      </div>
    </div>
  );
}

function toModelRecord(draft: ModelDraft, original: readonly ModelRecord[]): ModelRecord {
  const kept = original.find((model) => model.id === draft.id.trim());
  return {
    id: draft.id.trim(),
    label: draft.label.trim() === '' ? null : draft.label.trim(),
    contextWindow: numberOrNull(draft.contextWindow),
    inputPerMTok: numberOrNull(draft.inputPerMTok),
    outputPerMTok: numberOrNull(draft.outputPerMTok),
    // Carried, never edited here: `options` rides to the SDK verbatim, and
    // `probed` is server-owned (the service keeps its stored value anyway).
    probed: kept?.probed ?? null,
    options: kept?.options ?? null,
  };
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
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

/** An unpriced model is invisible to the spend ceiling, so it says so. */
function priceLabel(model: ModelRecord): string {
  if (model.inputPerMTok === null || model.outputPerMTok === null) return 'unpriced';
  return `$${model.inputPerMTok}/$${model.outputPerMTok} per Mtok`;
}

function probeTone(model: ModelRecord): StatusTone {
  if (!model.probed) return 'zinc';
  if (!model.probed.ok) return 'red';
  return model.probed.tools ? 'green' : 'amber';
}

function probeLabel(model: ModelRecord): string {
  if (!model.probed) return 'not tested';
  if (!model.probed.ok) return 'failed';
  return model.probed.tools ? 'tools work' : 'no tool calling';
}

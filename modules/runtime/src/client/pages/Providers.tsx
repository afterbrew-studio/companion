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
import type { CreateProviderRequest, ModelProviderRecord, ModelRecord, ProviderKind } from '../../contract/index.js';
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
export function ProvidersPage(): JSX.Element {
  const { can } = useAuth();
  const { providers, ready, error, busy, create, update, remove, probe, discover } = useProviders();
  const [adding, setAdding] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();
  const manage = can('runtime:manage');

  if (providers === null) return <PageLoading label="Loading providers…" />;

  return (
    <Page>
      <PageHeader
        title="Model providers"
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

      {adding && manage && <AddProvider onCancel={() => setAdding(false)} onCreate={create} busy={busy} />}

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
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                manage={manage}
                busy={busy}
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
            ))}
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
  onToggle,
  onProbe,
  onDiscover,
  onRemove,
}: {
  provider: ModelProviderRecord;
  manage: boolean;
  busy: boolean;
  onToggle: () => void;
  onProbe: (model: string) => void;
  onDiscover: () => void;
  onRemove: () => void;
}): JSX.Element {
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
          </div>
        </div>
        {manage && (
          <div className="flex gap-2">
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
}: {
  onCancel: () => void;
  onCreate: (draft: CreateProviderRequest) => Promise<void>;
  busy: boolean;
}): JSX.Element {
  const [kind, setKind] = useState<ProviderKind>('anthropic');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [models, setModels] = useState('');

  const submit = async (): Promise<void> => {
    await onCreate({
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
    onCancel();
  };

  return (
    <Section title="Add provider">
      <SegmentedControl
        label="Provider kind"
        name="provider-kind"
        value={kind as string}
        onChange={(value) => setKind(value)}
        options={KIND_OPTIONS.map((option) => ({ value: option.value as string, label: option.label }))}
      />
      <p className="text-sm text-zinc-500">{KIND_OPTIONS.find((option) => option.value === kind)?.hint}</p>
      <Field label="Name">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ACME gateway" />
      </Field>
      <Field
        label="Endpoint"
        hint={
          kind === 'openai-compatible'
            ? 'Required. The base URL this gateway serves, e.g. https://llm.acme.internal/v1'
            : 'Optional. Leave empty for the provider default; set it to point at your own gateway.'
        }
      >
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
      </Field>
      {kind === 'azure' && (
        <Field label="API version" hint="The version your resource serves.">
          <input value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />
        </Field>
      )}
      <Field label="API key" hint="Stored server-side and never sent back to a browser.">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field
        label="Models"
        hint={
          kind === 'azure'
            ? 'One deployment name per line. On Azure the id you select is a deployment, not a model name.'
            : 'One model id per line, exactly as the provider names it.'
        }
      >
        <textarea rows={4} value={models} onChange={(e) => setModels(e.target.value)} />
      </Field>
      <FormActions>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" disabled={busy || label.trim() === ''} onClick={() => void submit()}>
          Add provider
        </button>
      </FormActions>
    </Section>
  );
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

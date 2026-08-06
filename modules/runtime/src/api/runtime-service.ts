import { randomUUID } from 'node:crypto';
import { probeModel, type ResolvedModelSpec, type RuntimeLimits } from '@moxxy/companion-runtime';
import type {
  CreateProviderRequest,
  ModelProviderRecord,
  ModelRecord,
  ProbeResult,
} from '../contract/index.js';
import { rowToProvider, type ProviderRow, type ProvidersStore } from './providers-store.js';

/** A provider as declared in `companiond.json`, credential taken by indirection. */
export interface DeclaredProvider extends Omit<CreateProviderRequest, 'apiKey'> {
  readonly id: string;
  /** Name of the environment variable holding the key, so k8s secrets work. */
  readonly apiKeyEnv?: string;
}

/**
 * This module's own secret storage (`ctx.secrets`), named structurally so the
 * service does not depend on where the kernel keeps it: an instance pointed at
 * Vault answers the same four calls.
 */
export interface ProviderSecrets {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface RuntimeConfig {
  readonly maxSteps: number;
  readonly turnTimeoutMinutes: number;
  readonly childMemoryMb: number;
  readonly commandTimeoutMinutes: number;
  readonly toolOutputChars: number;
}

/**
 * The provider registry: which endpoints this instance may call, which models
 * each serves, and what one run resolves to.
 *
 * The credential lives in the kernel's secret store rather than in the table,
 * so an instance pointed at Vault keeps it there and the read API can answer
 * "configured?" without ever reading it.
 */
export class RuntimeService {
  constructor(
    private readonly store: ProvidersStore,
    private readonly secrets: ProviderSecrets,
    private readonly config: () => RuntimeConfig,
    private readonly broadcast: () => void,
  ) {}

  // ---------- records ---------------------------------------------------------

  list(): ModelProviderRecord[] {
    return this.store.list().map((row) => rowToProvider(row, this.secrets.get(keyOf(row.id)) !== null));
  }

  get(id: string): ModelProviderRecord | null {
    const row = this.store.get(id);
    return row ? rowToProvider(row, this.secrets.get(keyOf(id)) !== null) : null;
  }

  create(request: CreateProviderRequest): ModelProviderRecord {
    const id = slug(request.label);
    const row = toRow(id, request, Date.now());
    this.store.insert(row);
    if (request.apiKey) this.secrets.set(keyOf(id), request.apiKey);
    this.broadcast();
    return rowToProvider(row, request.apiKey !== undefined);
  }

  /** An empty `apiKey` leaves the stored credential alone: the form never sees it. */
  update(id: string, patch: Partial<CreateProviderRequest>): ModelProviderRecord | null {
    const existing = this.store.get(id);
    if (!existing) return null;
    const merged = toRow(id, { ...rowToRequest(existing), ...patch }, existing.created_at);
    this.store.update(merged);
    if (patch.apiKey) this.secrets.set(keyOf(id), patch.apiKey);
    this.broadcast();
    return rowToProvider(merged, this.secrets.get(keyOf(id)) !== null);
  }

  delete(id: string): void {
    this.store.delete(id);
    this.secrets.delete(keyOf(id));
    this.broadcast();
  }

  // ---------- resolution ------------------------------------------------------

  /**
   * A model reference is `providerId:modelId`. Two providers can serve the same
   * model name, so a bare id is ambiguous by construction; it still resolves,
   * to the first enabled provider that lists it, because every pin written
   * before this module existed is a bare id.
   */
  resolve(ref: string | null, workspaceId?: string | null): ResolvedModelSpec | null {
    const providers = this.list().filter((p) => p.enabled && this.inScope(p, workspaceId));
    if (providers.length === 0) return null;
    const [head, ...rest] = ref?.split(':') ?? [];
    const qualified = rest.length > 0 ? { providerId: head ?? '', modelId: rest.join(':') } : null;

    if (qualified) {
      const provider = providers.find((p) => p.id === qualified.providerId);
      const model = provider?.models.find((m) => m.id === qualified.modelId);
      if (provider && model) return this.specFor(provider, model);
    }
    if (ref) {
      for (const provider of providers) {
        const model = provider.models.find((m) => m.id === ref);
        if (model) return this.specFor(provider, model);
      }
    }
    // An unpinned run takes the first model of the first configured provider,
    // which is the operator's own ordering rather than a preference of ours.
    const first = providers.find((p) => p.models.length > 0);
    const model = first?.models[0];
    return first && model ? this.specFor(first, model) : null;
  }

  /** Whether this instance can run anything at all, which is its readiness. */
  ready(): boolean {
    return this.list().some((p) => p.enabled && p.models.length > 0 && (p.hasKey || p.kind === 'openai-compatible'));
  }

  /** Every model this instance may run, shaped as the catalog reader expects. */
  catalog(): { name: string; enabled: boolean; ready: boolean; models: { id: string; contextWindow: number | null }[] }[] {
    return this.list().map((provider) => ({
      name: provider.id,
      enabled: provider.enabled,
      ready: provider.hasKey || provider.kind === 'openai-compatible',
      models: provider.models.map((model) => ({ id: model.id, contextWindow: model.contextWindow })),
    }));
  }

  limits(): RuntimeLimits {
    const config = this.config();
    return {
      maxSteps: config.maxSteps,
      turnTimeoutMs: config.turnTimeoutMinutes * 60_000,
      toolOutputChars: config.toolOutputChars,
      commandTimeoutMs: config.commandTimeoutMinutes * 60_000,
      memoryMb: config.childMemoryMb,
    };
  }

  /**
   * The price the operator declared, snapshotted onto a run when it starts.
   * Editing a record later must not reprice last month's runs, and the built-in
   * table stays the answer for a model nobody priced here.
   */
  priceFor(ref: string | null): { inputPerMTok: number; outputPerMTok: number } | null {
    if (ref === null) return null;
    // Matched against what was CONFIGURED rather than through `resolve`, whose
    // job is to pick a model for a run: an unpinned run resolves to the first
    // one, which would price every unknown id as that model.
    const [head, ...rest] = ref.split(':');
    const qualified = rest.length > 0 ? { providerId: head ?? '', modelId: rest.join(':') } : null;
    for (const provider of this.list()) {
      if (qualified && provider.id !== qualified.providerId) continue;
      const model = provider.models.find((m) => m.id === (qualified ? qualified.modelId : ref));
      if (!model || model.inputPerMTok === null || model.outputPerMTok === null) continue;
      return { inputPerMTok: model.inputPerMTok, outputPerMTok: model.outputPerMTok };
    }
    return null;
  }

  // ---------- configuration as code -------------------------------------------

  /**
   * Providers declared in daemon configuration rather than clicked in. A hosted
   * deployment is reproducible only if its providers ship with the container,
   * and the key arrives by environment indirection so it can be a mounted
   * secret. The daemon reads the variable; the runtime never does.
   */
  adopt(declared: readonly DeclaredProvider[]): void {
    for (const entry of declared) {
      const key = entry.apiKeyEnv ? (process.env[entry.apiKeyEnv] ?? '') : '';
      const request: CreateProviderRequest = { ...entry, ...(key ? { apiKey: key } : {}) };
      if (this.store.get(entry.id)) this.update(entry.id, request);
      else {
        const row = toRow(entry.id, request, Date.now());
        this.store.insert(row);
        if (key) this.secrets.set(keyOf(entry.id), key);
      }
    }
    if (declared.length > 0) this.broadcast();
  }

  // ---------- probing ---------------------------------------------------------

  /**
   * One real round trip, recorded on the model. Detecting beats asking: an
   * endpoint that advertises a model it cannot tool-call is common, and the
   * first real run is the wrong place to discover it.
   */
  async probe(providerId: string, modelId: string): Promise<ProbeResult> {
    const spec = this.resolve(`${providerId}:${modelId}`);
    if (!spec) throw new Error(`model ${modelId} is not configured on ${providerId}`);
    const probe = await probeModel(spec);
    const provider = this.get(providerId);
    if (provider) {
      this.update(providerId, {
        models: provider.models.map((model) => (model.id === modelId ? { ...model, probed: probe } : model)),
      });
    }
    return { model: modelId, probe };
  }

  private inScope(provider: ModelProviderRecord, workspaceId?: string | null): boolean {
    if (provider.workspaceIds === null) return true;
    return workspaceId !== undefined && workspaceId !== null && provider.workspaceIds.includes(workspaceId);
  }

  private specFor(provider: ModelProviderRecord, model: ModelRecord): ResolvedModelSpec {
    return {
      providerId: provider.id,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey: this.secrets.get(keyOf(provider.id)),
      headers: provider.headers,
      query: provider.query,
      model: model.id,
      contextWindow: model.contextWindow,
      apiVersion: provider.apiVersion,
      sampling: {},
      providerOptions: model.options ?? {},
      factoryOptions: provider.factoryOptions,
    };
  }
}

function keyOf(providerId: string): string {
  return `provider:${providerId}:key`;
}

function slug(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base.length > 0 ? `${base}-${randomUUID().slice(0, 4)}` : randomUUID().slice(0, 8);
}

function toRow(id: string, request: CreateProviderRequest, createdAt: number): ProviderRow {
  return {
    id,
    label: request.label,
    kind: request.kind,
    base_url: request.baseUrl ?? null,
    headers: JSON.stringify(request.headers ?? {}),
    query: JSON.stringify(request.query ?? {}),
    api_version: request.apiVersion ?? null,
    factory_options: JSON.stringify(request.factoryOptions ?? {}),
    models: JSON.stringify(request.models ?? []),
    workspace_ids: request.workspaceIds ? JSON.stringify(request.workspaceIds) : null,
    enabled: request.enabled === false ? 0 : 1,
    created_at: createdAt,
  };
}

function rowToRequest(row: ProviderRow): CreateProviderRequest {
  const record = rowToProvider(row, false);
  return {
    label: record.label,
    kind: record.kind,
    baseUrl: record.baseUrl,
    headers: record.headers,
    query: record.query,
    apiVersion: record.apiVersion,
    factoryOptions: record.factoryOptions,
    workspaceIds: record.workspaceIds,
    models: record.models,
    enabled: record.enabled,
  };
}

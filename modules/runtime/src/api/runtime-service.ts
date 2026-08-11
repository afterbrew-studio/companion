import { randomUUID } from 'node:crypto';
import {
  probeMcpServer,
  probeModel,
  type McpServerSpec,
  type ResolvedModelSpec,
  type RuntimeAccess,
  type RuntimeLimits,
} from '@moxxy/companion-runtime';
import type {
  CreateMcpServerRequest,
  CreateProviderRequest,
  McpCheckResult,
  McpServerRecord,
  ModelProbe,
  ModelProviderRecord,
  ModelRecord,
  ProbeResult,
  UpdateMcpServerRequest,
  UpdateProviderRequest,
} from '../contract/index.js';
import { rowToMcpServer, type McpServerRow, type McpServersStore } from './mcp-store.js';
import { rowToProvider, type ProviderRow, type ProvidersStore } from './providers-store.js';

/** A provider as declared in `companiond.json`, credential taken by indirection. */
export interface DeclaredProvider extends Omit<CreateProviderRequest, 'apiKey'> {
  readonly id: string;
  /** Name of the environment variable holding the key, so k8s secrets work. */
  readonly apiKeyEnv?: string;
}

/** An MCP server as declared in `companiond.json`, secret taken by indirection. */
export interface DeclaredMcpServer extends Omit<CreateMcpServerRequest, 'secret'> {
  readonly id: string;
  readonly secretEnv?: string;
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
  readonly approvalTimeoutMinutes: number;
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
    private readonly mcpStore: McpServersStore,
    private readonly secrets: ProviderSecrets,
    private readonly config: () => RuntimeConfig,
    private readonly broadcast: () => void,
    /** Injectable so tests can drive probe timing; production uses the real one. */
    private readonly probeFn: typeof probeModel = probeModel,
  ) {}

  /**
   * Per-provider write lane over the models JSON column, which probe results
   * and operator edits both read-modify-write. Chaining them through one
   * promise per provider keeps each sequence atomic even when a step awaits,
   * and an idle provider holds no entry: a lane deletes itself once its last
   * job settles.
   */
  private readonly lanes = new Map<string, Promise<unknown>>();

  private withProvider<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(id) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    this.lanes.set(id, settled);
    void settled.then(() => {
      if (this.lanes.get(id) === settled) this.lanes.delete(id);
    });
    return next;
  }

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

  /**
   * The credential is tri-state: absent (or empty, which is what a form whose
   * key field was left alone sends) keeps the stored one, a string replaces
   * it, null clears it.
   */
  update(id: string, patch: UpdateProviderRequest): Promise<ModelProviderRecord | null> {
    return this.withProvider(id, async () => {
      const existing = this.store.get(id);
      if (!existing) return null;
      const current = rowToRequest(existing);
      // `probed` is what a probe observed, never what a patch claims: an edit
      // built from a stale read (or a declared provider re-adopted at boot)
      // must not erase or invent an observation, so the stored value wins for
      // every id that survives the patch.
      const observed = new Map((current.models ?? []).map((model) => [model.id, model.probed]));
      const { apiKey, models, ...fields } = patch;
      const kept = models?.map((model) => ({ ...model, probed: observed.get(model.id) ?? null }));
      const merged = toRow(id, { ...current, ...fields, ...(kept ? { models: kept } : {}) }, existing.created_at);
      this.store.update(merged);
      if (apiKey === null) this.secrets.delete(keyOf(id));
      else if (apiKey) this.secrets.set(keyOf(id), apiKey);
      this.broadcast();
      return rowToProvider(merged, this.secrets.get(keyOf(id)) !== null);
    });
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
      approvalTimeoutMs: config.approvalTimeoutMinutes * 60_000,
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
  async adopt(declared: readonly DeclaredProvider[]): Promise<void> {
    for (const entry of declared) {
      const key = entry.apiKeyEnv ? (process.env[entry.apiKeyEnv] ?? '') : '';
      const request: CreateProviderRequest = { ...entry, ...(key ? { apiKey: key } : {}) };
      if (this.store.get(entry.id)) await this.update(entry.id, request);
      else {
        const row = toRow(entry.id, request, Date.now());
        this.store.insert(row);
        if (key) this.secrets.set(keyOf(entry.id), key);
      }
    }
    if (declared.length > 0) this.broadcast();
  }

  // ---------- discovery -------------------------------------------------------

  /**
   * The models an endpoint says it serves.
   *
   * Discovery is a CONVENIENCE; the ticked subset is policy. An operator who
   * fetches a list still chooses what this instance may run, because "the
   * gateway offers it" is not the same as "we permit spending on it".
   *
   * Azure is the one kind that cannot answer: its deployments live behind the
   * management API rather than the inference endpoint, so it says so instead of
   * returning an empty list that would read as "none".
   */
  async discover(providerId: string): Promise<readonly string[]> {
    const provider = this.get(providerId);
    if (!provider) throw new Error('provider not found');
    if (provider.kind === 'azure') {
      throw new Error('Azure lists deployments through its management API, not the endpoint: enter the names instead');
    }
    const key = this.secrets.get(keyOf(providerId));
    const base = (provider.baseUrl ?? DEFAULT_ENDPOINTS[provider.kind] ?? '').replace(/\/+$/, '');
    if (!base) throw new Error(`no endpoint to ask: set one on ${provider.label}`);
    const response = await fetch(`${base}/models`, {
      headers: {
        ...provider.headers,
        ...(key ? authHeader(provider.kind, key) : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${provider.label} answered ${response.status} when asked for its models`);
    const body = (await response.json()) as { data?: readonly { id?: unknown }[] };
    return (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
  }

  // ---------- MCP servers -----------------------------------------------------

  listMcp(): McpServerRecord[] {
    return this.mcpStore.list().map((row) => rowToMcpServer(row, this.secrets.get(mcpKeyOf(row.id)) !== null));
  }

  getMcp(id: string): McpServerRecord | null {
    const row = this.mcpStore.get(id);
    return row ? rowToMcpServer(row, this.secrets.get(mcpKeyOf(id)) !== null) : null;
  }

  createMcp(request: CreateMcpServerRequest): McpServerRecord {
    const id = slug(request.label);
    const row = toMcpRow(id, request, Date.now());
    this.mcpStore.insert(row);
    if (request.secret) this.secrets.set(mcpKeyOf(id), request.secret);
    this.broadcast();
    // Reported from what was actually STORED. An empty string is a field the
    // operator left blank, and answering `hasSecret: true` to it would put a
    // green flag on a server that has no credential.
    return rowToMcpServer(row, Boolean(request.secret));
  }

  /** `secret` is tri-state: absent or empty keeps the stored one, a string replaces it, null clears it. */
  updateMcp(id: string, patch: UpdateMcpServerRequest): McpServerRecord | null {
    const existing = this.mcpStore.get(id);
    if (!existing) return null;
    const { secret, ...fields } = patch;
    const merged = toMcpRow(id, { ...mcpRowToRequest(existing), ...fields }, existing.created_at);
    this.mcpStore.update(merged);
    if (secret === null) this.secrets.delete(mcpKeyOf(id));
    else if (secret) this.secrets.set(mcpKeyOf(id), secret);
    this.broadcast();
    return rowToMcpServer(merged, this.secrets.get(mcpKeyOf(id)) !== null);
  }

  deleteMcp(id: string): void {
    this.mcpStore.delete(id);
    this.secrets.delete(mcpKeyOf(id));
    this.broadcast();
  }

  /**
   * The servers one run may reach.
   *
   * Both gates are applied here rather than in the runtime: `access` is the
   * operator's statement about what kind of run a server serves, and the
   * workspace scope is the same one providers use. The runtime receives the
   * result and has no way to widen it.
   */
  mcpFor(access: RuntimeAccess, workspaceId?: string | null): readonly McpServerSpec[] {
    return this.listMcp()
      .filter((record) => record.enabled && record.access.includes(access) && this.inMcpScope(record, workspaceId))
      .map((record) => this.mcpSpecFor(record));
  }

  /** Connect once and report what it offers, so a bad record is known on save. */
  async checkMcp(id: string): Promise<McpCheckResult> {
    const record = this.getMcp(id);
    if (!record) throw new Error('MCP server not found');
    const outcome = await probeMcpServer({ ...this.mcpSpecFor(record), tools: null });
    return { ok: outcome.ok, tools: outcome.tools, detail: outcome.detail };
  }

  /**
   * MCP servers declared in daemon configuration rather than clicked in, so a
   * hosted deployment ships with its integrations. The secret arrives through
   * `secretEnv` for the same reason a provider key does.
   */
  adoptMcp(declared: readonly DeclaredMcpServer[]): void {
    for (const entry of declared) {
      const secret = entry.secretEnv ? (process.env[entry.secretEnv] ?? '') : '';
      const request: CreateMcpServerRequest = { ...entry, ...(secret ? { secret } : {}) };
      if (this.mcpStore.get(entry.id)) this.updateMcp(entry.id, request);
      else {
        const row = toMcpRow(entry.id, request, Date.now());
        this.mcpStore.insert(row);
        if (secret) this.secrets.set(mcpKeyOf(entry.id), secret);
      }
    }
    if (declared.length > 0) this.broadcast();
  }

  private inMcpScope(record: McpServerRecord, workspaceId?: string | null): boolean {
    if (record.workspaceIds === null) return true;
    return workspaceId !== undefined && workspaceId !== null && record.workspaceIds.includes(workspaceId);
  }

  /**
   * Record → what the runtime is handed, with the one secret substituted into
   * wherever the operator wrote `${secret}`. Each server has its own idea of
   * how a credential is presented — a bearer header, `GITHUB_TOKEN`, a query
   * gateway's own header — and this models none of them.
   */
  private mcpSpecFor(record: McpServerRecord): McpServerSpec {
    const secret = this.secrets.get(mcpKeyOf(record.id)) ?? '';
    const fill = (values: Readonly<Record<string, string>>): Record<string, string> =>
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.split(SECRET_TOKEN).join(secret)]));
    return {
      id: record.id,
      label: record.label,
      transport:
        record.transport === 'http'
          ? { kind: 'http', url: record.url ?? '', headers: fill(record.headers) }
          : { kind: 'stdio', command: record.command ?? '', args: record.args, env: fill(record.env) },
      tools: record.tools,
    };
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
    const probe = await this.probeFn(spec);
    await this.recordProbe(providerId, modelId, probe);
    return { model: modelId, probe };
  }

  /**
   * The one write path allowed to set `probed`, re-reading inside the lane so
   * the result lands on the models as they are NOW, not as they were when the
   * probe left. A model the operator removed mid-probe records nothing.
   */
  private recordProbe(providerId: string, modelId: string, probe: ModelProbe): Promise<void> {
    return this.withProvider(providerId, async () => {
      const existing = this.store.get(providerId);
      if (!existing) return;
      const record = rowToProvider(existing, false);
      const models = record.models.map((model) => (model.id === modelId ? { ...model, probed: probe } : model));
      this.store.update({ ...existing, models: JSON.stringify(models) });
      this.broadcast();
    });
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

/** Where a kind asks when the operator did not name an endpoint. */
const DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

/** How each kind carries its credential, which is the one thing they differ on here. */
function authHeader(kind: string, key: string): Record<string, string> {
  if (kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { authorization: `Bearer ${key}` };
}

function keyOf(providerId: string): string {
  return `provider:${providerId}:key`;
}

function mcpKeyOf(serverId: string): string {
  return `mcp:${serverId}:secret`;
}

/** Where a server's one secret is substituted, wherever the operator wrote it. */
const SECRET_TOKEN = '${secret}';

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

function toMcpRow(id: string, request: CreateMcpServerRequest, createdAt: number): McpServerRow {
  return {
    id,
    label: request.label,
    transport: request.transport,
    command: request.command ?? null,
    args: JSON.stringify(request.args ?? []),
    env: JSON.stringify(request.env ?? {}),
    url: request.url ?? null,
    headers: JSON.stringify(request.headers ?? {}),
    access: JSON.stringify(request.access ?? []),
    tools: request.tools ? JSON.stringify(request.tools) : null,
    workspace_ids: request.workspaceIds ? JSON.stringify(request.workspaceIds) : null,
    enabled: request.enabled === false ? 0 : 1,
    created_at: createdAt,
  };
}

function mcpRowToRequest(row: McpServerRow): CreateMcpServerRequest {
  const record = rowToMcpServer(row, false);
  return {
    label: record.label,
    transport: record.transport,
    command: record.command,
    args: record.args,
    env: record.env,
    url: record.url,
    headers: record.headers,
    access: record.access,
    tools: record.tools,
    workspaceIds: record.workspaceIds,
    enabled: record.enabled,
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

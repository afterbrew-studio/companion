import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type {
  EffectiveIntegrationRoute,
  IntegrationCapability,
  IntegrationCatalog,
  IntegrationConfigField,
  IntegrationConnectionDraft,
  IntegrationConnectionRecord,
  IntegrationFieldValue,
  IntegrationHealth,
  IntegrationProviderDescriptor,
  IntegrationRouteRecord,
  IntegrationScope,
  IntegrationTargetRef,
} from '../contract/index.js';
import type {
  IntegrationConnectionAccess,
  IntegrationExecutor,
  IntegrationExecutorResolver,
  IntegrationNotificationInput,
  IntegrationProbeContext,
  IntegrationProviderAdapter,
  IntegrationReviewRequest,
  IntegrationReviewResult,
  ResolvedIntegrationTarget,
} from './provider.js';
import { IntegrationUnavailableError } from './provider.js';
import { IntegrationsStore } from './integrations-store.js';

const PROVIDER_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const MODULE_ID = /^[a-z][a-z0-9-]*$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/;
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CONNECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const CONNECTION_SECRET_PREFIX = 'connection:';
// Keyed by the union rather than listed, so widening the field kinds fails to
// compile here instead of failing to register a provider at boot.
const FIELD_KINDS = new Set<string>(Object.keys({
  text: true,
  url: true,
  secret: true,
  boolean: true,
  select: true,
  multiselect: true,
} satisfies Record<IntegrationConfigField['kind'], true>));
const PROBE_TIMEOUT_MS = 20_000;
const DELIVERY_TIMEOUT_MS = 30_000;
const integrationHealthSchema = z.object({
  status: z.enum(['unknown', 'checking', 'ready', 'degraded', 'unavailable']),
  message: z.string().max(1_000),
  checkedAt: z.number().int().nonnegative().nullable(),
}).strict();
const integrationFindingSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  title: z.string().min(1).max(180),
  file: z.string().max(1_000).nullable(),
  line: z.number().int().positive().nullable(),
  reason: z.string().max(4_000),
  impact: z.string().max(4_000),
  suggestion: z.string().max(4_000),
  confidence: z.number().finite().min(0).max(1),
}).strict();
const integrationReviewResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('draft'),
    summary: z.string().max(20_000),
    reviewBody: z.string().max(100_000),
    findings: z.array(integrationFindingSchema).max(500),
    coverage: z.enum(['complete', 'partial']),
  }).strict(),
  z.object({
    kind: z.literal('delegated'),
    summary: z.string().max(20_000),
    externalUrl: z.string().max(2_000).url().refine(safeExternalUrl, 'externalUrl must be an HTTP(S) URL').nullable(),
  }).strict(),
  z.object({
    kind: z.literal('skipped'),
    summary: z.string().max(20_000),
  }).strict(),
]);
const integrationDeliveryResultSchema = z.object({
  ok: z.boolean(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  error: z.string().max(1_000).nullable(),
  attempts: z.number().int().min(0).max(10),
}).strict();

type ConfigInput = Readonly<Record<string, IntegrationFieldValue | null>>;

/** Structural slice of `ctx.secrets`; kept local because ModuleSecrets is a
 * context capability, not part of the public SDK type barrel. */
interface IntegrationSecrets {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(): readonly string[];
}

export interface ConnectionPatch {
  readonly name?: string;
  readonly scope?: IntegrationScope;
  readonly enabled?: boolean;
  readonly config?: ConfigInput;
}

/**
 * Open provider catalog + durable connection authority.
 *
 * Executable adapters are process-local and follow module lifecycle. Connection
 * records survive a disabled provider, which makes toggling a module reversible
 * without retaining stale executable callbacks.
 */
export class IntegrationsService {
  private readonly providersById = new Map<string, IntegrationProviderAdapter>();

  constructor(
    private readonly store: IntegrationsStore,
    private readonly secrets: IntegrationSecrets,
    private readonly broadcast: (message: SpaServerMessage) => void,
  ) {}

  /**
   * Where a provider's executable can be run, answered by the layer that owns
   * machines. Late-bound and optional: a build without a machine registry finds
   * none, and a probe told "nowhere" reports that instead of guessing.
   */
  setExecutors(resolve: IntegrationExecutorResolver): void {
    this.executors = resolve;
  }

  private executors: IntegrationExecutorResolver = async () => [];

  /**
   * Machines that can run this provider's executable, most preferred first.
   * Empty for a provider that declares none: it has nothing to place.
   */
  async executorsFor(
    providerId: string,
    options: { readonly repo?: string | null; readonly userId?: string | null } = {},
  ): Promise<readonly IntegrationExecutor[]> {
    const provider = this.providersById.get(providerId);
    if (!provider || !provider.descriptor.requires?.length) return [];
    return this.executors(providerId, options);
  }

  registerProvider(adapter: IntegrationProviderAdapter): () => void {
    assertProvider(adapter);
    const existing = this.providersById.get(adapter.descriptor.id);
    if (existing) {
      throw new Error(
        `integration provider '${adapter.descriptor.id}' is already owned by module '${existing.descriptor.moduleId}'`,
      );
    }
    for (const capability of adapter.descriptor.defaultFor ?? []) {
      const currentDefault = [...this.providersById.values()].find((provider) =>
        provider.descriptor.defaultFor?.includes(capability),
      );
      if (currentDefault) {
        throw new Error(
          `${capability} already has default provider '${currentDefault.descriptor.id}'; use an explicit route for fallback`,
        );
      }
    }
    this.providersById.set(adapter.descriptor.id, adapter);
    this.changed();
    return () => {
      if (this.providersById.get(adapter.descriptor.id) !== adapter) return;
      this.providersById.delete(adapter.descriptor.id);
      this.changed();
    };
  }

  providers(): IntegrationProviderDescriptor[] {
    return [...this.providersById.values()]
      .map((provider) => provider.descriptor)
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.title.localeCompare(b.title));
  }

  /** `manager` widens visibility to every personal connection (admin cleanup view). */
  catalog(viewer: string | null, manager = false): IntegrationCatalog {
    return {
      providers: this.providers(),
      connections: this.connectionsVisibleTo(viewer, manager),
    };
  }

  connectionsVisibleTo(viewer: string | null, manager = false): IntegrationConnectionRecord[] {
    return this.allConnections().filter(
      (connection) => manager || connection.ownerId === null || connection.ownerId === viewer,
    );
  }

  getConnection(id: string): IntegrationConnectionRecord | undefined {
    return this.store.get(id, this.secretKeys(id));
  }

  createConnection(draft: IntegrationConnectionDraft, ownerId: string | null): IntegrationConnectionRecord {
    return this.createConnectionWithId(`ic-${randomUUID().slice(0, 12)}`, draft, ownerId);
  }

  private createConnectionWithId(
    id: string,
    draft: IntegrationConnectionDraft,
    ownerId: string | null,
  ): IntegrationConnectionRecord {
    if (!CONNECTION_ID.test(id)) throw new Error('integration connection id is invalid');
    const provider = this.requireProvider(draft.providerId);
    this.assertScope(provider.descriptor, draft.scope);
    if (ownerId !== null && !provider.descriptor.supportsPersonal) {
      throw new Error(`${provider.descriptor.title} does not support personal connections`);
    }
    const name = normalizedName(draft.name);
    const normalized = this.normalizeConfig(provider.descriptor, draft.config, null, id, true);
    this.validateProviderConfig(provider, id, normalized.plain, normalized.secretWrites);
    const now = Date.now();
    this.store.insert({
      id,
      providerId: provider.descriptor.id,
      name,
      scope: draft.scope,
      ownerId,
      enabled: draft.enabled,
      config: normalized.plain,
      createdAt: now,
    });
    try {
      this.writeSecrets(id, normalized.secretWrites);
    } catch (error) {
      // Preserve the original credential-store failure. Compensation is
      // best-effort because a second backend failure is less actionable and
      // must not replace the cause the operator can fix.
      try {
        this.store.delete(id);
      } catch {}
      try {
        this.deleteSecrets(id);
      } catch {}
      throw error;
    }
    this.changed();
    return this.getConnection(id)!;
  }

  updateConnection(id: string, patch: ConnectionPatch): IntegrationConnectionRecord {
    const current = this.getConnection(id);
    if (!current) throw new Error('integration connection not found');
    const provider = this.requireProvider(current.providerId);
    const scope = patch.scope ?? current.scope;
    this.assertScope(provider.descriptor, scope);
    const normalized = patch.config
      ? this.normalizeConfig(provider.descriptor, patch.config, current.config, id, false)
      : null;
    if (normalized) this.validateProviderConfig(provider, id, normalized.plain, normalized.secretWrites);
    const rollbackSecrets = normalized ? this.writeSecrets(id, normalized.secretWrites) : null;
    try {
      this.store.update(id, {
        ...(patch.name === undefined ? {} : { name: normalizedName(patch.name) }),
        ...(patch.scope === undefined ? {} : { scope }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(normalized ? { config: normalized.plain } : {}),
      });
    } catch (error) {
      try {
        rollbackSecrets?.();
      } catch {
        // Keep the database failure as the visible cause. A subsequent edit or
        // removal can reconcile an unavailable external secret store.
      }
      throw error;
    }
    this.changed();
    return this.getConnection(id)!;
  }

  removeConnection(id: string): void {
    // Credentials go first. If SQLite then fails, the visible connection is
    // recoverable by editing it; deleting metadata first could strand an
    // unreachable secret forever in an external secret store.
    this.deleteSecrets(id);
    const routesChanged = this.store.deleteRoutesUsingConnection(id);
    const deleted = this.store.delete(id);
    if (!deleted && !routesChanged) return;
    this.changed();
  }

  /** A deleted account must not leave orphaned personal connections or secrets. */
  removeConnectionsOwnedBy(ownerId: string): number {
    const owned = this.allConnections().filter((connection) => connection.ownerId === ownerId);
    for (const connection of owned) {
      this.deleteSecrets(connection.id);
      this.store.deleteRoutesUsingConnection(connection.id);
      this.store.delete(connection.id);
    }
    if (owned.length > 0) this.changed();
    return owned.length;
  }

  async testConnection(id: string): Promise<IntegrationConnectionRecord> {
    const connection = this.getConnection(id);
    if (!connection) throw new Error('integration connection not found');
    const provider = this.requireProvider(connection.providerId);
    this.store.setHealth(id, 'checking', 'Checking connection…', null);
    this.changed();
    let health: IntegrationHealth;
    const access = this.access(connection);
    const secretValues = this.secretValues(access);
    try {
      health = provider.probe
        ? integrationHealthSchema.parse(
            await withSignal(
              provider.probe(access, await this.probeContext(provider)),
              AbortSignal.timeout(PROBE_TIMEOUT_MS),
              'Integration health check timed out',
            ),
          )
        : { status: 'unknown', message: 'This provider has no non-destructive health check', checkedAt: Date.now() };
    } catch (error) {
      health = {
        status: 'unavailable',
        message: redactText(messageOf(error), secretValues),
        checkedAt: Date.now(),
      };
    }
    this.store.setHealth(
      id,
      health.status,
      redactText(health.message, secretValues),
      health.checkedAt ?? Date.now(),
    );
    this.changed();
    return this.getConnection(id)!;
  }

  setRoute(
    capability: IntegrationCapability,
    scope: IntegrationScope,
    targets: readonly IntegrationTargetRef[],
  ): IntegrationRouteRecord {
    assertCapability(capability);
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.providerId}:${target.connectionId ?? ''}`;
      if (seen.has(key)) throw new Error(`duplicate integration route target '${key}'`);
      seen.add(key);
      const provider = this.requireProvider(target.providerId);
      if (!provider.descriptor.capabilities.includes(capability)) {
        throw new Error(`${provider.descriptor.title} does not provide ${capability}`);
      }
      if (target.connectionId === null) {
        if (provider.descriptor.connectionMode === 'required') {
          throw new Error(`${provider.descriptor.title} requires a connection`);
        }
        continue;
      }
      const connection = this.getConnection(target.connectionId);
      if (!connection || connection.providerId !== target.providerId) {
        throw new Error(`connection '${target.connectionId}' does not belong to ${target.providerId}`);
      }
      if (connection.ownerId !== null) throw new Error('personal connections cannot be shared in routing policy');
      if (!scopeContainsConnection(scope, connection.scope)) {
        throw new Error(`connection '${connection.name}' is outside this route's scope`);
      }
    }
    if (targets.length === 0) {
      this.store.deleteRoute(capability, scope);
      this.changed();
      return { capability, scope, targets: [], updatedAt: Date.now() };
    }
    this.store.upsertRoute(capability, scope, targets);
    this.changed();
    return this.store.route(capability, scope)!;
  }

  effectiveRoute(capability: IntegrationCapability, scope: IntegrationScope): EffectiveIntegrationRoute {
    assertCapability(capability);
    for (const candidate of scopeHierarchy(scope)) {
      const route = this.store.route(capability, candidate);
      if (route) {
        return {
          capability,
          requestedScope: scope,
          sourceScope: candidate,
          targets: route.targets,
        };
      }
    }
    const targets = [...this.providersById.values()]
      .filter((provider) => provider.descriptor.defaultFor?.includes(capability))
      .map((provider): IntegrationTargetRef => ({ providerId: provider.descriptor.id, connectionId: null }));
    return { capability, requestedScope: scope, sourceScope: null, targets };
  }

  resolveTargets(
    capability: IntegrationCapability,
    scope: IntegrationScope,
    requested?: IntegrationTargetRef,
    viewer: string | null = null,
  ): ResolvedIntegrationTarget[] {
    const refs = requested ? [requested] : this.effectiveRoute(capability, scope).targets;
    const resolved: ResolvedIntegrationTarget[] = [];
    let unavailable: IntegrationUnavailableError | null = null;
    for (const ref of refs) {
      try {
        resolved.push(this.resolveTarget(capability, ref, scope, viewer));
      } catch (error) {
        if (!(error instanceof IntegrationUnavailableError) || requested) throw error;
        unavailable = error;
      }
    }
    if (resolved.length === 0 && unavailable) throw unavailable;
    return resolved;
  }

  private resolveTarget(
    capability: IntegrationCapability,
    ref: IntegrationTargetRef,
    scope: IntegrationScope,
    viewer: string | null,
  ): ResolvedIntegrationTarget {
    const provider = this.providersById.get(ref.providerId);
    if (!provider) throw new IntegrationUnavailableError(`provider '${ref.providerId}' is disabled or unavailable`);
    if (!provider.descriptor.capabilities.includes(capability)) {
      throw new IntegrationUnavailableError(`${provider.descriptor.title} does not provide ${capability}`);
    }
    if (ref.connectionId === null) {
      if (provider.descriptor.connectionMode === 'required') {
        throw new IntegrationUnavailableError(`${provider.descriptor.title} needs a connection`);
      }
      return { ref, provider, connection: null };
    }
    const connection = this.getConnection(ref.connectionId);
    if (!connection || connection.providerId !== ref.providerId) {
      throw new IntegrationUnavailableError(`connection '${ref.connectionId}' is unavailable`);
    }
    if (connection.ownerId !== null && connection.ownerId !== viewer) {
      throw new IntegrationUnavailableError(`connection '${ref.connectionId}' is unavailable`);
    }
    if (!scopeContainsConnection(scope, connection.scope)) {
      throw new IntegrationUnavailableError(`${connection.name} is outside this operation's scope`);
    }
    if (!connection.enabled) throw new IntegrationUnavailableError(`${connection.name} is disabled`);
    return { ref, provider, connection: this.access(connection) };
  }

  async executeReview(
    target: ResolvedIntegrationTarget,
    request: IntegrationReviewRequest,
  ): Promise<IntegrationReviewResult> {
    if (!target.provider.review) {
      throw new IntegrationUnavailableError(`${target.provider.descriptor.title} cannot execute code reviews`);
    }
    const secretValues = this.secretValues(target.connection);
    try {
      if (request.signal.aborted) throw new Error('Integration review was cancelled');
      const result = integrationReviewResultSchema.parse(
        await withSignal(
          target.provider.review(target.connection, request),
          request.signal,
          'Integration review was cancelled',
        ),
      ) as IntegrationReviewResult;
      return redactReviewResult(result, secretValues);
    } catch (error) {
      throw redactProviderError(error, secretValues);
    }
  }

  matchingConnections(
    capability: IntegrationCapability,
    scope: IntegrationScope,
    ownerId: string | null,
  ): ResolvedIntegrationTarget[] {
    return this.allConnections()
      .filter(
        (connection) =>
          connection.enabled &&
          connection.ownerId === ownerId &&
          scopeContainsConnection(scope, connection.scope) &&
          this.providersById.get(connection.providerId)?.descriptor.capabilities.includes(capability),
      )
      .map((connection) =>
        this.resolveTarget(
          capability,
          { providerId: connection.providerId, connectionId: connection.id },
          scope,
          ownerId,
        ),
      );
  }

  async deliverNotification(
    target: ResolvedIntegrationTarget,
    notification: IntegrationNotificationInput,
  ) {
    if (!target.connection) throw new IntegrationUnavailableError('notification providers require a connection');
    if (!target.provider.notify) {
      throw new IntegrationUnavailableError(`${target.provider.descriptor.title} cannot deliver notifications`);
    }
    const secretValues = this.secretValues(target.connection);
    try {
      const result = integrationDeliveryResultSchema.parse(
        await withSignal(
          target.provider.notify(target.connection, notification),
          AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          'Integration delivery timed out',
        ),
      );
      return {
        ...result,
        error: result.error ? redactText(result.error, secretValues) : null,
      };
    } catch (error) {
      throw redactProviderError(error, secretValues);
    }
  }

  /**
   * The machine a health check runs on: the most preferred one that has the
   * provider's executable, bound to a scratch dir there.
   *
   * A provider that declares no executable, or one no reachable machine has,
   * gets no runner at all, and answers with what that means, which is the
   * whole reason the field is optional.
   */
  private async probeContext(provider: IntegrationProviderAdapter): Promise<IntegrationProbeContext> {
    if (!provider.descriptor.requires?.length) return {};
    const [executor] = await this.executorsFor(provider.descriptor.id).catch(() => []);
    if (!executor) return {};
    try {
      return { exec: executor.at(await executor.scratch(`integration-probe-${provider.descriptor.moduleId}`)) };
    } catch {
      // A machine that cannot even hand out a scratch dir is not one to probe
      // on; the health check reports absence rather than that machine's error.
      return {};
    }
  }

  private access(connection: IntegrationConnectionRecord): IntegrationConnectionAccess {
    return {
      record: connection,
      secret: (key) => this.secrets.get(this.secretKey(connection.id, key)),
    };
  }

  private allConnections(): IntegrationConnectionRecord[] {
    const fieldsByConnection = new Map<string, string[]>();
    for (const key of this.secrets.keys()) {
      if (!key.startsWith(CONNECTION_SECRET_PREFIX)) continue;
      const suffix = key.slice(CONNECTION_SECRET_PREFIX.length);
      const separator = suffix.indexOf(':');
      if (separator <= 0) continue;
      const id = suffix.slice(0, separator);
      const field = suffix.slice(separator + 1);
      if (!field) continue;
      const fields = fieldsByConnection.get(id) ?? [];
      fields.push(field);
      fieldsByConnection.set(id, fields);
    }
    return this.store.list((id) => fieldsByConnection.get(id) ?? []);
  }

  private requireProvider(id: string): IntegrationProviderAdapter {
    const provider = this.providersById.get(id);
    if (!provider) throw new Error(`integration provider '${id}' is disabled or unavailable`);
    return provider;
  }

  private assertScope(provider: IntegrationProviderDescriptor, scope: IntegrationScope): void {
    if (!provider.scopes.includes(scope.kind)) {
      throw new Error(`${provider.title} cannot be configured at ${scope.kind} scope`);
    }
    if (scope.kind !== 'instance' && !scope.workspaceId.trim()) throw new Error('workspace scope needs a workspace id');
    if (scope.kind === 'repository' && !/^[\w.-]+\/[\w.-]+$/.test(scope.repo)) {
      throw new Error('repository scope needs an owner/name repository');
    }
  }

  private normalizeConfig(
    provider: IntegrationProviderDescriptor,
    input: ConfigInput,
    existing: Readonly<Record<string, IntegrationFieldValue>> | null,
    connectionId: string,
    creating: boolean,
  ): {
    readonly plain: Readonly<Record<string, IntegrationFieldValue>>;
    readonly secretWrites: ReadonlyMap<string, string | null>;
  } {
    const fields = new Map(provider.fields.map((field) => [field.key, field]));
    for (const key of Object.keys(input)) {
      if (!fields.has(key)) throw new Error(`unknown ${provider.title} config field '${key}'`);
    }
    const plain: Record<string, IntegrationFieldValue> = { ...(existing ?? {}) };
    const secretWrites = new Map<string, string | null>();
    for (const field of provider.fields) {
      const supplied = Object.prototype.hasOwnProperty.call(input, field.key);
      const raw = input[field.key];
      if (field.kind === 'secret') {
        if (supplied) {
          if (raw === null) secretWrites.set(field.key, null);
          else {
            if (raw === undefined) throw new Error(`${field.label} is required`);
            const value = validateField(field, raw);
            if (typeof value !== 'string') throw new Error(`${field.label} must be text`);
            secretWrites.set(field.key, value);
          }
        }
        const willExist = secretWrites.get(field.key) !== null &&
          (secretWrites.has(field.key) || this.secrets.get(this.secretKey(connectionId, field.key)) !== null);
        if (field.required && !willExist) throw new Error(`${field.label} is required`);
        continue;
      }
      if (supplied) {
        if (raw === null) delete plain[field.key];
        else {
          if (raw === undefined) throw new Error(`${field.label} is required`);
          plain[field.key] = validateField(field, raw);
        }
      } else if (creating && field.default !== undefined) {
        plain[field.key] = field.default;
      }
      if (field.required && (plain[field.key] === undefined || plain[field.key] === '')) {
        throw new Error(`${field.label} is required`);
      }
    }
    return { plain, secretWrites };
  }

  /** Apply a secret patch atomically from the caller's perspective and return
   * a rollback for the subsequent database write. Enterprise secret stores are
   * outside SQLite's transaction, so both failure directions need compensation. */
  private writeSecrets(id: string, writes: ReadonlyMap<string, string | null>): () => void {
    const previous = new Map<string, string | null>();
    for (const field of writes.keys()) previous.set(field, this.secrets.get(this.secretKey(id, field)));
    const restore = (): void => {
      for (const [field, value] of previous) {
        const key = this.secretKey(id, field);
        if (value === null) this.secrets.delete(key);
        else this.secrets.set(key, value);
      }
    };
    try {
      for (const [field, value] of writes) {
        const key = this.secretKey(id, field);
        if (value === null) this.secrets.delete(key);
        else this.secrets.set(key, value);
      }
    } catch (error) {
      try {
        restore();
      } catch {
        // Preserve the original secret-store error; operators need the cause
        // that made this update fail, while a later retry can reconcile state.
      }
      throw error;
    }
    return restore;
  }

  private validateProviderConfig(
    provider: IntegrationProviderAdapter,
    id: string,
    plain: Readonly<Record<string, IntegrationFieldValue>>,
    writes: ReadonlyMap<string, string | null>,
  ): void {
    const secret = (field: string): string | null => {
      if (writes.has(field)) return writes.get(field) ?? null;
      return this.secrets.get(this.secretKey(id, field));
    };
    try {
      provider.validateConfig?.(plain, secret);
    } catch (error) {
      const values = provider.descriptor.fields
        .filter((field) => field.kind === 'secret')
        .map((field) => secret(field.key))
        .filter((value): value is string => !!value);
      throw new Error(redactText(messageOf(error), values));
    }
  }

  private secretValues(connection: IntegrationConnectionAccess | null): string[] {
    if (!connection) return [];
    return connection.record.configuredSecrets
      .map((field) => connection.secret(field))
      .filter((value): value is string => !!value)
      .sort((a, b) => b.length - a.length);
  }

  private secretKey(id: string, field: string): string {
    return `${CONNECTION_SECRET_PREFIX}${id}:${field}`;
  }

  private secretKeys(id: string): string[] {
    const prefix = `${CONNECTION_SECRET_PREFIX}${id}:`;
    return this.secrets
      .keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  private deleteSecrets(id: string): void {
    for (const field of this.secretKeys(id)) this.secrets.delete(this.secretKey(id, field));
  }

  private changed(): void {
    this.broadcast({ t: 'integrations.changed' });
  }
}

function normalizedName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 80) throw new Error('connection name must be between 1 and 80 characters');
  return value;
}

function validateField(field: IntegrationConfigField, value: IntegrationFieldValue): IntegrationFieldValue {
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${field.label} must be on or off`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`${field.label} must be text`);
  const text = value.trim();
  if (text.length > 4_000) throw new Error(`${field.label} is too long`);
  if (field.required && !text) throw new Error(`${field.label} is required`);
  if (field.kind === 'url' && text) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw new Error(`${field.label} must be a valid URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`${field.label} must use http or https`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`${field.label} must not embed credentials`);
    }
  }
  if (field.kind === 'select' && !field.options?.some((option) => option.value === text)) {
    throw new Error(`${field.label} has an unsupported value`);
  }
  if (field.kind === 'multiselect' && text) {
    const allowed = new Set(field.options?.map((option) => option.value));
    if (text.split(',').some((entry) => !allowed.has(entry.trim()))) {
      throw new Error(`${field.label} has an unsupported value`);
    }
  }
  return text;
}

function assertProvider(adapter: IntegrationProviderAdapter): void {
  const provider = adapter.descriptor;
  if (provider.id.length > 120 || !PROVIDER_ID.test(provider.id)) {
    throw new Error(`invalid integration provider id '${provider.id.slice(0, 120)}'`);
  }
  if (provider.moduleId.length > 80 || !MODULE_ID.test(provider.moduleId)) {
    throw new Error(`invalid integration module id '${provider.moduleId.slice(0, 80)}'`);
  }
  if (
    !boundedText(provider.vendor, 80) ||
    !boundedText(provider.title, 120) ||
    !boundedText(provider.description, 1_000)
  ) {
    throw new Error(`integration provider '${provider.id}' needs vendor, title and description`);
  }
  if (!boundedText(provider.category, 120) || !CAPABILITY_ID.test(provider.category)) {
    throw new Error(`integration provider '${provider.id}' has an invalid category`);
  }
  if (provider.capabilities.length === 0 || provider.capabilities.length > 16) {
    throw new Error(`integration provider '${provider.id}' needs between 1 and 16 capabilities`);
  }
  for (const capability of provider.capabilities) assertCapability(capability);
  if (new Set(provider.capabilities).size !== provider.capabilities.length) {
    throw new Error(`integration provider '${provider.id}' repeats a capability`);
  }
  const validScopes = new Set(['instance', 'workspace', 'repository']);
  if (
    provider.scopes.length === 0 ||
    provider.scopes.length > 3 ||
    new Set(provider.scopes).size !== provider.scopes.length ||
    provider.scopes.some((scope) => !validScopes.has(scope))
  ) {
    throw new Error(`integration provider '${provider.id}' has invalid or duplicate scopes`);
  }
  if (!['required', 'optional', 'none'].includes(provider.connectionMode)) {
    throw new Error(`integration provider '${provider.id}' has an invalid connection mode`);
  }
  if (!['local', 'remote', 'delegated'].includes(provider.execution)) {
    throw new Error(`integration provider '${provider.id}' has an invalid execution mode`);
  }
  const requires = provider.requires ?? [];
  if (requires.length > 8 || requires.some((binary) => !boundedText(binary, 120) || /[\\/\s]/.test(binary))) {
    throw new Error(`integration provider '${provider.id}' declares invalid required executables`);
  }
  if (requires.length > 0 && provider.execution !== 'local') {
    throw new Error(`only a local-execution provider can require an executable ('${provider.id}')`);
  }
  if (provider.connectionMode === 'none' && provider.fields.length > 0) {
    throw new Error(`connectionless provider '${provider.id}' cannot declare connection fields`);
  }
  if (provider.connectionMode === 'none' && provider.supportsPersonal) {
    throw new Error(`connectionless provider '${provider.id}' cannot be personal`);
  }
  if (provider.fields.length > 32) throw new Error(`integration provider '${provider.id}' declares too many fields`);
  if (provider.setup !== undefined && !boundedText(provider.setup, 2_000)) {
    throw new Error(`integration provider '${provider.id}' has invalid setup text`);
  }
  if (provider.docsUrl !== undefined && (provider.docsUrl.length > 2_000 || !safeExternalUrl(provider.docsUrl))) {
    throw new Error(`integration provider '${provider.id}' has an invalid documentation URL`);
  }
  const defaults = provider.defaultFor ?? [];
  if (
    defaults.length > provider.capabilities.length ||
    new Set(defaults).size !== defaults.length ||
    defaults.some((capability) => !provider.capabilities.includes(capability))
  ) {
    throw new Error(`integration provider '${provider.id}' has invalid default capabilities`);
  }
  const fieldKeys = new Set<string>();
  for (const field of provider.fields) {
    if (!FIELD_KINDS.has(field.kind)) {
      throw new Error(`field '${field.key}' on integration provider '${provider.id}' has an invalid kind`);
    }
    if (!FIELD_KEY.test(field.key) || fieldKeys.has(field.key)) {
      throw new Error(`invalid or duplicate field '${field.key}' on integration provider '${provider.id}'`);
    }
    fieldKeys.add(field.key);
    if (!boundedText(field.label, 120)) {
      throw new Error(`field '${field.key}' on integration provider '${provider.id}' needs a bounded label`);
    }
    if (field.description !== undefined && !boundedText(field.description, 1_000)) {
      throw new Error(`field '${field.key}' on integration provider '${provider.id}' has invalid help text`);
    }
    if (field.placeholder !== undefined && field.placeholder.length > 300) {
      throw new Error(`field '${field.key}' on integration provider '${provider.id}' has an invalid placeholder`);
    }
    if (field.kind === 'secret' && field.default !== undefined) {
      throw new Error(`secret field '${field.key}' cannot have a default`);
    }
    if (field.kind === 'select' || field.kind === 'multiselect') {
      if (!field.options || field.options.length === 0 || field.options.length > 100) {
        throw new Error(`${field.kind} field '${field.key}' must declare between 1 and 100 options`);
      }
      const optionValues = new Set<string>();
      for (const option of field.options) {
        if (
          !boundedText(option.value, 200) ||
          !boundedText(option.label, 200) ||
          optionValues.has(option.value)
        ) {
          throw new Error(`${field.kind} field '${field.key}' has an invalid or duplicate option`);
        }
        optionValues.add(option.value);
      }
    } else if (field.options !== undefined) {
      throw new Error(`field '${field.key}' cannot declare options`);
    }
    if (field.default !== undefined) validateField(field, field.default);
  }
  if (provider.capabilities.includes('code-review') && !adapter.review) {
    throw new Error(`code-review provider '${provider.id}' has no review adapter`);
  }
  if (provider.capabilities.includes('notifications') && !adapter.notify) {
    throw new Error(`notification provider '${provider.id}' has no delivery adapter`);
  }
}

function assertCapability(capability: string): void {
  if (capability.length > 120 || !CAPABILITY_ID.test(capability)) {
    throw new Error(`invalid integration capability '${capability.slice(0, 120)}'`);
  }
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function scopeHierarchy(scope: IntegrationScope): IntegrationScope[] {
  switch (scope.kind) {
    case 'instance':
      return [scope];
    case 'workspace':
      return [scope, { kind: 'instance' }];
    case 'repository':
      return [scope, { kind: 'workspace', workspaceId: scope.workspaceId }, { kind: 'instance' }];
  }
}

/** Can a connection with `connectionScope` be consumed inside `useScope`? */
function scopeContainsConnection(useScope: IntegrationScope, connectionScope: IntegrationScope): boolean {
  if (connectionScope.kind === 'instance') return true;
  if (useScope.kind === 'instance') return false;
  if (connectionScope.workspaceId !== useScope.workspaceId) return false;
  if (connectionScope.kind === 'workspace') return true;
  return useScope.kind === 'repository' && connectionScope.repo === useScope.repo;
}

function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 1_000);
}

function safeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function redactReviewResult(
  result: IntegrationReviewResult,
  secrets: readonly string[],
): IntegrationReviewResult {
  if (secrets.length === 0) return result;
  if (result.kind === 'delegated') {
    return {
      ...result,
      summary: redactText(result.summary, secrets),
      externalUrl: result.externalUrl && secrets.some((secret) => secret && result.externalUrl!.includes(secret))
        ? null
        : result.externalUrl,
    };
  }
  if (result.kind === 'skipped') return { ...result, summary: redactText(result.summary, secrets) };
  return {
    ...result,
    summary: redactText(result.summary, secrets),
    reviewBody: redactText(result.reviewBody, secrets),
    findings: result.findings.map((finding) => ({
      ...finding,
      title: redactText(finding.title, secrets),
      file: finding.file ? redactText(finding.file, secrets) : null,
      reason: redactText(finding.reason, secrets),
      impact: redactText(finding.impact, secrets),
      suggestion: redactText(finding.suggestion, secrets),
    })),
  };
}

function redactProviderError(error: unknown, secrets: readonly string[]): Error {
  const message = redactText(messageOf(error), secrets);
  return error instanceof IntegrationUnavailableError
    ? new IntegrationUnavailableError(message)
    : new Error(message);
}

async function withSignal<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) throw new Error(message);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error(message));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Public, provider-neutral integration ABI.
 *
 * These types deliberately live in the SDK rather than in an in-tree module
 * package. Out-of-tree modules may statically import only the SDK ABI, so this
 * is what makes a third-party provider buildable without copying Companion's
 * protocol or depending on a private workspace package.
 */

export type IntegrationCapability =
  | 'code-review'
  | 'notifications'
  | 'issue-tracking'
  | (string & {});

export type IntegrationCategory =
  | 'review'
  | 'communication'
  | 'project-management'
  | 'developer-tools'
  | (string & {});

export type IntegrationScope =
  | { readonly kind: 'instance' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'repository'; readonly workspaceId: string; readonly repo: string };

export type IntegrationFieldValue = string | boolean | number;

export interface IntegrationFieldOption {
  readonly value: string;
  readonly label: string;
}

/** Declarative connection form. Secret values are accepted on writes and
 * represented only by their key in `configuredSecrets` on reads. */
export interface IntegrationConfigField {
  readonly key: string;
  readonly label: string;
  /**
   * `multiselect` is a closed set the operator picks from, stored as the same
   * comma-separated string `text` would have held. Declaring the options rather
   * than describing them in a placeholder is the difference between a field
   * somebody fills in and one they have to remember the vocabulary for.
   */
  readonly kind: 'text' | 'url' | 'secret' | 'boolean' | 'select' | 'multiselect';
  readonly required?: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly options?: ReadonlyArray<IntegrationFieldOption>;
  readonly default?: IntegrationFieldValue;
}

export interface IntegrationProviderDescriptor {
  readonly id: string;
  readonly moduleId: string;
  /** Groups multiple protocols under one recognisable vendor in the catalog. */
  readonly vendor: string;
  readonly title: string;
  readonly description: string;
  readonly category: IntegrationCategory;
  readonly capabilities: ReadonlyArray<IntegrationCapability>;
  readonly scopes: ReadonlyArray<IntegrationScope['kind']>;
  readonly connectionMode: 'required' | 'optional' | 'none';
  readonly execution: 'local' | 'remote' | 'delegated';
  /**
   * Executables a `local` provider needs, in preference order; the first one
   * installed is the one it runs.
   *
   * Declaring them is what lets the work follow the tool. Companion asks every
   * machine it can reach whether it has one, so a CLI signed in on a
   * developer's laptop can serve a Companion that runs somewhere else entirely;
   * a provider that declares nothing can only ever run where the daemon does.
   */
  readonly requires?: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<IntegrationConfigField>;
  readonly docsUrl?: string;
  readonly setup?: string;
  /** Used only when no explicit route exists for a select-one capability. */
  readonly defaultFor?: ReadonlyArray<IntegrationCapability>;
  /** Personal connections receive only events addressed to their owner. */
  readonly supportsPersonal?: boolean;
}

export type IntegrationHealthStatus = 'unknown' | 'checking' | 'ready' | 'degraded' | 'unavailable';

export interface IntegrationHealth {
  readonly status: IntegrationHealthStatus;
  readonly message: string;
  readonly checkedAt: number | null;
}

export interface IntegrationConnectionRecord {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly scope: IntegrationScope;
  /** null is shared; otherwise this connection belongs only to this profile. */
  readonly ownerId: string | null;
  readonly enabled: boolean;
  /** Non-secret values only. */
  readonly config: Readonly<Record<string, IntegrationFieldValue>>;
  /** Secret field keys with a stored value; never the values. */
  readonly configuredSecrets: ReadonlyArray<string>;
  readonly health: IntegrationHealth;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IntegrationConnectionDraft {
  readonly providerId: string;
  readonly name: string;
  readonly scope: IntegrationScope;
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, IntegrationFieldValue>>;
}

/** A route target is either a connectionless built-in provider or one concrete
 * connection. Strings are not overloaded, so stale routes remain diagnosable. */
export type IntegrationTargetRef =
  | { readonly providerId: string; readonly connectionId: null }
  | { readonly providerId: string; readonly connectionId: string };

export interface IntegrationRouteRecord {
  readonly capability: IntegrationCapability;
  readonly scope: IntegrationScope;
  /** Ordered primary + fallbacks. An empty write clears this scope's override
   * and restores inherited/default routing; empty rows are never persisted. */
  readonly targets: ReadonlyArray<IntegrationTargetRef>;
  readonly updatedAt: number;
}

export interface IntegrationCatalog {
  readonly providers: ReadonlyArray<IntegrationProviderDescriptor>;
  readonly connections: ReadonlyArray<IntegrationConnectionRecord>;
}

export interface EffectiveIntegrationRoute {
  readonly capability: IntegrationCapability;
  readonly requestedScope: IntegrationScope;
  /** Scope whose explicit route won, or null when provider defaults apply. */
  readonly sourceScope: IntegrationScope | null;
  readonly targets: ReadonlyArray<IntegrationTargetRef>;
}

/** The public review vocabulary intentionally depends on no code-domain type,
 * so a provider can be authored and bundled outside this repository. */
export interface IntegrationReviewRequest {
  /** Disposable PR worktree for local/managed adapters; delegated providers do not receive one. */
  readonly cwd: string | null;
  readonly repo: string;
  readonly prNumber: number;
  readonly baseRef: string;
  readonly headSha: string | null;
  readonly depth: 'high-level' | 'in-depth';
  readonly strictness: 'blockers-only' | 'balanced' | 'pedantic';
  readonly context?: string;
  readonly signal: AbortSignal;
  readonly progress: (message: string) => void;
  /** Delegated GitHub-app reviewers trigger through a normal PR comment. */
  readonly commentOnPullRequest: (body: string) => Promise<{ readonly url: string }>;
  /**
   * How to run this provider's own executable, on the machine that has it and
   * holds `cwd`. Absent for a delegated provider, which runs nothing anywhere.
   *
   * A provider must never spawn a process itself: `cwd` may be a path on
   * another machine entirely, and spawning here would run the tool where the
   * checkout is not and the credential is not.
   */
  readonly exec?: IntegrationCommandRunner;
}

/**
 * A machine that has a provider's executable, and can run it there.
 *
 * The seam exists because "where is this tool installed" is a question about
 * machines, which the integrations layer does not own. It is resolved late, so
 * a Companion built without a machine registry simply finds none and says so
 * rather than pretending a tool is missing when it is only elsewhere.
 */
export interface IntegrationExecutor {
  /** null is the daemon's own machine, as everywhere else machines are named. */
  readonly runnerId: string | null;
  readonly machine: string;
  /** Which declared executable this machine has. */
  readonly binary: string;
  readonly version: string | null;
  /** A throwaway working dir on that machine, for a command needing no checkout. */
  scratch(key: string): Promise<string>;
  /** Bind a command runner to a working directory on that same machine. */
  at(cwd: string): IntegrationCommandRunner;
}

export type IntegrationExecutorResolver = (
  providerId: string,
  options: { readonly repo?: string | null; readonly userId?: string | null },
) => Promise<ReadonlyArray<IntegrationExecutor>>;

/** What a health check is given beyond the connection: where it may run. */
export interface IntegrationProbeContext {
  /**
   * The machine the provider's executable was found on, already bound to a
   * scratch dir there. Absent when no reachable machine has it, which is the
   * answer a probe should report rather than a failure.
   */
  readonly exec?: IntegrationCommandRunner;
}

/** Where a review executes, and the one way it is allowed to get there. */
export interface IntegrationCommandRunner {
  /** The machine's name, for messages an operator has to act on. */
  readonly machine: string;
  run(
    args: ReadonlyArray<string>,
    options?: IntegrationCommandOptions,
  ): Promise<IntegrationCommandResult>;
}

export interface IntegrationCommandOptions {
  readonly timeoutMs?: number;
  /**
   * Cancels the command ON THE MACHINE, not just this promise. A review that
   * was called off must not leave a credential-bearing CLI running on somebody
   * else's laptop for another forty minutes.
   */
  readonly signal?: AbortSignal;
  /** Complete stdout lines as they arrive; a long tool reports progress here. */
  readonly onLine?: (line: string) => void;
  readonly maxStdout?: number;
  readonly maxStderr?: number;
  /**
   * Per-invocation environment, for a tool that takes its credential that way.
   * Refused when the machine is reachable only over plain http, because that is
   * a secret on a clear wire.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface IntegrationCommandResult {
  /** Which declared executable ran; null when none of them is installed. */
  readonly binary: string | null;
  /** null when the process died on a signal or never started. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Nothing the provider declared is on that machine: absence, not failure. */
  readonly missing: boolean;
}

export interface IntegrationReviewFinding {
  readonly severity: 'blocker' | 'major' | 'minor' | 'nit';
  readonly title: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly reason: string;
  readonly impact: string;
  readonly suggestion: string;
  readonly confidence: number;
}

export type IntegrationReviewResult =
  | {
      readonly kind: 'draft';
      readonly summary: string;
      readonly reviewBody: string;
      readonly findings: ReadonlyArray<IntegrationReviewFinding>;
      readonly coverage: 'complete' | 'partial';
    }
  | {
      readonly kind: 'delegated';
      readonly summary: string;
      readonly externalUrl: string | null;
    }
  | {
      readonly kind: 'skipped';
      readonly summary: string;
    };

export type IntegrationNotificationKind = 'action_required' | 'finished' | 'error' | 'info';

/**
 * The kinds a connection may filter on, shaped as a form declares them.
 *
 * One list rather than one per provider: the options an operator picks from and
 * the allow-list their choice is validated against have to be the same set, or
 * a kind exists in a menu that the validator then rejects.
 */
export const NOTIFICATION_KIND_OPTIONS: ReadonlyArray<IntegrationFieldOption> = [
  { value: 'action_required', label: 'Action required' },
  { value: 'finished', label: 'Finished' },
  { value: 'error', label: 'Error' },
  { value: 'info', label: 'Info' },
];

export interface IntegrationNotificationInput {
  readonly id: string;
  readonly kind: IntegrationNotificationKind;
  readonly title: string;
  readonly body: string;
  readonly workspaceId: string | null;
  readonly repo: string | null;
  readonly href: string | null;
  readonly url: string | null;
  readonly createdAt: number;
}

export interface IntegrationDeliveryResult {
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly attempts: number;
}

/** Full server-only access to one connection. Secret reads stay behind a
 * function so no adapter can accidentally serialize the credential bundle. */
export interface IntegrationConnectionAccess {
  readonly record: IntegrationConnectionRecord;
  readonly secret: (key: string) => string | null;
}

export interface IntegrationProviderAdapter {
  readonly descriptor: IntegrationProviderDescriptor;
  /** Synchronous, side-effect-free validation run before plain values or
   * secrets are persisted. Network checks belong in `probe`. */
  readonly validateConfig?: (
    config: Readonly<Record<string, IntegrationFieldValue>>,
    secret: (key: string) => string | null,
  ) => void;
  readonly probe?: (
    connection: IntegrationConnectionAccess,
    context?: IntegrationProbeContext,
  ) => Promise<IntegrationHealth>;
  readonly review?: (
    connection: IntegrationConnectionAccess | null,
    request: IntegrationReviewRequest,
  ) => Promise<IntegrationReviewResult>;
  readonly notify?: (
    connection: IntegrationConnectionAccess,
    notification: IntegrationNotificationInput,
  ) => Promise<IntegrationDeliveryResult>;
  /** Optional side-effect-free event filter. Returning false means no delivery
   * attempt and therefore no delivery-history row. */
  readonly acceptsNotification?: (
    connection: IntegrationConnectionAccess,
    notification: IntegrationNotificationInput,
  ) => boolean;
}

/** Narrow host service exposed to provider modules. External modules augment
 * their own `ServiceMap` with this interface, resolve it through `tryGet`, and
 * remain compatible with a Companion build where integrations are absent. */
export interface IntegrationProviderRegistry {
  registerProvider(adapter: IntegrationProviderAdapter): () => void;
}

/** Consumer side of the integration seam for a rich provider module. Resolving
 * one explicit target is how provider-owned routes obtain scoped credentials
 * without reading the integration tables or secret store directly. */
export interface IntegrationHost extends IntegrationProviderRegistry {
  resolveTargets(
    capability: IntegrationCapability,
    scope: IntegrationScope,
    requested?: IntegrationTargetRef,
    viewer?: string | null,
  ): ResolvedIntegrationTarget[];
}

export interface ResolvedIntegrationTarget {
  readonly ref: IntegrationTargetRef;
  readonly provider: IntegrationProviderAdapter;
  readonly connection: IntegrationConnectionAccess | null;
}

/** Only explicit unavailability is eligible for ordered-route fallback. */
export class IntegrationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationUnavailableError';
  }
}

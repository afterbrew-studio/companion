/**
 * What the runtime is told about the model it must call.
 *
 * The runtime knows no provider names and carries no defaults: everything it
 * needs arrives in a `ResolvedModelSpec` at spawn. A missing spec is a failed
 * turn, never a fallback to an environment variable that happened to be set,
 * because a container with a stray key would otherwise behave differently from
 * the one the operator configured.
 */

/**
 * Which AI SDK provider factory serves this record. Open-ended: a plugin under
 * `$COMPANION_HOME/providers` may register one this build has never heard of,
 * so closing the union would make an air-gapped install wait for a release.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'azure' | 'openai-compatible' | (string & {});

/** The four this build carries, in the order an operator should be offered them. */
export const BUILTIN_PROVIDER_KINDS: readonly ProviderKind[] = [
  'anthropic',
  'openai',
  'azure',
  'openai-compatible',
];

export interface ResolvedModelSpec {
  readonly providerId: string;
  readonly kind: ProviderKind;
  /** Null means the provider package's own default endpoint. */
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Query passthrough, for gateways that version or route that way. */
  readonly query: Readonly<Record<string, string>>;
  /** Provider-native model id, sent verbatim. On Azure this is a deployment. */
  readonly model: string;
  /**
   * The model's context window, as the operator declared it. Null turns
   * compaction off for this run: trimming against a guessed number would drop
   * work for a limit that may not exist.
   */
  readonly contextWindow: number | null;
  /** Azure versions its API this way; ignored by every other kind. */
  readonly apiVersion: string | null;
  readonly sampling: {
    readonly temperature?: number;
    readonly topP?: number;
    readonly maxOutputTokens?: number;
  };
  /** Verbatim to the SDK's providerOptions on the call. Opaque here on purpose. */
  readonly providerOptions: Readonly<Record<string, unknown>>;
  /**
   * Options for CONSTRUCTING the provider, which is a different moment from the
   * call and therefore a different bag. Azure's deployment-based URL switch is
   * the reason it exists: it decides how the endpoint is assembled, so it cannot
   * ride on a per-call field.
   */
  readonly factoryOptions: Readonly<Record<string, unknown>>;
}

/**
 * The ceilings a run executes under. They are configuration rather than
 * constants because an agent loop with no bound on steps or tool output is an
 * unbounded bill, and the right number differs between a triage one-shot and a
 * coding run.
 */
export interface RuntimeLimits {
  /** Model round trips in one turn before the loop stops. */
  readonly maxSteps: number;
  /** Wall clock for one turn. */
  readonly turnTimeoutMs: number;
  /** Characters of any single tool result handed back to the model. */
  readonly toolOutputChars: number;
  /** Wall clock for one `run` tool invocation. */
  readonly commandTimeoutMs: number;
  /** Heap ceiling for the child process, in MB. */
  readonly memoryMb: number;
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  maxSteps: 40,
  turnTimeoutMs: 30 * 60_000,
  toolOutputChars: 30_000,
  commandTimeoutMs: 10 * 60_000,
  memoryMb: 1_024,
};

/**
 * The hard execution boundary, mirroring `AgentRunAccess` on the runner
 * protocol. Declared here rather than imported so the package stays runnable
 * without the daemon's type package at run time.
 */
export type RuntimeAccess = 'read-only' | 'workspace-write' | 'trusted-assistant';

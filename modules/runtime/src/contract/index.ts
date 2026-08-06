// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages, bus events) are visible in this compilation.
import '@companion/module-core/contract';
import '@companion/module-operate/contract';
import type { ProviderKind, RuntimeAccess } from '@moxxy/companion-runtime';
import type { RuntimeService } from '../api/runtime-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'runtime:read': true;
    'runtime:manage': true;
  }
  interface ServerMessageRegistry {
    'runtime.changed': Record<never, never>;
  }
  interface ServiceMap {
    runtime: RuntimeService;
  }
}

export type { ProviderKind, RuntimeAccess };

/**
 * A model this instance may run, as the operator declared it.
 *
 * The price is here rather than in the one pricing table because nobody can
 * price an arbitrary endpoint: `model-pricing.ts` stays the default for ids it
 * knows, and a record's own number wins where it has one. A model with no price
 * anywhere contributes zero to the spend ceiling, which the budget card already
 * reports as partial rather than hiding.
 */
export interface ModelRecord {
  /** Provider-native id, sent verbatim. On Azure this is a deployment name. */
  readonly id: string;
  readonly label: string | null;
  /** Needed for compaction, so it is declared rather than guessed. */
  readonly contextWindow: number | null;
  readonly inputPerMTok: number | null;
  readonly outputPerMTok: number | null;
  /** What a probe actually observed, not what the operator hoped. */
  readonly probed: ModelProbe | null;
  /** Verbatim to the SDK's providerOptions on every call with this model. */
  readonly options: Readonly<Record<string, unknown>> | null;
}

export interface ModelProbe {
  readonly ok: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly at: number;
  readonly detail: string | null;
}

/**
 * A configured endpoint. The credential never crosses to a browser: `hasKey` is
 * the set/unset flag, the same redaction rule declared secret config follows.
 */
export interface ModelProviderRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Azure versions its API this way; ignored by every other kind. */
  readonly apiVersion: string | null;
  readonly factoryOptions: Readonly<Record<string, unknown>>;
  readonly hasKey: boolean;
  readonly models: readonly ModelRecord[];
  /** Instance-wide, or only the workspaces named here. Mirrors runners. */
  readonly workspaceIds: readonly string[] | null;
  readonly enabled: boolean;
  readonly createdAt: number;
}

export interface CreateProviderRequest {
  readonly label: string;
  readonly kind: ProviderKind;
  readonly baseUrl?: string | null;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly apiVersion?: string | null;
  readonly factoryOptions?: Readonly<Record<string, unknown>>;
  readonly workspaceIds?: readonly string[] | null;
  readonly models?: readonly ModelRecord[];
  readonly enabled?: boolean;
}

export interface ProbeResult {
  readonly model: string;
  readonly probe: ModelProbe;
}

/**
 * An MCP server this instance may attach to a run.
 *
 * Which runs get it is policy, and policy lives here rather than in the
 * runtime: `access` is the set of run accesses it serves and `workspaceIds`
 * scopes it the way a provider is scoped. The runtime is handed the servers a
 * given run resolved to and nothing about how that was decided.
 *
 * The credential is not in the record. One secret per server lives in the
 * kernel's secret store, and the operator writes `${secret}` wherever that
 * server wants it — an `authorization` header, an environment variable — so
 * nothing here has to model each server's idea of authentication.
 *
 * Which is also why the placeholder is the only correct way to carry one:
 * `env` and `headers` are ordinary record fields, readable by anyone with
 * `runtime:read`, exactly as a provider's headers are. A token pasted inline is
 * a token every maintainer can read.
 */
export interface McpServerRecord {
  readonly id: string;
  readonly label: string;
  readonly transport: 'stdio' | 'http';
  /** stdio: executed directly, never through a shell. */
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** http: the Streamable HTTP endpoint. */
  readonly url: string | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Which run accesses may reach this server. Empty means no run does. */
  readonly access: readonly RuntimeAccess[];
  /** Only these tools; null offers everything the server lists. */
  readonly tools: readonly string[] | null;
  /** Instance-wide, or only the workspaces named here. Mirrors providers. */
  readonly workspaceIds: readonly string[] | null;
  /** The set/unset flag for the stored secret; the value never reaches a browser. */
  readonly hasSecret: boolean;
  readonly enabled: boolean;
  readonly createdAt: number;
}

export interface CreateMcpServerRequest {
  readonly label: string;
  readonly transport: 'stdio' | 'http';
  readonly command?: string | null;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly secret?: string;
  readonly access?: readonly RuntimeAccess[];
  readonly tools?: readonly string[] | null;
  readonly workspaceIds?: readonly string[] | null;
  readonly enabled?: boolean;
}

/** What a connection attempt found, so an operator learns it here and not in a run. */
export interface McpCheckResult {
  readonly ok: boolean;
  readonly tools: readonly string[];
  readonly detail: string | null;
}

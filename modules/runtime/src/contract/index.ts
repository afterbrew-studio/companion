// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages, bus events) are visible in this compilation.
import '@companion/module-core/contract';
import '@companion/module-operate/contract';
import type { ProviderKind } from '@moxxy/companion-runtime';
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

export type { ProviderKind };

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

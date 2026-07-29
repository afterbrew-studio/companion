/**
 * What one agent turn looks like to Companion, independent of the runtime that
 * produced it: the events a session emits, the arguments a turn takes, the
 * prompts it can raise, and the history it leaves behind.
 *
 * These shapes were first read off moxxy's gateway, which is why they match it,
 * but nothing here names moxxy. `moxxy.ts` holds the part that is moxxy's alone.
 *
 * Every inbound event is untrusted. The declarations are permissive on purpose
 * and runtime-checked where it matters, so a harness that adds fields, or emits
 * types Companion has never heard of, must never crash it.
 */

// ---------- Events (the stream a session emits) -----------------------------

/** Known event discriminators. Unknown types must be tolerated (rendered as opaque). */
export type HarnessEventType =
  | 'user_prompt'
  | 'assistant_chunk'
  | 'assistant_message'
  | 'reasoning_chunk'
  | 'reasoning_message'
  | 'tool_call_requested'
  | 'tool_call_approved'
  | 'tool_call_denied'
  | 'tool_result'
  | 'skill_invoked'
  | 'skill_created'
  | 'plugin_registered'
  | 'plugin_unregistered'
  | 'mode_iteration'
  | 'compaction'
  | 'elision'
  | 'provider_request'
  | 'provider_response'
  | 'error'
  | 'abort'
  | 'plugin_event'
  | (string & {});

/**
 * The open tail above is load-bearing. A harness Companion has never heard of
 * must be able to put its own types on the transcript, and every consumer
 * tolerates one (`fold.ts` ends its switch with `default: break`). Closing the
 * list would turn each such event into a type error at the boundary that
 * receives it, so this stops compiling if the tail ever goes.
 */
type AcceptsAnyType<T extends HarnessEventType> = T;
type UnknownTypesStayAssignable = AcceptsAnyType<'a-type-companion-has-never-seen'>;

export interface HarnessEventBase {
  readonly id: string;
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly causationId?: string;
  readonly source: string;
  readonly type: HarnessEventType;
}

export interface UserPromptEvent extends HarnessEventBase {
  readonly type: 'user_prompt';
  readonly text: string;
  readonly attachments?: ReadonlyArray<{
    readonly kind: string;
    readonly content: string;
    readonly name?: string;
    readonly mediaType?: string;
  }>;
  readonly origin?: { readonly kind: 'webhook' | 'schedule' | 'workflow'; readonly name: string };
}

export interface AssistantChunkEvent extends HarnessEventBase {
  readonly type: 'assistant_chunk';
  readonly delta: string;
}

export interface AssistantMessageEvent extends HarnessEventBase {
  readonly type: 'assistant_message';
  readonly content: string;
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
}

export interface ReasoningChunkEvent extends HarnessEventBase {
  readonly type: 'reasoning_chunk';
  readonly delta: string;
}

export interface ReasoningMessageEvent extends HarnessEventBase {
  readonly type: 'reasoning_message';
  readonly content: string;
  readonly redacted?: boolean;
}

export interface ToolCallRequestedEvent extends HarnessEventBase {
  readonly type: 'tool_call_requested';
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolCallApprovedEvent extends HarnessEventBase {
  readonly type: 'tool_call_approved';
  readonly callId: string;
  readonly decidedBy: string;
  readonly mode: string;
}

export interface ToolCallDeniedEvent extends HarnessEventBase {
  readonly type: 'tool_call_denied';
  readonly callId: string;
  readonly decidedBy: string;
  readonly reason: string;
}

export interface ToolResultEvent extends HarnessEventBase {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: { readonly message: string; readonly kind: string };
}

export interface ProviderResponseEvent extends HarnessEventBase {
  readonly type: 'provider_response';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export interface ErrorEvent extends HarnessEventBase {
  readonly type: 'error';
  readonly message?: string;
  readonly kind?: string;
}

export interface AbortEvent extends HarnessEventBase {
  readonly type: 'abort';
}

export interface PluginEventEvent extends HarnessEventBase {
  readonly type: 'plugin_event';
  readonly pluginId?: string;
  readonly subtype?: string;
  readonly payload?: unknown;
}

/** Any event off the wire. Narrow via the `type` discriminator; tolerate unknowns. */
export type HarnessEvent =
  | UserPromptEvent
  | AssistantChunkEvent
  | AssistantMessageEvent
  | ReasoningChunkEvent
  | ReasoningMessageEvent
  | ToolCallRequestedEvent
  | ToolCallApprovedEvent
  | ToolCallDeniedEvent
  | ToolResultEvent
  | ProviderResponseEvent
  | ErrorEvent
  | AbortEvent
  | PluginEventEvent
  | (HarnessEventBase & { readonly [key: string]: unknown });

// ---------- Ask (permission / approval prompts) ------------------------------

export type PermissionMode = 'allow' | 'allow_session' | 'allow_always' | 'deny';

export interface AskRequest {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly kind: 'permission' | 'approval' | 'workflow';
  readonly tool?: { readonly name: string; readonly input: unknown; readonly description?: string };
  readonly approval?: {
    readonly title?: string;
    readonly body?: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly [key: string]: unknown;
  };
  readonly workflow?: {
    readonly runId: string;
    readonly workflow: string;
    readonly stepId: string;
    readonly label: string;
    readonly prompt: string;
  };
}

export interface AskResponse {
  readonly mode?: PermissionMode;
  readonly optionId?: string;
  readonly text?: string;
}

// ---------- Turns and history ------------------------------------------------

export interface PromptAttachment {
  readonly kind: 'image';
  /** Base64 bytes, without a data-URL prefix. */
  readonly content: string;
  readonly name?: string;
  readonly mediaType: string;
}

export interface RunTurnArgs {
  readonly prompt: string;
  readonly model?: string;
  readonly attachments?: readonly PromptAttachment[];
}

export interface RunTurnResult {
  readonly turnId: string;
}

export interface LoadHistoryArgs {
  readonly workspaceId?: string;
  readonly before?: number | null;
  readonly limit?: number;
}

export interface HistorySegment {
  readonly events: ReadonlyArray<HarnessEvent>;
  readonly prevCursor: number | null;
}

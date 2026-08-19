import type { HarnessEvent } from '@moxxy/companion-types';

/**
 * Claude Code's stream, read as Companion's transcript vocabulary.
 *
 * Every mapping here reads a NAMED FIELD. None of it inspects prose, and none
 * of it infers from position: a tool result is paired to its call by
 * `tool_use_id` because a result for call 1 genuinely arrives while call 2's
 * arguments are still streaming, and a failure is a failure because `is_error`
 * says so, not because the text reads like one.
 *
 * Six measured details this is built around, each one a way to be quietly wrong:
 *
 *  1. `is_error` is ABSENT on a successful tool result and `true` on a failed
 *     one. It is never `false`, so testing for the key marks every success as a
 *     failure.
 *  2. `system/init` repeats once per TURN under one session id. It refreshes
 *     what the session is, and never starts a turn: `beginTurn` does that,
 *     because only the caller knows which turn it just sent.
 *  3. `rate_limit_event` fires during a healthy turn carrying
 *     `rate_limit_info.status: "allowed"`. Only a non-allowed status is worth a
 *     notice; treating the frame itself as one puts a warning in every
 *     transcript.
 *  4. The stream is out of lockstep. `assistant` frames arrive one per content
 *     block, and results interleave with the next call's arguments.
 *  5. `stop_reason` arrives LATE, on `message_delta`, after the `assistant`
 *     frames it describes carry `stop_reason: null`. Assistant messages are
 *     therefore held until it lands (see `pendingMessages`) rather than being
 *     stamped with a guess.
 *  6. The prompt is never echoed on the stream. `beginTurn` synthesizes it from
 *     what Companion sent. A session file read back from disk DOES carry it,
 *     which is why a plain-text `user` frame starts a turn here.
 */

/** What `system/init` says the session is, refreshed every turn. */
export interface ClaudeSessionInfo {
  readonly sessionId: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly slashCommands: readonly string[];
  readonly cwd: string;
}

/** What the `result` frame says a turn cost. */
export interface ClaudeTurnSummary {
  readonly turnId: string;
  readonly ok: boolean;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ClaudeAdapterHandlers {
  onEvent(event: HarnessEvent): void;
  onTurnEnd?(summary: ClaudeTurnSummary): void;
  onSessionInfo?(info: ClaudeSessionInfo): void;
}

type Frame = Record<string, unknown>;

const MAX_HELD_MESSAGES = 64;

export class ClaudeAdapter {
  private seq = 0;
  private turnId = '';
  private autoTurns = 0;
  /** Timestamp of the frame currently being adapted. Session-file replay
   * keeps the original time; live frames fall back to receipt time. */
  private frameTs: number | null = null;
  /**
   * Assistant messages waiting for the `stop_reason` that arrives on
   * `message_delta`. Bounded: a stream that never sends one must not
   * accumulate, and a message flushed without ever learning why it stopped is
   * reported as an error rather than being stamped with a guess.
   */
  private pendingMessages: Array<{ content: string }> = [];

  constructor(
    private sessionId: string,
    private readonly handlers: ClaudeAdapterHandlers,
    /**
     * Where to continue numbering. A resumed session replays what is already on
     * disk before the new process speaks, and event ids restarting at zero
     * would make every new event a duplicate of a replayed one to any consumer
     * that dedupes on id.
     */
    seq = 0,
    turns = 0,
  ) {
    this.seq = seq;
    this.autoTurns = turns;
  }

  /**
   * Open a turn and put the prompt Companion sent on the transcript. Claude
   * Code never echoes it, so this is the only place it can come from.
   */
  beginTurn(turnId: string, prompt: string | null): void {
    this.flushMessages('end_turn');
    this.turnId = turnId;
    if (prompt !== null) this.emit('user_prompt', 'user', { text: prompt });
  }

  /** Close whatever is still held, e.g. when the process dies mid-message. */
  end(): void {
    this.flushMessages('error');
  }

  push(frame: unknown): void {
    if (!isFrame(frame)) return;
    const sessionId = frame.session_id ?? frame.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) this.sessionId = sessionId;

    this.frameTs = frameTimestamp(frame) ?? Date.now();
    try {
      switch (frame.type) {
        case 'system':
          if (frame.subtype === 'init') this.handlers.onSessionInfo?.(readSessionInfo(frame));
          return;

        case 'stream_event':
          this.streamEvent(asFrame(frame.event));
          return;

        case 'assistant':
          this.assistantBlocks(asFrame(frame.message));
          return;

        case 'user':
          this.userBlocks(asFrame(frame.message));
          return;

        case 'rate_limit_event': {
          // Informational unless the limiter says it actually withheld capacity.
          const status = String(asFrame(frame.rate_limit_info)?.status ?? '');
          if (status === 'allowed') return;
          this.emit('error', 'system', { kind: 'retryable', message: `rate limit ${status}` });
          return;
        }

        case 'result': {
          this.flushMessages(frame.is_error === true ? 'error' : 'end_turn');
          const usage = asFrame(frame.usage);
          if (frame.is_error === true) {
            this.emit('error', 'system', {
              kind: 'fatal',
              message: apiErrorStatus(frame) ?? String(frame.result ?? frame.subtype ?? 'run failed'),
            });
          }
          this.handlers.onTurnEnd?.({
            turnId: this.turnId,
            ok: frame.is_error !== true,
            costUsd: numberOr(frame.total_cost_usd, 0),
            inputTokens: numberOr(usage?.input_tokens, 0),
            outputTokens: numberOr(usage?.output_tokens, 0),
          });
          return;
        }

        default:
          return; // system/status, attachment, ai-title and anything newer
      }
    } finally {
      this.frameTs = null;
    }
  }

  // ---------- frame kinds ----------------------------------------------------

  private streamEvent(event: Frame | null): void {
    if (!event) return;
    if (event.type === 'content_block_delta') {
      const delta = asFrame(event.delta);
      if (delta?.type === 'text_delta') this.emit('assistant_chunk', 'model', { delta: String(delta.text ?? '') });
      else if (delta?.type === 'thinking_delta')
        this.emit('reasoning_chunk', 'model', { delta: String(delta.thinking ?? '') });
      return;
    }
    if (event.type === 'message_delta') {
      // The one frame that knows why the message stopped (detail 5).
      this.flushMessages(stopReason(asFrame(event.delta)?.stop_reason));
      const usage = asFrame(event.usage);
      this.emit('provider_response', 'system', {
        inputTokens: numberOr(usage?.input_tokens, 0),
        outputTokens: numberOr(usage?.output_tokens, 0),
        cacheReadTokens: numberOr(usage?.cache_read_input_tokens, 0),
        cacheCreationTokens: numberOr(usage?.cache_creation_input_tokens, 0),
      });
      return;
    }
    if (event.type === 'error') {
      const error = asFrame(event.error);
      this.emit('error', 'system', {
        kind: String(error?.type ?? 'stream_error'),
        message: String(error?.message ?? 'stream error'),
      });
    }
  }

  private assistantBlocks(message: Frame | null): void {
    for (const block of blocksOf(message)) {
      if (block.type === 'text') {
        // Held: this frame's own stop_reason is null (detail 5).
        this.pendingMessages.push({ content: String(block.text ?? '') });
        if (this.pendingMessages.length > MAX_HELD_MESSAGES) this.flushMessages('error');
      } else if (block.type === 'thinking') {
        this.emit('reasoning_message', 'model', { content: String(block.thinking ?? '') });
      } else if (block.type === 'tool_use') {
        // Never held: its result can arrive before this message completes, and
        // a result whose call has not been seen is dropped downstream.
        this.emit('tool_call_requested', 'model', {
          callId: String(block.id ?? ''),
          name: String(block.name ?? ''),
          input: block.input,
        });
      }
    }
  }

  /**
   * `user` frames carry tool results on the live stream. A session file read
   * back from disk also carries the prompts, so a plain-text one opens a turn
   * (detail 6): live that never happens, which is why nothing double-counts.
   */
  private userBlocks(message: Frame | null): void {
    const content = message?.content;
    if (typeof content === 'string') {
      this.beginTurn(this.nextAutoTurn(), content);
      return;
    }
    const blocks = blocksOf(message);
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
    if (text.length > 0) this.beginTurn(this.nextAutoTurn(), text);
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      // Absent means success; it is never `false` (detail 1).
      const ok = block.is_error !== true;
      this.emit('tool_result', 'tool', {
        callId: String(block.tool_use_id ?? ''),
        ok,
        output: ok ? block.content : undefined,
        error: ok ? undefined : { message: stringify(block.content), kind: 'tool_threw' },
      });
    }
  }

  // ---------- emitting -------------------------------------------------------

  private flushMessages(reason: string): void {
    if (this.pendingMessages.length === 0) return;
    const held = this.pendingMessages;
    this.pendingMessages = [];
    for (const message of held) {
      this.emit('assistant_message', 'model', { content: message.content, stopReason: reason });
    }
  }

  private nextAutoTurn(): string {
    return `${this.sessionId}:t${++this.autoTurns}`;
  }

  private emit(type: string, source: string, rest: Record<string, unknown>): void {
    const seq = this.seq++;
    this.handlers.onEvent({
      id: `cc-${this.sessionId}-${seq}`,
      seq,
      ts: this.frameTs ?? Date.now(),
      sessionId: this.sessionId,
      turnId: this.turnId,
      source,
      type,
      ...rest,
    } as HarnessEvent);
  }
}

/** Replay a whole capture (a session file, or a recorded stream) in one call. */
export function adaptFrames(sessionId: string, frames: Iterable<unknown>): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  const adapter = new ClaudeAdapter(sessionId, { onEvent: (e) => events.push(e) });
  for (const frame of frames) adapter.push(frame);
  adapter.end();
  return events;
}

function readSessionInfo(frame: Frame): ClaudeSessionInfo {
  return {
    sessionId: String(frame.session_id ?? ''),
    model: String(frame.model ?? ''),
    tools: stringList(frame.tools),
    permissionMode: String(frame.permissionMode ?? ''),
    slashCommands: stringList(frame.slash_commands),
    cwd: String(frame.cwd ?? ''),
  };
}

/** The reasons `AssistantMessageEvent` declares; anything else reads as an end. */
function stopReason(raw: unknown): string {
  switch (raw) {
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'end_turn':
      return raw;
    default:
      return 'end_turn';
  }
}

function apiErrorStatus(frame: Frame): string | null {
  const status = frame.api_error_status;
  return typeof status === 'number' || typeof status === 'string' ? `api error ${status}` : null;
}

function blocksOf(message: Frame | null): Frame[] {
  const content = message?.content;
  return Array.isArray(content) ? content.filter(isFrame) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function frameTimestamp(frame: Frame): number | null {
  const value = frame.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFrame(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFrame(value: unknown): Frame | null {
  return isFrame(value) ? value : null;
}

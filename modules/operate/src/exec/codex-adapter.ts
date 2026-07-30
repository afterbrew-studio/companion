import type { HarnessEvent } from '@moxxy/companion-types';

/**
 * Codex's stream, read as Companion's transcript vocabulary.
 *
 * Measured from `codex exec --json` on CLI 0.146.0, one turn that read two
 * files that existed and one that did not. Like the Claude Code adapter, every
 * mapping reads a NAMED FIELD: an item's result pairs with its start by `id`,
 * and a failure is a failure because `status`/`exit_code` say so.
 *
 * Four measured differences from Claude Code, each one a way an adapter written
 * for that harness would be quietly wrong here:
 *
 *  1. Failure is INVERTED and always present. A finished command carries
 *     `exit_code: 0` and `status: "completed"` on success, `1`/`"failed"` on
 *     failure. Claude Code omits `is_error` entirely when a call succeeded, so
 *     the presence test that is right there marks every success as failed here.
 *  2. There is no cost, only tokens. `turn.completed.usage` reports input,
 *     cached input, cache writes, output and reasoning tokens, and no dollar
 *     figure, so the spend ceiling prices them like any other token count.
 *  3. Nothing streams. Items arrive already `completed`, so there is no
 *     `assistant_chunk` equivalent and a Codex run does not type live. Not a
 *     gap to be filled later by guessing: the frames simply do not exist.
 *  4. A tool call is a shell command, not a named tool with structured input.
 *     The item TYPE is the closest thing to a tool name, so that is what is
 *     reported rather than inventing one from the command line.
 *
 * The prompt is never echoed on the stream, so `beginTurn` synthesizes it from
 * what Companion sent. Codex opens with an `agent_message` preamble before its
 * first command, which is an ordinary assistant message and needs no special
 * case.
 */

/** What `turn.completed` says a turn consumed. Tokens only; there is no cost. */
export interface CodexTurnSummary {
  readonly turnId: string;
  readonly ok: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CodexAdapterHandlers {
  onEvent(event: HarnessEvent): void;
  onTurnEnd?(summary: CodexTurnSummary): void;
  /** The id `codex exec resume` needs, learned from `thread.started`. */
  onThread?(threadId: string): void;
}

type Frame = Record<string, unknown>;

/**
 * Item types that are messages rather than calls. Everything else is reported
 * as a call, because an id that starts and completes IS a call in this
 * vocabulary, and mapping only the two kinds measured would leave every newer
 * item type off the transcript entirely.
 */
const MESSAGE_ITEMS = new Set(['agent_message', 'reasoning']);

/** Bound on the call ids remembered, so one session cannot grow without limit. */
const MAX_TRACKED_CALLS = 1_000;

export class CodexAdapter {
  private seq = 0;
  private turnId = '';
  /**
   * Items whose start has been reported. A `completed` for an id that was never
   * started emits its call first: a result whose call was never seen is dropped
   * downstream, and `agent_message` items genuinely arrive completed-only.
   */
  private readonly started = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly handlers: CodexAdapterHandlers,
    /**
     * Where to continue numbering. A resumed run replays what is on disk before
     * the new process speaks, and event ids restarting at zero would make every
     * new event a duplicate of a replayed one to any consumer that dedupes.
     */
    seq = 0,
  ) {
    this.seq = seq;
  }

  /**
   * Open a turn and put the prompt Companion sent on the transcript. Codex never
   * echoes it on the stream, so this is the only place it can come from.
   */
  beginTurn(turnId: string, prompt: string | null): void {
    this.turnId = turnId;
    this.started.clear();
    if (prompt !== null) this.emit('user_prompt', 'user', { text: prompt });
  }

  push(frame: unknown): void {
    if (!isFrame(frame)) return;
    switch (frame.type) {
      case 'thread.started': {
        const id = frame.thread_id;
        if (typeof id === 'string' && id.length > 0) this.handlers.onThread?.(id);
        return;
      }

      case 'item.started':
        this.item(asFrame(frame.item), false);
        return;

      case 'item.completed':
        this.item(asFrame(frame.item), true);
        return;

      case 'turn.completed': {
        const usage = asFrame(frame.usage);
        this.emit('provider_response', 'system', {
          inputTokens: numberOr(usage?.input_tokens, 0),
          outputTokens: numberOr(usage?.output_tokens, 0),
          cacheReadTokens: numberOr(usage?.cached_input_tokens, 0),
          cacheCreationTokens: numberOr(usage?.cache_write_input_tokens, 0),
        });
        this.handlers.onTurnEnd?.({
          turnId: this.turnId,
          ok: true,
          inputTokens: numberOr(usage?.input_tokens, 0),
          outputTokens: numberOr(usage?.output_tokens, 0),
        });
        return;
      }

      case 'turn.failed': {
        this.emit('error', 'system', { kind: 'fatal', message: errorMessage(frame) });
        this.handlers.onTurnEnd?.({ turnId: this.turnId, ok: false, inputTokens: 0, outputTokens: 0 });
        return;
      }

      case 'error':
        this.emit('error', 'system', { kind: 'stream_error', message: errorMessage(frame) });
        return;

      default:
        return; // turn.started, and anything a newer CLI adds
    }
  }

  // ---------- items ----------------------------------------------------------

  private item(item: Frame | null, completed: boolean): void {
    if (!item) return;
    const type = String(item.type ?? '');
    const id = String(item.id ?? '');

    if (MESSAGE_ITEMS.has(type)) {
      // Held to `completed` because a started message carries no text yet.
      if (!completed) return;
      const content = String(item.text ?? '');
      if (content.length === 0) return;
      if (type === 'reasoning') this.emit('reasoning_message', 'model', { content });
      else this.emit('assistant_message', 'model', { content, stopReason: 'end_turn' });
      return;
    }

    if (!this.started.has(id)) {
      this.started.add(id);
      if (this.started.size > MAX_TRACKED_CALLS) this.started.clear();
      this.emit('tool_call_requested', 'model', { callId: id, name: type, input: callInput(item) });
    }
    if (!completed) return;

    // Inverted and always present (detail 1): a finished item says how it went.
    const ok = item.status !== 'failed' && numberOr(item.exit_code, 0) === 0;
    const output = item.aggregated_output ?? item.output ?? undefined;
    this.emit('tool_result', 'tool', {
      callId: id,
      ok,
      output: ok ? output : undefined,
      error: ok ? undefined : { message: stringify(output), kind: 'tool_threw' },
    });
  }

  // ---------- emitting -------------------------------------------------------

  private emit(type: string, source: string, rest: Record<string, unknown>): void {
    const seq = this.seq++;
    this.handlers.onEvent({
      id: `cx-${this.sessionId}-${seq}`,
      seq,
      ts: Date.now(),
      sessionId: this.sessionId,
      turnId: this.turnId,
      source,
      type,
      ...rest,
    } as HarnessEvent);
  }
}

/**
 * A reaped run's transcript, read back from the rollout file Codex writes.
 *
 * A DIFFERENT shape from the stream above, which is the trap: the file records
 * `response_item` and `event_msg` payloads rather than thread/turn/item frames,
 * so it needs its own mapping instead of being pushed through `CodexAdapter`.
 * Messages are taken from `event_msg` only; the `response_item` copy of the
 * same text would double every line on the page.
 */
export function adaptRollout(sessionId: string, records: Iterable<unknown>): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  let seq = 0;
  let turnId = '';
  const emit = (type: string, source: string, rest: Record<string, unknown>): void => {
    events.push({
      id: `cx-${sessionId}-${seq}`,
      seq: seq++,
      ts: Date.now(),
      sessionId,
      turnId,
      source,
      type,
      ...rest,
    } as HarnessEvent);
  };

  for (const record of records) {
    if (!isFrame(record)) continue;
    const payload = asFrame(record.payload);
    if (!payload) continue;
    const kind = String(payload.type ?? '');

    if (record.type === 'event_msg') {
      if (kind === 'task_started') turnId = String(payload.turn_id ?? turnId);
      else if (kind === 'user_message') emit('user_prompt', 'user', { text: String(payload.message ?? '') });
      else if (kind === 'agent_message') {
        emit('assistant_message', 'model', { content: String(payload.message ?? ''), stopReason: 'end_turn' });
      } else if (kind === 'token_count') {
        const usage = asFrame(asFrame(payload.info)?.last_token_usage);
        if (usage) {
          emit('provider_response', 'system', {
            inputTokens: numberOr(usage.input_tokens, 0),
            outputTokens: numberOr(usage.output_tokens, 0),
            cacheReadTokens: numberOr(usage.cached_input_tokens, 0),
            cacheCreationTokens: numberOr(usage.cache_write_input_tokens, 0),
          });
        }
      }
      continue;
    }

    if (record.type !== 'response_item') continue;
    if (kind === 'custom_tool_call' || kind === 'function_call') {
      emit('tool_call_requested', 'model', {
        callId: String(payload.call_id ?? payload.id ?? ''),
        name: String(payload.name ?? kind),
        input: payload.input ?? payload.arguments,
      });
    } else if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
      emit('tool_result', 'tool', {
        callId: String(payload.call_id ?? ''),
        ok: true,
        output: payload.output,
      });
    } else if (kind === 'reasoning') {
      // `encrypted_content` is exactly that; only a summary is readable, and a
      // reasoning block with nothing to show is not worth a line.
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const content = summary
        .filter(isFrame)
        .map((part) => String(part.text ?? ''))
        .filter((text) => text.length > 0)
        .join('\n');
      if (content.length > 0) emit('reasoning_message', 'model', { content });
    }
  }
  return events;
}

/** What a call was asked to do, without repeating its identity in its own input. */
function callInput(item: Frame): Record<string, unknown> {
  const { id: _id, type: _type, status: _status, ...rest } = item;
  return rest;
}

function errorMessage(frame: Frame): string {
  const error = frame.error;
  if (typeof error === 'string') return error;
  const message = asFrame(error)?.message;
  return typeof message === 'string' ? message : 'codex turn failed';
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isFrame(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFrame(value: unknown): Frame | null {
  return isFrame(value) ? value : null;
}

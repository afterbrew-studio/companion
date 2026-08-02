import type { MoxxyEvent } from '@moxxy/companion-types';

/**
 * Fold raw MoxxyEvents into renderable blocks. Companion implements its own
 * folding (moxxy's chat-model package is internal); the rules mirror what
 * moxxy surfaces render:
 *  - assistant/reasoning chunks accumulate into a streaming block, finalized by
 *    the matching *_message event;
 *  - tool_call_requested opens a tool block keyed by callId; approved/denied/
 *    result events update it;
 *  - unknown event types are tolerated and skipped.
 */

export type Block =
  | { kind: 'user'; key: string; text: string; trigger?: string }
  | { kind: 'assistant'; key: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; key: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      key: string;
      callId: string;
      name: string;
      input: unknown;
      status: 'pending' | 'running' | 'denied' | 'ok' | 'error';
      detail?: string;
    }
  | {
      kind: 'notice';
      key: string;
      level: 'error' | 'warn' | 'info';
      /** Heading naming what failed; absent for plain info chips. */
      title?: string;
      text: string;
      /** Provider attempt the error belongs to, when moxxy reports one. */
      attempt?: number;
    };

export interface FoldState {
  blocks: Block[];
  seen: Set<string>;
  inputTokens: number;
  outputTokens: number;
}

export function emptyFold(): FoldState {
  return { blocks: [], seen: new Set(), inputTokens: 0, outputTokens: 0 };
}

/**
 * What each moxxy error kind is called on screen. Naming only: severity is
 * decided separately (fatal alone is a failure), so an unlisted kind gets the
 * neutral heading instead of being promoted to a dead run.
 */
const ERROR_TITLES: Record<string, string> = {
  fatal: 'Run error',
  retryable: 'Recoverable error',
  tool_threw: 'Tool error',
  hook_failed: 'Hook failed',
  provider_failed: 'Provider error',
};

/** Fold one event. Mutates and returns state (callers re-set React state with a new ref). */
export function foldEvent(state: FoldState, event: MoxxyEvent): FoldState {
  const id = typeof event.id === 'string' ? event.id : `${event.type}:${event.seq}`;
  if (state.seen.has(id)) return state;
  state.seen.add(id);

  switch (event.type) {
    case 'user_prompt': {
      const text = str(event, 'text');
      const origin = (event as { origin?: { kind?: string; name?: string } }).origin;
      state.blocks.push({
        kind: 'user',
        key: id,
        text,
        trigger: origin ? `${origin.kind}: ${origin.name}` : undefined,
      });
      break;
    }
    case 'assistant_chunk': {
      const delta = str(event, 'delta');
      const last = state.blocks[state.blocks.length - 1];
      if (last?.kind === 'assistant' && last.streaming) last.text += delta;
      else state.blocks.push({ kind: 'assistant', key: id, text: delta, streaming: true });
      break;
    }
    case 'assistant_message': {
      const content = str(event, 'content');
      // Searched for rather than assumed to be last: a tool call can land
      // between the chunks and the settled message, and matching only the last
      // block then appended a second copy of text already on screen.
      const at = openStreamingAt(state.blocks, 'assistant');
      const open = at === -1 ? null : state.blocks[at];
      if (open && open.kind === 'assistant') {
        open.text = content;
        open.streaming = false;
      } else if (content) {
        state.blocks.push({ kind: 'assistant', key: id, text: content, streaming: false });
      }
      break;
    }
    case 'reasoning_chunk': {
      const delta = str(event, 'delta');
      const last = state.blocks[state.blocks.length - 1];
      if (last?.kind === 'reasoning' && last.streaming) last.text += delta;
      else state.blocks.push({ kind: 'reasoning', key: id, text: delta, streaming: true });
      break;
    }
    case 'reasoning_message': {
      const redacted = (event as { redacted?: boolean }).redacted === true;
      const content = redacted ? '' : str(event, 'content');
      const at = openStreamingAt(state.blocks, 'reasoning');
      const last = at === -1 ? null : state.blocks[at];
      if (last && last.kind === 'reasoning') {
        if (content) {
          last.text = content;
          last.streaming = false;
        } else {
          // Redacted and empty: drop the placeholder, by index because it is
          // not necessarily the last block any more.
          state.blocks.splice(at, 1);
        }
      } else if (content) {
        state.blocks.push({ kind: 'reasoning', key: id, text: content, streaming: false });
      }
      break;
    }
    case 'tool_call_requested': {
      state.blocks.push({
        kind: 'tool',
        key: id,
        callId: str(event, 'callId'),
        name: str(event, 'name'),
        input: (event as { input?: unknown }).input,
        status: 'pending',
      });
      break;
    }
    case 'tool_call_approved': {
      const block = findTool(state, str(event, 'callId'));
      if (block && block.status === 'pending') block.status = 'running';
      break;
    }
    case 'tool_call_denied': {
      const block = findTool(state, str(event, 'callId'));
      if (block) {
        block.status = 'denied';
        block.detail = str(event, 'reason');
      }
      break;
    }
    case 'tool_result': {
      const block = findTool(state, str(event, 'callId'));
      if (block) {
        const ok = (event as { ok?: boolean }).ok === true;
        block.status = ok ? 'ok' : 'error';
        const output = (event as { output?: unknown }).output;
        const error = (event as { error?: { message?: string } }).error;
        block.detail = ok ? preview(output) : (error?.message ?? 'failed');
      }
      break;
    }
    case 'provider_response': {
      state.inputTokens += num(event, 'inputTokens');
      state.outputTokens += num(event, 'outputTokens');
      break;
    }
    case 'error': {
      // Severity comes from `kind`, never from the text. moxxy retries provider
      // failures itself (react-loop backs off up to six times) and reports each
      // attempt as a 'retryable' error while the turn is still very much alive;
      // only 'fatal' means it gave up. That is also the exact rule the
      // orchestrator applies before recording a run outcome, so a kind this
      // fold does not know must fall on the same side the server puts it on.
      // Otherwise the transcript and the run's status contradict each other.
      const errorKind = str(event, 'kind');
      const attempt = num(event, 'attempt');
      state.blocks.push({
        kind: 'notice',
        key: id,
        level: errorKind === 'fatal' ? 'error' : 'warn',
        title: ERROR_TITLES[errorKind] ?? 'Warning',
        text: str(event, 'message') || 'error',
        attempt: attempt > 0 ? attempt : undefined,
      });
      break;
    }
    case 'abort': {
      state.blocks.push({ kind: 'notice', key: id, level: 'info', text: 'Turn aborted' });
      break;
    }
    case 'plugin_event': {
      const subtype = str(event, 'subtype');
      if (subtype.startsWith('goal_')) {
        state.blocks.push({
          kind: 'notice',
          key: id,
          level: 'info',
          text: `goal: ${subtype.replace('goal_', '')}`,
        });
      }
      break;
    }
    default:
      break; // unknown event types are fine
  }
  return state;
}

export function foldMany(state: FoldState, events: ReadonlyArray<MoxxyEvent>): FoldState {
  for (const event of events) foldEvent(state, event);
  return state;
}

/**
 * The still-streaming block of a kind, wherever it ended up.
 *
 * A turn can start speaking, call a tool, and only then have its message
 * settle, which leaves the open block behind whatever the tool pushed. Looking
 * only at the last block appended a second copy of text already on screen.
 * Searches backwards because there is at most one open block per kind and it
 * is the most recent one.
 */
function openStreamingAt(blocks: readonly Block[], kind: 'assistant' | 'reasoning'): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === kind && block.streaming) return i;
  }
  return -1;
}

function findTool(state: FoldState, callId: string): Extract<Block, { kind: 'tool' }> | undefined {
  if (!callId) return undefined;
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block?.kind === 'tool' && block.callId === callId) return block;
  }
  return undefined;
}

function str(event: MoxxyEvent, key: string): string {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function num(event: MoxxyEvent, key: string): number {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function preview(output: unknown): string {
  if (output == null) return '';
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
}

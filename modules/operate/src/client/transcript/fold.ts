import type { MoxxyEvent } from '@companion/types';

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
  | { kind: 'notice'; key: string; level: 'error' | 'info'; text: string };

export interface FoldState {
  blocks: Block[];
  seen: Set<string>;
  inputTokens: number;
  outputTokens: number;
}

export function emptyFold(): FoldState {
  return { blocks: [], seen: new Set(), inputTokens: 0, outputTokens: 0 };
}

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
      const last = state.blocks[state.blocks.length - 1];
      if (last?.kind === 'assistant' && last.streaming) {
        last.text = content;
        last.streaming = false;
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
      const last = state.blocks[state.blocks.length - 1];
      if (last?.kind === 'reasoning' && last.streaming) {
        if (content) {
          last.text = content;
          last.streaming = false;
        } else {
          state.blocks.pop();
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
      state.blocks.push({
        kind: 'notice',
        key: id,
        level: 'error',
        text: str(event, 'message') || 'error',
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

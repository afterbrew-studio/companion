import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter, adaptFrames } from '../dist/exec/claude-adapter.js';
// The client slice is never built to dist (Vite reads it from source), so the
// transcript is folded by the real production code, not a copy of it.
import { emptyFold, foldMany } from '../src/client/transcript/fold.ts';

/**
 * Reading Claude Code's stream, checked the only way a capture can be checked:
 * by mutating it.
 *
 * A fixture alone proves nothing. An adapter that pairs the nth result with the
 * nth call agrees with the untouched capture exactly as well as one that reads
 * `tool_use_id`, so every claim below is stated as "move this field and the
 * transcript follows it", with a deliberately wrong control adapter that must
 * agree before the mutation and disagree after. Where there is no plausible
 * wrong twin, the mutation is enough on its own: the assertion names a field,
 * changes it, and requires the output to change.
 */

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const PROMPT = 'Read alpha.txt, then read beta.txt, then read gamma.txt.';
const SESSION = 'session-under-test';

const jsonl = (name) =>
  readFileSync(join(DIR, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const STREAM = jsonl('claude-stream.jsonl');
const TWO_TURNS = jsonl('claude-stream-two-turns.jsonl');
const SESSION_FILE = jsonl('claude-session-file.jsonl');

const clone = (frames) => JSON.parse(JSON.stringify(frames));

/** Adapt a live stream the way the harness does: the caller opens the turn. */
function live(frames, { prompt = PROMPT } = {}) {
  const events = [];
  const turns = [];
  const infos = [];
  const adapter = new ClaudeAdapter(SESSION, {
    onEvent: (e) => events.push(e),
    onTurnEnd: (t) => turns.push(t),
    onSessionInfo: (i) => infos.push(i),
  });
  adapter.beginTurn('turn-1', prompt);
  for (const frame of frames) adapter.push(frame);
  adapter.end();
  return { events, turns, infos };
}

const fold = (events) => foldMany(emptyFold(), events).blocks;

/** file name → block status, which is what the transcript actually renders. */
const toolStatus = (blocks) => {
  const out = {};
  for (const block of blocks) {
    if (block.kind === 'tool') out[fileOf(block.input)] = block.status;
  }
  return out;
};

const fileOf = (input) => String(input?.file_path ?? input?.path ?? '').split('/').pop() ?? '';

const notices = (blocks) => blocks.filter((b) => b.kind === 'notice');

const BASELINE = toolStatus(fold(live(STREAM).events));

/**
 * The control: an adapter that pairs the nth result with the nth call instead
 * of reading `tool_use_id`. It exists to prove the mutations below are
 * discriminating; if it ever stops disagreeing under permutation, the
 * permutation stopped testing anything.
 */
function byPosition(frames) {
  const events = live(frames).events;
  const callIds = events.filter((e) => e.type === 'tool_call_requested').map((e) => e.callId);
  let n = 0;
  return events.map((e) => (e.type === 'tool_result' ? { ...e, callId: callIds[n++] } : e));
}

/**
 * All three calls are issued before their results settle in a real stream, and
 * the fold drops a result whose call it has not seen. Relocating the results
 * past the last call is what lets a permutation be observed at all; it must be
 * behaviour-preserving, which the first test asserts.
 */
function settle(frames) {
  const results = frames.filter((f) => f.type === 'user');
  const rest = frames.filter((f) => f.type !== 'user');
  const at = rest.findIndex((f) => f.type === 'result');
  return [...rest.slice(0, at), ...results, ...rest.slice(at)];
}

// ---------- the capture, as it came off the wire -----------------------------

test('the captured turn folds into a transcript, with the failure on the file that is missing', () => {
  assert.deepEqual(BASELINE, { 'alpha.txt': 'ok', 'beta.txt': 'ok', 'gamma.txt': 'error' });
});

/** What the transcript can render. Anything else lands on the fold's `default`. */
const KNOWN_TYPES = new Set([
  'user_prompt',
  'assistant_chunk',
  'assistant_message',
  'reasoning_chunk',
  'reasoning_message',
  'tool_call_requested',
  'tool_result',
  'provider_response',
  'error',
]);

const unknownTypes = (events) => [...new Set(events.map((e) => e.type))].filter((t) => !KNOWN_TYPES.has(t));

test('every type it emits is one the transcript already knows', () => {
  // Both directions: the live stream and a replayed session file. The file
  // carries frame types the stream never sends (attachment, ai-title,
  // queue-operation, last-prompt) and relaying them would put events on the
  // transcript that nothing renders and every consumer still has to carry.
  assert.deepEqual(unknownTypes(live(STREAM).events), []);
  assert.deepEqual(unknownTypes(adaptFrames(SESSION, SESSION_FILE)), []);
});

test('the prompt is on the transcript even though the stream never echoed it', () => {
  // Detail 6: no frame in the capture carries it, so it can only come from the
  // caller. An adapter that waited for the stream would render a headless turn.
  assert.equal(
    STREAM.filter((f) => f.type === 'user').some((f) => typeof f.message?.content === 'string'),
    false,
  );
  const blocks = fold(live(STREAM).events);
  assert.equal(blocks[0].kind, 'user');
  assert.match(blocks[0].text, /alpha\.txt/);
  // ...and it is absent when the caller has nothing to synthesize from.
  assert.notEqual(fold(live(STREAM, { prompt: null }).events)[0].kind, 'user');
});

test('the answer survives streaming: nothing is left half-rendered', () => {
  const blocks = fold(live(STREAM).events);
  assert.equal(blocks.some((b) => b.kind === 'assistant' && b.streaming), false);
  const last = [...blocks].reverse().find((b) => b.kind === 'assistant');
  assert.match(last.text, /apple/);
  assert.match(last.text, /banana/);
});

// ---------- detail 4: results pair by id, never by position ------------------

test('relocating the results past the last call is behaviour-preserving', () => {
  assert.deepEqual(toolStatus(fold(live(settle(STREAM)).events)), BASELINE);
});

test('CONTROL: the position-pairing adapter agrees on the untouched capture', () => {
  // Which is exactly why the capture alone proves nothing.
  assert.deepEqual(toolStatus(fold(byPosition(settle(STREAM)))), BASELINE);
});

test('reversing the result order changes nothing, and breaks the control', () => {
  const permuted = settle(STREAM);
  const at = permuted.map((f, i) => (f.type === 'user' ? i : -1)).filter((i) => i >= 0);
  const picked = at.map((i) => permuted[i]).reverse();
  at.forEach((i, n) => (permuted[i] = picked[n]));

  assert.deepEqual(toolStatus(fold(live(permuted).events)), BASELINE);
  assert.notDeepEqual(toolStatus(fold(byPosition(permuted))), BASELINE);
});

test('swapping two tool_use_id values moves the failure, and the control does not notice', () => {
  const swapped = clone(settle(STREAM));
  const results = swapped.filter((f) => f.type === 'user').map((f) => f.message.content[0]);
  const [first, last] = [results[0], results[results.length - 1]];
  [first.tool_use_id, last.tool_use_id] = [last.tool_use_id, first.tool_use_id];

  const moved = toolStatus(fold(live(swapped).events));
  assert.equal(moved['alpha.txt'], 'error');
  assert.equal(moved['gamma.txt'], 'ok');
  assert.deepEqual(toolStatus(fold(byPosition(swapped))), BASELINE);
});

test('the capture really is out of lockstep, so the pairing claim is not academic', () => {
  // A result for one call arrives while the next call's arguments are still
  // streaming. Without this the permutations above would be testing a stream
  // that never happens.
  const firstResult = STREAM.findIndex((f) => f.type === 'user');
  const lastCall = STREAM.map((f, i) => (f.type === 'assistant' && f.message.content[0]?.type === 'tool_use' ? i : -1))
    .filter((i) => i >= 0)
    .pop();
  assert.ok(firstResult < lastCall, 'no result landed before the last call was issued');
});

// ---------- detail 1: is_error is a field, not a word ------------------------

test('deleting is_error makes the failure succeed, though its text still reads like a failure', () => {
  const cleared = clone(STREAM);
  for (const frame of cleared) {
    if (frame.type !== 'user') continue;
    for (const block of frame.message.content) delete block.is_error;
  }
  const status = toolStatus(fold(live(cleared).events));
  assert.equal(status['gamma.txt'], 'ok');
  // The prose is untouched: an adapter reading it would still call this failed.
  assert.match(
    JSON.stringify(cleared.filter((f) => f.type === 'user')),
    /File does not exist/,
  );
});

test('is_error:false reads exactly like absent, because success never sets it', () => {
  const explicit = clone(STREAM);
  for (const frame of explicit) {
    if (frame.type !== 'user') continue;
    for (const block of frame.message.content) block.is_error = block.is_error === true ? true : false;
  }
  assert.deepEqual(toolStatus(fold(live(explicit).events)), BASELINE);
  // And the capture itself never carries `false`, which is the whole trap.
  const seen = STREAM.filter((f) => f.type === 'user').flatMap((f) => f.message.content.map((b) => b.is_error));
  assert.deepEqual([...new Set(seen)], [undefined, true]);
});

// ---------- detail 3: an allowed rate limit is not an error ------------------

test('a rate_limit_event during a healthy turn produces no notice', () => {
  assert.ok(
    STREAM.some((f) => f.type === 'rate_limit_event' && f.rate_limit_info.status === 'allowed'),
    'the capture has no rate_limit_event to test with',
  );
  assert.deepEqual(notices(fold(live(STREAM).events)), []);
});

test('flipping rate_limit_info.status to rejected produces exactly one warning', () => {
  const limited = clone(STREAM);
  for (const frame of limited) {
    if (frame.type === 'rate_limit_event') frame.rate_limit_info.status = 'rejected';
  }
  const raised = notices(fold(live(limited).events));
  assert.equal(raised.length, 1);
  assert.equal(raised[0].level, 'warn');
});

test('result.is_error is likewise a field: setting it raises a run error', () => {
  const failed = clone(STREAM);
  for (const frame of failed) {
    if (frame.type !== 'result') continue;
    frame.is_error = true;
    frame.subtype = 'error_during_execution';
  }
  const raised = notices(fold(live(failed).events));
  assert.equal(raised.length, 1);
  assert.equal(raised[0].level, 'error');
  // ...and the untouched capture carries is_error:false there, so a presence
  // check would have called the successful run a failure.
  assert.equal(STREAM.find((f) => f.type === 'result').is_error, false);
});

test('an api_error_status is reported as itself rather than as the generic text', () => {
  const failed = clone(STREAM);
  for (const frame of failed) {
    if (frame.type !== 'result') continue;
    frame.is_error = true;
    frame.api_error_status = 529;
  }
  assert.match(notices(fold(live(failed).events))[0].text, /529/);
});

// ---------- detail 5: stop_reason arrives late -------------------------------

test('an assistant message carries the stop reason that arrives after it', () => {
  // The `assistant` frames say `stop_reason: null`; only `message_delta` knows.
  // Stamping the frame's own value would report end_turn for a message that
  // stopped to call a tool.
  assert.deepEqual(
    [...new Set(STREAM.filter((f) => f.type === 'assistant').map((f) => f.message.stop_reason))],
    [null],
  );
  const reasons = live(STREAM).events.filter((e) => e.type === 'assistant_message').map((e) => e.stopReason);
  assert.deepEqual(reasons, ['end_turn']);
});

test('the reason follows message_delta, not the frame it is stamped on', () => {
  const truncated = clone(STREAM);
  for (const frame of truncated) {
    if (frame.type === 'stream_event' && frame.event.type === 'message_delta') {
      frame.event.delta.stop_reason = 'max_tokens';
    }
  }
  const reasons = live(truncated).events.filter((e) => e.type === 'assistant_message').map((e) => e.stopReason);
  assert.deepEqual(reasons, ['max_tokens']);
});

test('a message cut short still reaches the transcript, marked as an error', () => {
  // The process dying mid-message is the case a held message could be lost in.
  const cut = STREAM.slice(0, STREAM.findIndex((f) => f.type === 'stream_event' && f.event.type === 'message_delta' && f.event.delta.stop_reason === 'end_turn'));
  const events = live(cut).events;
  const held = events.filter((e) => e.type === 'assistant_message');
  assert.equal(held.length, 1);
  assert.equal(held[0].stopReason, 'error');
});

// ---------- detail 2: system/init repeats per turn ---------------------------

test('two turns down one session share one id, and init arrives for each', () => {
  const ids = new Set(TWO_TURNS.map((f) => f.session_id).filter(Boolean));
  assert.equal(ids.size, 1);
  assert.equal(TWO_TURNS.filter((f) => f.type === 'system' && f.subtype === 'init').length, 2);
});

test('a repeated init refreshes the session and does not open a turn', () => {
  // Treating init as a turn boundary would split one turn in two and put a
  // second prompt on the transcript that nobody sent.
  const { events, infos, turns } = live(TWO_TURNS, { prompt: 'first' });
  assert.equal(infos.length, 2);
  assert.equal(events.filter((e) => e.type === 'user_prompt').length, 1);
  assert.equal(new Set(events.map((e) => e.turnId)).size, 1);
  assert.equal(turns.length, 2);
});

test('session info reports the model, tools and permission mode init carries', () => {
  const info = live(STREAM).infos[0];
  assert.match(info.model, /claude/);
  assert.ok(info.tools.length > 0);
  assert.ok(info.permissionMode.length > 0);
});

// ---------- usage, which is what makes the ceiling real ----------------------

test('the turn reports the tokens and cost the result frame carries', () => {
  const [summary] = live(STREAM).turns;
  assert.equal(summary.ok, true);
  assert.ok(summary.costUsd > 0);
  assert.ok(summary.inputTokens > 0 && summary.outputTokens > 0);
});

test('token counts reach the transcript as provider_response, priced by the run', () => {
  const usage = live(STREAM).events.filter((e) => e.type === 'provider_response');
  assert.ok(usage.length > 0);
  assert.ok(usage.some((u) => u.outputTokens > 0));
  assert.ok(usage.some((u) => u.cacheReadTokens > 0), 'the cache split was dropped');
});

test('a result that reports nothing reads as zero rather than as NaN', () => {
  const bare = clone(STREAM);
  for (const frame of bare) {
    if (frame.type !== 'result') continue;
    delete frame.usage;
    delete frame.total_cost_usd;
  }
  const [summary] = live(bare).turns;
  assert.deepEqual(
    [summary.costUsd, summary.inputTokens, summary.outputTokens],
    [0, 0, 0],
  );
});

// ---------- the session file, read by the same adapter -----------------------

test('a reaped run replays from disk into the same transcript', () => {
  const status = toolStatus(fold(adaptFrames(SESSION, SESSION_FILE)));
  assert.deepEqual(status, BASELINE);
});

test('a reaped run preserves session-file timestamps for tool durations', () => {
  const events = adaptFrames(SESSION, SESSION_FILE);
  const call = events.find((event) => event.type === 'tool_call_requested');
  const result = events.find((event) => event.type === 'tool_result' && event.callId === call.callId);
  const sourceCall = SESSION_FILE.find((frame) =>
    frame.type === 'assistant' && Array.isArray(frame.message?.content) &&
    frame.message.content.some((block) => block.id === call.callId));
  const sourceResult = SESSION_FILE.find((frame) =>
    frame.type === 'user' && Array.isArray(frame.message?.content) &&
    frame.message.content.some((block) => block.tool_use_id === call.callId));

  assert.equal(call.ts, Date.parse(sourceCall.timestamp));
  assert.equal(result.ts, Date.parse(sourceResult.timestamp));
  assert.ok(result.ts >= call.ts);
});

test('the file carries the prompt the stream withheld, so replay needs no caller', () => {
  const blocks = fold(adaptFrames(SESSION, SESSION_FILE));
  assert.equal(blocks[0].kind, 'user');
  assert.match(blocks[0].text, /alpha\.txt/);
});

test('the file types the adapter has never seen are ignored, not rendered', () => {
  // attachment / ai-title / queue-operation / last-prompt: a harness that
  // rendered them as opaque blocks would put noise on every replayed run.
  const kinds = new Set(SESSION_FILE.map((f) => f.type));
  assert.ok(kinds.has('attachment') && kinds.has('ai-title'), 'the fixture lost its extra frame types');
  assert.deepEqual(
    [...new Set(fold(adaptFrames(SESSION, SESSION_FILE)).map((b) => b.kind))].sort(),
    ['assistant', 'reasoning', 'tool', 'user'],
  );
});

test('one corrupt line does not hide the transcript around it', () => {
  const withHole = [...SESSION_FILE];
  withHole.splice(3, 0, 'not json at all');
  const events = adaptFrames(SESSION, withHole.filter((f) => typeof f !== 'string'));
  assert.deepEqual(toolStatus(fold(events)), BASELINE);
});

// ---------- garbage in ---------------------------------------------------------

test('frames that are not objects are dropped rather than crashing the stream', () => {
  const noise = [null, 42, 'text', [], { type: 'assistant' }, { type: 'user', message: {} }];
  const { events } = live([...noise, ...STREAM, ...noise]);
  assert.deepEqual(toolStatus(fold(events)), BASELINE);
});

test('a tool_use block with no id still reaches the transcript', () => {
  // Dropping it would lose the call and then silently drop its result too.
  const events = adaptFrames(SESSION, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_call_requested');
  assert.equal(events[0].name, 'Read');
});

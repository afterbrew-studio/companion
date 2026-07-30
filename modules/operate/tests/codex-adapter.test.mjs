import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAdapter, adaptRollout } from '../dist/exec/codex-adapter.js';
// The client slice is never built to dist (Vite reads it from source), so the
// transcript is folded by the real production code, not a copy of it.
import { emptyFold, foldMany } from '../src/client/transcript/fold.ts';

/**
 * Reading Codex's stream, checked the same way Claude Code's is: by mutating
 * the capture.
 *
 * The two harnesses are close enough to be dangerous. An adapter written for
 * Claude Code and pointed at Codex is wrong in exactly one direction that a
 * clean capture cannot show: `is_error` is ABSENT on a Claude Code success, so
 * testing for the key is how you read one, and `exit_code` is PRESENT and zero
 * on a Codex success, so the same test marks every success as a failure. The
 * control adapter below spells that mistake out and must disagree.
 */

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const PROMPT = "Run 'cat alpha.txt', 'cat beta.txt' and 'cat gamma.txt', then say which existed.";
const SESSION = 'run-under-test';

const jsonl = (name) =>
  readFileSync(join(DIR, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const STREAM = jsonl('codex-stream.jsonl');
const ROLLOUT = jsonl('codex-rollout.jsonl');

const clone = (frames) => JSON.parse(JSON.stringify(frames));

/** Adapt a live stream the way the harness does: the caller opens the turn. */
function live(frames, { prompt = PROMPT } = {}) {
  const events = [];
  const turns = [];
  const threads = [];
  const adapter = new CodexAdapter(SESSION, {
    onEvent: (e) => events.push(e),
    onTurnEnd: (t) => turns.push(t),
    onThread: (id) => threads.push(id),
  });
  adapter.beginTurn('turn-1', prompt);
  for (const frame of frames) adapter.push(frame);
  return { events, turns, threads };
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

const fileOf = (input) => (String(input?.command ?? '').match(/(\w+\.txt)/) ?? [])[1] ?? '';

const BASELINE = toolStatus(fold(live(STREAM).events));

/**
 * The control: an adapter that decides a call failed the way Claude Code's
 * stream is read, by testing whether the failure key is present at all. It
 * exists to prove the mutations below are discriminating; if it ever stops
 * disagreeing, the assertion stopped testing anything.
 */
function byKeyPresence(frames) {
  return live(frames).events.map((e) => {
    if (e.type !== 'tool_result') return e;
    const item = completedItem(frames, e.callId);
    return { ...e, ok: !('exit_code' in item) };
  });
}

/** The control for pairing: the nth result belongs to the nth call. */
function byPosition(frames) {
  const events = live(frames).events;
  const callIds = events.filter((e) => e.type === 'tool_call_requested').map((e) => e.callId);
  let n = 0;
  return events.map((e) => (e.type === 'tool_result' ? { ...e, callId: callIds[n++] } : e));
}

const completedItem = (frames, id) =>
  frames.find((f) => f.type === 'item.completed' && f.item.id === id)?.item ?? {};

/**
 * Move every completed command past the last started one. Position and id
 * agree in the capture as it came off the wire, so nothing can be observed
 * until they are made to disagree; this must be behaviour-preserving, which
 * the first test asserts.
 */
function settle(frames) {
  const done = frames.filter((f) => f.type === 'item.completed' && f.item.type === 'command_execution');
  const rest = frames.filter((f) => !done.includes(f));
  const at = rest.findIndex((f) => f.type === 'turn.completed');
  return [...rest.slice(0, at), ...done, ...rest.slice(at)];
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
  // Both directions: the live stream and a replayed rollout file. The file
  // carries record types the stream never sends (session_meta, world_state,
  // turn_context) and relaying them would put events on the transcript that
  // nothing renders and every consumer still has to carry.
  assert.deepEqual(unknownTypes(live(STREAM).events), []);
  assert.deepEqual(unknownTypes(adaptRollout(SESSION, ROLLOUT)), []);
});

test('the prompt is on the transcript even though the stream never echoed it', () => {
  const { events } = live(STREAM);
  assert.equal(events[0].type, 'user_prompt');
  assert.equal(events[0].text, PROMPT);
  // Nothing in the capture carries it, so a harness that did not synthesize it
  // would leave the run detail page opening on the answer to a missing question.
  assert.equal(JSON.stringify(STREAM).includes('cat alpha.txt'), true);
  assert.equal(STREAM.some((f) => f.type === 'user_prompt' || f.type === 'user_message'), false);
});

test('the thread id is reported, because it is the only way a later turn resumes', () => {
  const { threads } = live(STREAM);
  assert.deepEqual(threads, [STREAM[0].thread_id]);
  assert.match(threads[0], /^[0-9a-f-]{36}$/);
});

// ---------- failure is read from the field, not from the shape ---------------

test('a successful command CARRIES exit_code, so testing for the key marks every success failed', () => {
  const ok = completedItem(STREAM, 'item_1');
  assert.equal('exit_code' in ok, true);
  assert.equal(ok.exit_code, 0);
  assert.equal(ok.status, 'completed');
  // The Claude Code reading of the same stream, which is the mistake this
  // guards. `exit_code` is present on BOTH outcomes here, so a presence test
  // does not merely mislabel the successes, it reports every call as failed and
  // is never right about any of them.
  assert.deepEqual(toolStatus(fold(byKeyPresence(STREAM))), {
    'alpha.txt': 'error',
    'beta.txt': 'error',
    'gamma.txt': 'error',
  });
});

test('flipping exit_code moves the failure, so it is the field that is read', () => {
  const frames = clone(STREAM);
  const failed = frames.find((f) => f.type === 'item.completed' && f.item.exit_code === 1);
  const succeeded = frames.find((f) => f.type === 'item.completed' && f.item.exit_code === 0);
  failed.item.exit_code = 0;
  failed.item.status = 'completed';
  succeeded.item.exit_code = 1;
  succeeded.item.status = 'failed';
  assert.deepEqual(toolStatus(fold(live(frames).events)), {
    'alpha.txt': 'error',
    'beta.txt': 'ok',
    'gamma.txt': 'ok',
  });
});

test('the failing command still READS like a failure after the field is cleared', () => {
  // The output says "No such file or directory" either way. A transcript that
  // followed the prose rather than the field would not move here, and does.
  const frames = clone(STREAM);
  const failed = frames.find((f) => f.type === 'item.completed' && f.item.exit_code === 1);
  assert.match(String(failed.item.aggregated_output), /No such file/i);
  failed.item.exit_code = 0;
  failed.item.status = 'completed';
  assert.equal(toolStatus(fold(live(frames).events))['gamma.txt'], 'ok');
});

// ---------- pairing is by item id --------------------------------------------

test('relocating the completions changes nothing, which is what makes the permutation readable', () => {
  assert.deepEqual(toolStatus(fold(live(settle(STREAM)).events)), BASELINE);
  assert.deepEqual(toolStatus(fold(byPosition(settle(STREAM)))), BASELINE);
});

test('permuting the completions leaves the id reading identical and moves the position one', () => {
  const frames = settle(clone(STREAM));
  const done = frames.filter((f) => f.type === 'item.completed' && f.item.type === 'command_execution');
  const at = frames.indexOf(done[0]);
  frames.splice(at, done.length, done[2], done[0], done[1]);

  assert.deepEqual(toolStatus(fold(live(frames).events)), BASELINE);
  assert.notDeepEqual(toolStatus(fold(byPosition(frames))), BASELINE);
});

test('swapping two item ids moves the failure, and leaves the position reading unmoved', () => {
  const frames = settle(clone(STREAM));
  const done = frames.filter((f) => f.type === 'item.completed' && f.item.type === 'command_execution');
  const [first, , third] = done;
  [first.id, third.id] = [third.id, first.id];
  [first.item.id, third.item.id] = [third.item.id, first.item.id];

  assert.notDeepEqual(toolStatus(fold(live(frames).events)), BASELINE);
  assert.deepEqual(toolStatus(fold(byPosition(frames))), BASELINE);
});

test('a completion whose start was never seen still emits its call first', () => {
  // `agent_message` items genuinely arrive completed-only, and the fold drops a
  // result whose call it has not seen: without this the item would vanish.
  const frames = clone(STREAM).filter((f) => !(f.type === 'item.started' && f.item.id === 'item_2'));
  assert.deepEqual(toolStatus(fold(live(frames).events)), BASELINE);
});

// ---------- what a turn cost -------------------------------------------------

test('usage is taken from turn.completed, in tokens, with no cost invented', () => {
  const { events, turns } = live(STREAM);
  const usage = STREAM.find((f) => f.type === 'turn.completed').usage;
  const reported = events.find((e) => e.type === 'provider_response');
  assert.equal(reported.inputTokens, usage.input_tokens);
  assert.equal(reported.outputTokens, usage.output_tokens);
  assert.equal(reported.cacheReadTokens, usage.cached_input_tokens);
  assert.deepEqual(turns, [
    { turnId: 'turn-1', ok: true, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  ]);
  // Codex reports no dollar figure at all; one appearing here would be invented.
  assert.equal(JSON.stringify(reported).includes('ost'), false);
});

test('a failed turn ends the turn as failed and says so on the transcript', () => {
  const { events, turns } = live([{ type: 'turn.failed', error: { message: 'model refused' } }]);
  const error = events.find((e) => e.type === 'error');
  assert.equal(error.message, 'model refused');
  assert.equal(turns[0].ok, false);
});

// ---------- the rollout file a reaped run is read back from ------------------

test('the rollout file replays the same conversation the stream produced', () => {
  const replayed = adaptRollout(SESSION, ROLLOUT);
  const calls = replayed.filter((e) => e.type === 'tool_call_requested');
  const results = replayed.filter((e) => e.type === 'tool_result');
  assert.equal(calls.length, 3);
  assert.equal(results.length, 3);
  // Paired by call id, the same rule the live stream follows.
  assert.deepEqual(results.map((r) => r.callId).sort(), calls.map((c) => c.callId).sort());
  assert.match(
    replayed.find((e) => e.type === 'user_prompt').text,
    /alpha\.txt/,
  );
});

test('a message is not counted twice, though the file records it in two places', () => {
  // Every assistant message appears as an `event_msg` AND as a `response_item`
  // of role assistant. Relaying both would double every line on the page.
  const assistant = ROLLOUT.filter(
    (r) => r.type === 'response_item' && r.payload?.type === 'message' && r.payload?.role === 'assistant',
  );
  const events = ROLLOUT.filter((r) => r.type === 'event_msg' && r.payload?.type === 'agent_message');
  assert.equal(assistant.length > 0, true);
  assert.equal(events.length, assistant.length);
  assert.equal(adaptRollout(SESSION, ROLLOUT).filter((e) => e.type === 'assistant_message').length, events.length);
});

test('records that describe the machine rather than the conversation are ignored', () => {
  const noise = ['session_meta', 'world_state', 'turn_context'];
  assert.equal(ROLLOUT.some((r) => noise.includes(r.type)), true);
  const without = adaptRollout(SESSION, ROLLOUT.filter((r) => !noise.includes(r.type)));
  assert.deepEqual(
    without.map((e) => e.type),
    adaptRollout(SESSION, ROLLOUT).map((e) => e.type),
  );
});

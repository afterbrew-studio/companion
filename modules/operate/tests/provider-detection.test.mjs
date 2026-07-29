import assert from 'node:assert/strict';
import test from 'node:test';
import { detectProviders } from '../dist/contract/index.js';

/**
 * Detection answers "is anything configured anywhere", and its third state is
 * the reason it exists: a machine nobody has read yet must never be reported as
 * having nothing, because the page turns that answer into "go fix this".
 */

const machine = (id, fetchedAt, online = true, providerModels = true) => ({
  id,
  name: id,
  online,
  fetchedAt,
  modelCount: 0,
  providerModels,
  providers: [],
  policy: { disabledProviders: [], disabledModels: [] },
});

/** A machine whose agent runtime signs in on its own and brings its own models. */
const builtin = (id, online = true) => machine(id, null, online, false);

const merged = (name, machines = [], disabledOn = []) => ({ name, machines, disabledOn, models: [] });

const catalog = (providers, machines) => ({ providers, machines, defaultModel: 'opus', fetchedAt: null });

test('a provider some machine serves is found, and names what was found', () => {
  const found = detectProviders(catalog([merged('anthropic', ['m1'])], [machine('m1', 1000)]));
  assert.equal(found.state, 'found');
  assert.deepEqual(found.providers, ['anthropic']);
  assert.equal(found.machines, 1);
});

test('credentials the operator switched off still count as found, not as nothing', () => {
  // A provider with credentials but disabled here is a switch to flip, so
  // sending the operator to "configure a provider" would be wrong.
  const found = detectProviders(catalog([merged('anthropic', [], ['m1'])], [machine('m1', 1000)]));
  assert.equal(found.state, 'found');
  assert.equal(found.machines, 1);
});

test('a provider name no machine can serve is not found', () => {
  // The merged list also carries names read from the daemon's own moxxy config;
  // a name alone proves no credentials exist anywhere.
  const answer = detectProviders(catalog([merged('anthropic')], [machine('m1', 1000)]));
  assert.equal(answer.state, 'none');
});

test('a machine that has never been read leaves detection unknown, not none', () => {
  const answer = detectProviders(catalog([], [machine('m1', null)]));
  assert.equal(answer.state, 'unknown');
  assert.equal(answer.reading, 1);
  assert.equal(answer.unreachable, 0);
});

test('unknown counts only the machines still unread', () => {
  const answer = detectProviders(catalog([], [machine('m1', null), machine('m2', 1000), machine('m3', null)]));
  assert.equal(answer.state, 'unknown');
  assert.equal(answer.reading, 2);
});

/**
 * Only online machines are ever catalog-probed, so an offline one that never
 * reported will stay unread until it comes back. Counting it as "reading"
 * promises an answer nothing is going to fetch, and Refresh would not move it.
 */
test('an offline unread machine is unreachable, never counted as being read', () => {
  const answer = detectProviders(catalog([], [machine('m1', null, false)]));
  assert.equal(answer.state, 'unknown');
  assert.equal(answer.reading, 0);
  assert.equal(answer.unreachable, 1);
});

test('unknown separates the machines being read from the unreachable ones', () => {
  const answer = detectProviders(
    catalog([], [machine('m1', null), machine('m2', null, false), machine('m3', null, false)]),
  );
  assert.equal(answer.state, 'unknown');
  assert.equal(answer.reading, 1);
  assert.equal(answer.unreachable, 2);
});

test('an offline machine that already reported is not unread at all', () => {
  assert.equal(detectProviders(catalog([], [machine('m1', 1000, false)])).state, 'none');
});

test('every machine read and none credentialed is none', () => {
  assert.equal(detectProviders(catalog([], [machine('m1', 1000), machine('m2', 2000)])).state, 'none');
});

test('no machines at all is none, not unknown', () => {
  assert.equal(detectProviders(catalog([], [])).state, 'none');
});

/**
 * A machine whose runtime brings its own models is never going to report a
 * provider. Reading it as "none" tells the operator to add credentials that
 * would land nowhere; reading it as "unknown" promises a report that is never
 * coming. Both are the same defect this page was built to avoid, so it gets its
 * own answer.
 */
test('a machine that takes no models from providers is builtin, not none', () => {
  assert.equal(detectProviders(catalog([], [builtin('m1')])).state, 'builtin');
});

test('a builtin machine never sits in unknown waiting for a report', () => {
  // Online and unread: the only reason it would be counted as "reading".
  const answer = detectProviders(catalog([], [builtin('m1'), machine('m2', null)]));
  assert.equal(answer.state, 'unknown');
  assert.equal(answer.reading, 1);
  assert.equal(answer.unreachable, 0);
});

test('one provider machine among builtin ones still decides the answer', () => {
  assert.equal(detectProviders(catalog([], [builtin('m1'), machine('m2', 1000)])).state, 'none');
  assert.equal(
    detectProviders(catalog([merged('anthropic', ['m2'])], [builtin('m1'), machine('m2', 1000)])).state,
    'found',
  );
});

test('builtin needs a machine: an empty fleet is still none', () => {
  assert.equal(detectProviders(catalog([], [])).state, 'none');
});

test('a credentialed machine settles detection even while another is unread', () => {
  const answer = detectProviders(catalog([merged('anthropic', ['m1'])], [machine('m1', 5), machine('m2', null)]));
  assert.equal(answer.state, 'found');
});

test('the machine count is distinct machines, not provider entries', () => {
  const answer = detectProviders(
    catalog([merged('anthropic', ['m1', 'm2']), merged('openai', ['m1'])], [machine('m1', 1), machine('m2', 1)]),
  );
  assert.equal(answer.state, 'found');
  assert.equal(answer.machines, 2);
  assert.deepEqual(answer.providers, ['anthropic', 'openai']);
});

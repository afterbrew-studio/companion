import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentPolicy,
  AgentPolicyError,
  DEFAULT_MAX_OUTPUT_TOKENS,
  branchMatches,
  parsePatterns,
} from '../dist/api/agent-policy.js';

const policy = (values = {}, audited = []) =>
  new AgentPolicy(
    { values: () => values, get: (k) => (k in values ? values[k] : null) },
    (action, detail) => audited.push({ action, detail }),
  );

// ---------- pattern matching ----------

test('a plain name matches only itself', () => {
  assert.equal(branchMatches('main', 'main'), true);
  assert.equal(branchMatches('main', 'maintenance'), false);
  assert.equal(branchMatches('main', 'feature/main'), false);
});

test('a wildcard covers the whole rest of the ref, separators included', () => {
  // `release/*` has to cover `release/2026/07`; nobody writing this expects
  // shell-glob segment rules.
  assert.equal(branchMatches('release/*', 'release/2026-07'), true);
  assert.equal(branchMatches('release/*', 'release/2026/07'), true);
  assert.equal(branchMatches('release/*', 'releases/2026'), false);
});

test('matching is case-insensitive, because Git refs in the wild are not consistent', () => {
  assert.equal(branchMatches('Main', 'main'), true);
});

test('regex metacharacters in a pattern are literal, not a pattern', () => {
  // Otherwise a typo like `main.` would silently protect `mainX`.
  assert.equal(branchMatches('main.', 'mainX'), false);
  assert.equal(branchMatches('v1.0', 'v1.0'), true);
  assert.equal(branchMatches('v1.0', 'v1x0'), false);
});

test('patterns split on commas and newlines, and blanks are dropped', () => {
  assert.deepEqual(parsePatterns('main, master\n release/* ,,'), ['main', 'master', 'release/*']);
  assert.deepEqual(parsePatterns(''), []);
  assert.deepEqual(parsePatterns(null), []);
});

// ---------- git write ----------

test('the default allows writes, so an instance that never configured this is unchanged', () => {
  assert.doesNotThrow(() => policy().assertGitWrite('acme/app'));
});

test('a read-only instance refuses every repository write', () => {
  assert.throws(() => policy({ agentGitWrite: 'refused' }).assertGitWrite('acme/app'), AgentPolicyError);
});

test('a refusal is audited with the repository it was for', () => {
  const audited = [];
  assert.throws(() => policy({ agentGitWrite: 'refused' }, audited).assertGitWrite('acme/app'));
  assert.equal(audited.length, 1);
  assert.equal(audited[0].action, 'policy.git-write.refused');
  assert.match(audited[0].detail, /acme\/app/);
});

test('a refusal answers 403, because it will not clear on its own', () => {
  try {
    policy({ agentGitWrite: 'refused' }).assertGitWrite(null);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.equal(err.status, 403);
  }
});

test('an allowed write is not audited, or the trail is all noise', () => {
  const audited = [];
  policy({}, audited).assertGitWrite('acme/app');
  assert.deepEqual(audited, []);
});

// ---------- push targets ----------

test('the default protected set covers the branches people actually mean', () => {
  const p = policy();
  for (const branch of ['main', 'master', 'prod', 'release/2026-07']) {
    assert.throws(() => p.assertPushTarget('acme/app', branch), AgentPolicyError, `${branch} should be protected`);
  }
});

test('an agent branch is not protected, which is the whole point', () => {
  assert.doesNotThrow(() => policy().assertPushTarget('acme/app', 'companion/fix-142'));
});

test('an explicitly emptied field protects nothing', () => {
  // A policy field has to be able to say no as well as yes; an empty string must
  // not silently fall back to the default set.
  assert.doesNotThrow(() => policy({ protectedBranches: '' }).assertPushTarget('acme/app', 'main'));
});

test('a protected push is refused even while writes are allowed in general', () => {
  const audited = [];
  assert.throws(() => policy({ protectedBranches: 'main' }, audited).assertPushTarget('acme/app', 'main'));
  assert.equal(audited[0].action, 'policy.push.refused');
  assert.match(audited[0].detail, /main/);
});

test('read-only wins over the branch check, and says so rather than blaming the branch', () => {
  try {
    policy({ agentGitWrite: 'refused' }).assertPushTarget('acme/app', 'companion/fix-1');
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message, /does not allow agents to write/);
  }
});

// ---------- token ceiling ----------

test('the ceiling keeps the value the constant had, so behaviour is unchanged by default', () => {
  assert.equal(policy().maxOutputTokens(), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 400_000);
});

test('a configured ceiling is used, and nonsense falls back rather than becoming zero', () => {
  assert.equal(policy({ maxRunOutputTokens: 50_000 }).maxOutputTokens(), 50_000);
  for (const bad of [0, -1, 'lots', null]) {
    assert.equal(policy({ maxRunOutputTokens: bad }).maxOutputTokens(), DEFAULT_MAX_OUTPUT_TOKENS);
  }
});

// ---------- snapshot ----------

test('the snapshot reports the effective policy, which is what an auditor reads', () => {
  const snapshot = policy({ agentGitWrite: 'refused', protectedBranches: 'main, dev' }).snapshot();
  assert.deepEqual(snapshot, {
    gitWrite: 'refused',
    protectedBranches: ['main', 'dev'],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentBranchPrefix,
  aiAttributionLines,
  gatherProvenance,
  provenanceSection,
  summarizeCommits,
  toStanding,
  trailerKeys,
} from '../dist/api/provenance.js';

function commit(message, { sha = 'abcdef1234', login = 'alice', date = '2026-07-01T10:00:00Z' } = {}) {
  return {
    sha,
    commit: { message, author: { name: 'Alice', email: 'alice@example.com', date }, committer: null },
    author: login ? { login } : null,
    committer: null,
  };
}

// ---------- trailers ----------

test('trailers are read from the final block only, so a body line is not a trailer', () => {
  const message = 'Fix the parser\n\nNote: this looked like a trailer but is prose.\n\nSigned-off-by: Alice <a@e.com>';
  assert.deepEqual(trailerKeys(message), ['signed-off-by']);
});

test('a message with no trailer block yields no trailers', () => {
  assert.deepEqual(trailerKeys('Just a subject line'), []);
});

test('several trailers in one block are all captured, lowercased', () => {
  const message = 'Subject\n\nSigned-off-by: A <a@e.com>\nCo-Authored-By: Claude <noreply@anthropic.com>';
  assert.deepEqual(trailerKeys(message), ['signed-off-by', 'co-authored-by']);
});

// ---------- AI attribution ----------

test('an agent co-author line is reported verbatim so an observation can quote it', () => {
  const lines = aiAttributionLines('Subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.deepEqual(lines, ['Co-Authored-By: Claude <noreply@anthropic.com>']);
});

test('a generated-with footer counts even though it is not a git trailer', () => {
  const lines = aiAttributionLines('Subject\n\nGenerated with Some Agent');
  assert.equal(lines.length, 1);
});

test('an ordinary human commit produces no attribution', () => {
  assert.deepEqual(aiAttributionLines('Fix off-by-one in the pager\n\nSigned-off-by: Alice <a@e.com>'), []);
});

// ---------- summary ----------

test('DCO holds only when every commit is signed off', () => {
  const signed = 'Subject\n\nSigned-off-by: Alice <a@e.com>';
  assert.equal(summarizeCommits([commit(signed), commit(signed, { sha: 'b' })], false).signedOff, true);
  assert.equal(summarizeCommits([commit(signed), commit('Subject', { sha: 'b' })], false).signedOff, false);
});

test('an unreadable commit list is not reported as DCO-compliant', () => {
  // Vacuous truth here would claim compliance for a PR whose commits never loaded.
  assert.equal(summarizeCommits([], false).signedOff, false);
});

test('distinct authors count linked logins, falling back to the commit email', () => {
  const commits = [
    commit('a', { sha: '1', login: 'alice' }),
    commit('b', { sha: '2', login: 'alice' }),
    commit('c', { sha: '3', login: 'bob' }),
  ];
  assert.equal(summarizeCommits(commits, false).distinctAuthors, 2);
});

test('span is null for a single commit and measured in minutes otherwise', () => {
  assert.equal(summarizeCommits([commit('a')], false).spanMinutes, null);
  const spread = [
    commit('a', { sha: '1', date: '2026-07-01T10:00:00Z' }),
    commit('b', { sha: '2', date: '2026-07-01T10:45:00Z' }),
  ];
  assert.equal(summarizeCommits(spread, false).spanMinutes, 45);
});

test('a commit with an unparseable date does not poison the span', () => {
  const commits = [
    commit('a', { sha: '1', date: 'not-a-date' }),
    commit('b', { sha: '2', date: '2026-07-01T10:00:00Z' }),
    commit('c', { sha: '3', date: '2026-07-01T10:30:00Z' }),
  ];
  assert.equal(summarizeCommits(commits, false).spanMinutes, 30);
});

// ---------- standing ----------

test('a first-timer maps to first_time_contributor under both GitHub spellings', () => {
  assert.equal(toStanding('FIRST_TIME_CONTRIBUTOR'), 'first_time_contributor');
  assert.equal(toStanding('FIRST_TIMER'), 'first_time_contributor');
});

test('a missing association is unknown, never none', () => {
  // NONE means "GitHub says outsider"; absent means "GitHub did not say".
  assert.equal(toStanding(undefined), 'unknown');
  assert.equal(toStanding('NONE'), 'none');
});

test('a bot account type wins over whatever association GitHub reported', () => {
  assert.equal(toStanding('CONTRIBUTOR', 'Bot'), 'bot');
});

test('agent branch prefixes are recognised case-insensitively, others are not', () => {
  assert.equal(agentBranchPrefix('Codex/add-thing'), 'codex/');
  assert.equal(agentBranchPrefix('feature/add-thing'), null);
});

// ---------- gathering ----------

const PR = { number: 7, author: 'alice', headRef: 'feature/x' };

function clientWith(overrides = {}) {
  return {
    pull: async () => ({ author_association: 'CONTRIBUTOR' }),
    prCommits: async () => ({ commits: [commit('Subject')], truncated: false }),
    user: async () => ({ type: 'User', created_at: '2020-01-01T00:00:00Z', public_repos: 12, followers: 3 }),
    ...overrides,
  };
}

test('a total GitHub outage yields null rather than a half-empty record', async () => {
  const dead = async () => {
    throw new Error('network down');
  };
  const result = await gatherProvenance(clientWith({ pull: dead, prCommits: dead, user: dead }), 'o/n', PR);
  assert.equal(result, null);
});

test('one failing call degrades its own fields and leaves the rest intact', async () => {
  const result = await gatherProvenance(
    clientWith({
      user: async () => {
        throw new Error('404');
      },
    }),
    'o/n',
    PR,
  );
  assert.equal(result.accountAgeDays, null);
  assert.equal(result.publicRepos, null);
  assert.equal(result.standing, 'contributor');
  assert.equal(result.commits.length, 1);
});

test('an unreachable GitHub tells the agent to report no provenance signal', () => {
  const section = provenanceSection(null);
  assert.match(section, /UNAVAILABLE/);
  assert.match(section, /Do not report any provenance signal/);
});

test('unknown standing is rendered as an instruction not to infer', () => {
  const section = provenanceSection({
    authorLogin: 'alice',
    standing: 'unknown',
    accountAgeDays: null,
    publicRepos: null,
    followers: null,
    commits: [],
    commitsTruncated: false,
    aiTrailers: [],
    signedOff: false,
    distinctAuthors: 0,
    spanMinutes: null,
    branchAgentPrefix: null,
  });
  assert.match(section, /do not infer/i);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ForbiddenGithubEdit,
  issueNamesPath,
  pathsFromDiff,
  unnamedGithubPaths,
} from '../dist/api/github-path-guard.js';

test('a fix_ci diff under .github is rejected unless the issue named that path', () => {
  const diff = [
    'diff --git a/.github/workflows/review-dispatch.yml b/.github/workflows/review-dispatch.yml',
    'index 111..222 100644',
    '--- a/.github/workflows/review-dispatch.yml',
    '+++ b/.github/workflows/review-dispatch.yml',
  ].join('\n');
  const issue = 'Relevant files:\n- agents/rules/model-routing.md';
  assert.deepEqual(pathsFromDiff(diff), ['.github/workflows/review-dispatch.yml']);
  assert.equal(issueNamesPath(issue, '.github/workflows/review-dispatch.yml'), false);
  assert.deepEqual(
    unnamedGithubPaths(pathsFromDiff(diff), issue),
    ['.github/workflows/review-dispatch.yml'],
  );
  const err = new ForbiddenGithubEdit(unnamedGithubPaths(pathsFromDiff(diff), issue));
  assert.equal(err.name, 'ForbiddenGithubEdit');
});

test('naming the workflow path in the issue allows the edit', () => {
  const paths = ['.github/workflows/review-dispatch.yml'];
  const issue = 'Relevant files:\n- .github/workflows/review-dispatch.yml';
  assert.deepEqual(unnamedGithubPaths(paths, issue), []);
});

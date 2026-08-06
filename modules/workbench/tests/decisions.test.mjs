import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDecisionItems } from '../dist/api/workbench-service.js';

const boardConfig = (autoMerge) => ({ autoMerge });

test('deduplicates Board-owned active runs and reviews while preserving separate decisions', () => {
  const items = buildDecisionItems({
    workspaceId: 'ws-1',
    boardConfig: boardConfig(true),
    tasks: [
      {
        id: 'task-merge',
        repo: 'acme/app',
        sourceIssueNumber: 3,
        automationPolicy: null,
        title: 'Ship the fix',
        status: 'in_review',
        stage: 'awaiting_merge',
        runId: 'run-owned',
        prNumber: 7,
        reviewRisk: 'medium',
        reviewRecommendation: 'comment',
        attempts: 1,
        lastError: null,
        updatedAt: 30,
      },
      {
        id: 'task-review',
        repo: 'acme/app',
        sourceIssueNumber: null,
        automationPolicy: null,
        title: 'Review in progress',
        status: 'in_review',
        stage: 'reviewing',
        runId: null,
        prNumber: 9,
        reviewRisk: null,
        reviewRecommendation: null,
        attempts: 1,
        lastError: null,
        updatedAt: 35,
      },
      {
        id: 'task-failed',
        repo: 'acme/app',
        sourceIssueNumber: null,
        automationPolicy: null,
        title: 'Repair checkout',
        status: 'failed',
        stage: null,
        runId: null,
        prNumber: null,
        reviewRisk: null,
        reviewRecommendation: null,
        attempts: 2,
        lastError: 'verification failed',
        updatedAt: 50,
      },
    ],
    runs: [
      { id: 'run-owned', repo: 'acme/app', title: 'Owned run', updatedAt: 1 },
      { id: 'run-free', repo: 'acme/app', title: 'Free run', updatedAt: 10 },
    ],
    prs: [
      { repo: 'acme/app', number: 8, title: 'Free PR', reviewRisk: 'low', updatedAt: 20 },
      { repo: 'acme/app', number: 9, title: 'Board review', reviewRisk: 'medium', updatedAt: 2 },
    ],
    issues: [
      { repo: 'acme/app', number: 3, title: 'Owned issue', updatedAt: 3 },
      { repo: 'acme/app', number: 4, title: 'Free issue', updatedAt: 40 },
    ],
  });

  assert.deepEqual(
    items.map((item) => item.id),
    [
      'board:task-failed:failure',
      'board:task-merge:merge',
      'run:run-free:review',
      'pr:acme/app#8:review',
      'issue:acme/app#3:triage',
      'issue:acme/app#4:triage',
    ],
  );
});

test('does not ask for a merge decision Board may complete autonomously', () => {
  const items = buildDecisionItems({
    workspaceId: 'ws-1',
    boardConfig: boardConfig(true),
    tasks: [
      {
        id: 'task-auto',
        repo: 'acme/app',
        sourceIssueNumber: null,
        automationPolicy: null,
        title: 'Safe automatic merge',
        status: 'in_review',
        stage: 'awaiting_merge',
        runId: null,
        prNumber: 9,
        reviewRisk: 'low',
        reviewRecommendation: 'approve',
        attempts: 0,
        lastError: null,
        updatedAt: 20,
      },
    ],
    runs: [],
    prs: [],
    issues: [],
  });

  assert.deepEqual(items, []);
});

test('publishes a pending PR review before offering the linked Board merge', () => {
  const items = buildDecisionItems({
    workspaceId: 'ws-1',
    boardConfig: boardConfig(false),
    tasks: [
      {
        id: 'task-waiting',
        repo: 'acme/app',
        sourceIssueNumber: null,
        automationPolicy: null,
        title: 'Pending publication',
        status: 'in_review',
        stage: 'awaiting_merge',
        runId: null,
        prNumber: 9,
        reviewRisk: 'medium',
        reviewRecommendation: 'approve',
        attempts: 1,
        lastError: null,
        updatedAt: 20,
      },
    ],
    runs: [],
    prs: [{ repo: 'acme/app', number: 9, title: 'Pending review', reviewRisk: 'medium', updatedAt: 10 }],
    issues: [],
  });

  assert.deepEqual(items.map((item) => item.id), ['pr:acme/app#9:review']);
});

test('does not let a historical Board row hide a current decision', () => {
  const items = buildDecisionItems({
    workspaceId: 'ws-1',
    boardConfig: boardConfig(false),
    tasks: [
      {
        id: 'task-done',
        repo: 'acme/app',
        sourceIssueNumber: null,
        automationPolicy: null,
        title: 'Already completed',
        status: 'done',
        stage: null,
        runId: 'run-reused',
        prNumber: 12,
        reviewRisk: null,
        reviewRecommendation: null,
        attempts: 1,
        lastError: null,
        updatedAt: 1,
      },
    ],
    runs: [{ id: 'run-reused', repo: 'acme/app', title: 'Current review', updatedAt: 20 }],
    prs: [{ repo: 'acme/app', number: 12, title: 'Current PR review', reviewRisk: null, updatedAt: 10 }],
    issues: [],
  });

  assert.deepEqual(items.map((item) => item.id), ['run:run-reused:review', 'pr:acme/app#12:review']);
});

test('orders older decisions first within the same priority', () => {
  const items = buildDecisionItems({
    workspaceId: 'ws-1',
    boardConfig: null,
    tasks: [],
    runs: [
      { id: 'newer', repo: 'acme/app', title: 'Newer', updatedAt: 20 },
      { id: 'older', repo: 'acme/api', title: 'Older', updatedAt: 10 },
    ],
    prs: [],
    issues: [],
  });

  assert.deepEqual(items.map((item) => item.subject), [
    { type: 'run', id: 'older', repo: 'acme/api' },
    { type: 'run', id: 'newer', repo: 'acme/app' },
  ]);
});

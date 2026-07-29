import assert from 'node:assert/strict';
import test from 'node:test';
import { isQueueStalled } from '../dist/api/orchestrator.js';

const NOW = 1_800_000_000_000;
const STALL = 30 * 60_000;

const state = (over) => ({ oldestEnqueuedAt: null, activeRuns: 0, stallMs: STALL, now: NOW, ...over });

test('an empty queue is never stalled', () => {
  assert.equal(isQueueStalled(state({ oldestEnqueuedAt: null })), false);
});

test('a queue that is draining is busy, not stalled, however long the wait', () => {
  // This is the case that must never alert: the scheduler is working, the line
  // is just long. Alerting here would train people to ignore the alert.
  assert.equal(
    isQueueStalled(state({ oldestEnqueuedAt: NOW - 10 * 60 * 60_000, activeRuns: 1 })),
    false,
  );
});

test('work waiting while nothing runs is stalled once it passes the threshold', () => {
  assert.equal(isQueueStalled(state({ oldestEnqueuedAt: NOW - STALL, activeRuns: 0 })), true);
});

test('a fresh queue entry with nothing running is not yet a stall', () => {
  // Normal: an entry is enqueued a moment before its run is dispatched.
  assert.equal(isQueueStalled(state({ oldestEnqueuedAt: NOW - 60_000, activeRuns: 0 })), false);
});

test('the threshold is inclusive, so the boundary does not fall in a gap', () => {
  assert.equal(isQueueStalled(state({ oldestEnqueuedAt: NOW - STALL + 1 })), false);
  assert.equal(isQueueStalled(state({ oldestEnqueuedAt: NOW - STALL })), true);
});

test('a clock that jumped backwards does not report a stall', () => {
  // now < enqueuedAt yields a negative age; it must read as "not yet", never
  // wrap into a true.
  assert.equal(isQueueStalled(state({ oldestEnqueuedAt: NOW + 60_000 })), false);
});

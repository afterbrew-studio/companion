import assert from 'node:assert/strict';
import test from 'node:test';

import { captureTerminal, withTerminal } from '../dist/terminal.js';

async function observeConsole(run) {
  const observed = [];
  const original = console.warn;
  console.warn = (...args) => observed.push(args.join(' '));
  try {
    await run(observed);
  } finally {
    console.warn = original;
  }
}

test('captureTerminal holds output until explicitly replayed', async () => {
  await observeConsole(async (observed) => {
    const captured = await captureTerminal(async () => {
      console.warn('hidden during startup');
      return 42;
    });

    assert.equal(captured.value, 42);
    assert.deepEqual(observed, []);
    captured.replay();
    assert.deepEqual(observed, ['hidden during startup']);
  });
});

test('captureTerminal replays diagnostics when the operation fails', async () => {
  await observeConsole(async (observed) => {
    await assert.rejects(
      captureTerminal(async () => {
        console.warn('startup failed');
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(observed, ['startup failed']);
  });
});

test('withTerminal retains its prompt behavior', async () => {
  await observeConsole(async (observed) => {
    const value = await withTerminal(async () => {
      console.warn('during prompt');
      return 'done';
    });

    assert.equal(value, 'done');
    assert.deepEqual(observed, ['during prompt']);
  });
});

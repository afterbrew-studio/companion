import assert from 'node:assert/strict';
import test from 'node:test';
import { safeToolEnvironment } from '../dist/exec/tool-exec.js';

test('a tool receives runtime basics but not unrelated daemon credentials', () => {
  const environment = safeToolEnvironment({
    PATH: '/usr/bin',
    HOME: '/srv/companion',
    HTTPS_PROXY: 'https://proxy.example',
    GITHUB_TOKEN: 'github-secret',
    OPENAI_API_KEY: 'model-secret',
    COMPANION_SESSION_SECRET: 'session-secret',
    NODE_OPTIONS: '--require /tmp/inject.js',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    HOME: '/srv/companion',
    HTTPS_PROXY: 'https://proxy.example',
  });
});

test('an explicit overlay is added on top of the allow-list, not filtered by it', () => {
  const environment = safeToolEnvironment({ PATH: '/usr/bin', GITHUB_TOKEN: 'leak' }, { CODERABBIT_API_KEY: 'k' });

  assert.deepEqual(environment, { PATH: '/usr/bin', CODERABBIT_API_KEY: 'k' });
});

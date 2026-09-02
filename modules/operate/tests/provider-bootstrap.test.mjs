import assert from 'node:assert/strict';
import test from 'node:test';
import * as gatewayPool from '../dist/exec/gateway-pool.js';
import * as home from '../dist/exec/home.js';

const flowConfig = `{
  provider: { name: openai-codex, model: gpt-5.6-terra },
  plugins:
    {
      provider: { default: openai-codex },
      packages: { "@moxxy/plugin-self-update": { enabled: true } }
    }
}`;

test('flow-style moxxy config exposes the active provider and model', () => {
  assert.deepEqual(home.providerNamesFromConfigYaml(flowConfig), ['openai-codex']);
  assert.deepEqual(home.providerDefaultsFromConfigYaml?.(flowConfig), {
    name: 'openai-codex',
    model: 'gpt-5.6-terra',
  });
});

test('block-style config prefers provider.name and includes provider plugin items', () => {
  const config = `
provider:
  name: anthropic
  model: claude-sonnet
plugins:
  provider:
    default: openai-codex
    items:
      openai-codex:
      anthropic:
`;

  assert.deepEqual(home.providerNamesFromConfigYaml(config), ['anthropic', 'openai-codex']);
  assert.deepEqual(home.providerDefaultsFromConfigYaml?.(config), {
    name: 'anthropic',
    model: 'claude-sonnet',
  });
});

test('plugin default is a usable fallback when provider.name is absent', () => {
  const config = `
plugins:
  provider:
    default: openai-codex
`;

  assert.deepEqual(home.providerDefaultsFromConfigYaml?.(config), {
    name: 'openai-codex',
    model: null,
  });
});

test('per-run config carries provider defaults without changing the imported config', () => {
  const config = gatewayPool.gatewayConfigYaml?.(50176, '/tmp/companion skills', {
    name: 'openai-codex',
    model: 'gpt-5.6-terra',
  });

  assert.equal(
    config,
    `provider:\n  name: "openai-codex"\n  model: "gpt-5.6-terra"\nchannels:\n  mobile:\n    port: 50176\nskills:\n  userDir: "/tmp/companion skills"\n`,
  );
});

test('per-run config stays provider-agnostic when no default is configured', () => {
  const config = gatewayPool.gatewayConfigYaml?.(50176, '/tmp/skills', null);

  assert.equal(config, `channels:\n  mobile:\n    port: 50176\nskills:\n  userDir: "/tmp/skills"\n`);
});

test('an unrouted model keeps the configured provider', () => {
  const defaults = { name: 'zai-coding-plan', model: 'glm-5.3' };
  const routes = home.providerRoutesFromJson('{"MiniMax-M3":"openai"}');
  assert.deepEqual(home.providerForModel(defaults, routes, 'glm-5.3'), {
    name: 'zai-coding-plan',
    model: 'glm-5.3',
  });
});

test('a routed model starts the run under its own vendor', () => {
  const defaults = { name: 'zai-coding-plan', model: 'glm-5.3' };
  const routes = home.providerRoutesFromJson('{"MiniMax-M3":"openai","MiniMax-M2.7":"openai"}');
  assert.deepEqual(home.providerForModel(defaults, routes, 'MiniMax-M3'), {
    name: 'openai',
    model: 'MiniMax-M3',
  });
});

test('a run with no model of its own keeps the configured defaults', () => {
  const defaults = { name: 'zai-coding-plan', model: 'glm-5.3' };
  assert.deepEqual(home.providerForModel(defaults, new Map(), null), defaults);
});

test('a malformed or absent routing table falls back to the default', () => {
  const defaults = { name: 'zai-coding-plan', model: 'glm-5.3' };
  for (const table of [null, 'not json', '[]', '{"MiniMax-M3":42}']) {
    const routes = home.providerRoutesFromJson(table);
    assert.deepEqual(home.providerForModel(defaults, routes, 'MiniMax-M3'), {
      name: 'zai-coding-plan',
      model: 'glm-5.3',
    });
  }
});

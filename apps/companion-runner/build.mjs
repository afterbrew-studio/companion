import { build } from 'esbuild';

/**
 * Bundle the agent into a single self-contained ESM file so the published
 * `@moxxy/companion-runner` package runs on any box with just Node + the moxxy
 * CLI — no Companion monorepo checkout. The companiond execution modules it
 * reuses (GatewayPool, Checkouts, session history, …) and the shared contract
 * are inlined; only `ws` stays an external runtime dependency.
 */
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // `ws` has an optional native/CJS surface — leave it as a real dependency.
  external: ['ws'],
  // A CLI: executable shebang + ESM shims for any require/__dirname interop.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __f } from 'url';",
      "import { dirname as __d } from 'path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __f(import.meta.url);',
      'const __dirname = __d(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

/**
 * The built-in runtime's child process, beside the agent bundle. It cannot be
 * inlined: it IS a separate process, spawned by path, and a runner that shipped
 * without it would advertise a runtime it cannot start.
 */
await build({
  entryPoints: ['../../packages/runtime/src/child/main.ts'],
  outfile: 'dist/agent.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __f } from 'url';",
      "import { dirname as __d } from 'path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __f(import.meta.url);',
      'const __dirname = __d(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

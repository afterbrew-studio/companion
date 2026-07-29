import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dist = join(here, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const nodeBanner = [
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __f } from 'node:url';",
  "import { dirname as __d } from 'node:path';",
  'const require = __cr(import.meta.url);',
  'const __filename = __f(import.meta.url);',
  'const __dirname = __d(__filename);',
].join('\n');

await build({
  entryPoints: {
    index: join(here, 'src/index.ts'),
    setup: join(here, 'src/setup.ts'),
    github: join(here, 'src/github.ts'),
    modules: join(here, 'src/modules.ts'),
    acl: join(here, 'src/acl.ts'),
    client: join(here, 'src/client.ts'),
    repair: join(here, 'src/repair.ts'),
    backup: join(here, 'src/backup.ts'),
    runs: join(here, 'src/runs.ts'),
    profile: join(here, 'src/profile.ts'),
    harnesses: join(here, 'src/harnesses.ts'),
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // The package's declared runtime dependencies, and nothing else: everything
  // that is not one is inlined. SQLite is `node:sqlite`, so none of them is native.
  external: ['@inquirer/prompts', 'undici'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

await build({
  entryPoints: [join(root, 'apps/api/src/index.ts')],
  outfile: join(dist, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['ws', 'undici'],
  banner: { js: nodeBanner },
  // Contract-only imports register TypeScript interfaces and intentionally
  // have no runtime side effects; keep the publish build output readable.
  logOverride: { 'ignored-bare-import': 'silent' },
  logLevel: 'info',
});

cpSync(join(root, 'apps/web/dist'), join(dist, 'web'), { recursive: true });
chmodSync(join(dist, 'index.js'), 0o755);

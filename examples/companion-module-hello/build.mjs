import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
rmSync(dist, { recursive: true, force: true });

// The ABI stays external so every import resolves to the host's single copy at
// load time. Anything not on the allowlist would have to be bundled in instead.
await build({
  entryPoints: {
    module: join(here, 'src/module.ts'),
    api: join(here, 'src/api/index.ts'),
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['@moxxy/companion-sdk', '@moxxy/companion-sdk/*', 'zod', 'ws'],
  logLevel: 'info',
});

// Production build on purpose: the host's import map has no react/jsx-dev-runtime
// entry, so a dev-mode chunk fails to resolve instead of shipping React's
// development runtime to a production page.
await build({
  entryPoints: { client: join(here, 'src/client/index.tsx') },
  outdir: dist,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  external: [
    '@moxxy/companion-sdk',
    '@moxxy/companion-sdk/client',
    '@moxxy/companion-sdk/ui',
    'react',
    'react/jsx-runtime',
    'react-dom',
  ],
  logLevel: 'info',
});

import { join } from 'node:path';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Bare specifiers an out-of-tree module chunk may import, and the URL each
 * resolves to. One place, because it is three things at once: the import map
 * the browser gets, the extra entry points this build emits, and the allowlist
 * `companion module verify` enforces.
 */
const HOST_MODULES = {
  react: 'react',
  'react/jsx-runtime': 'jsx-runtime',
  'react-dom': 'react-dom',
  '@moxxy-ai/companion-sdk': 'sdk',
  '@moxxy-ai/companion-sdk/client': 'sdk-client',
  '@moxxy-ai/companion-sdk/ui': 'sdk-ui',
} as const;

const hostEntries = Object.fromEntries(
  Object.values(HOST_MODULES).map((name) => [`host-${name}`, join(import.meta.dirname, `src/host/${name}.ts`)]),
);

/**
 * Emit the import map that lets a prebuilt module chunk share the app's React
 * and SDK instances.
 *
 * It has to be in the document before any module script runs. In dev it points
 * at source, which Vite serves and transforms into the same module graph; in a
 * build it points at the fixed `/host/*.js` entry names. Those are unhashed on
 * purpose: a module compiled months ago cannot be asked to know this release's
 * chunk hashes, and the import map is the only indirection that fixes it.
 */
function importMap(): Plugin {
  return {
    name: 'companion-host-import-map',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        const dev = !!ctx.server;
        const imports = Object.fromEntries(
          Object.entries(HOST_MODULES).map(([spec, name]) => [
            spec,
            dev ? `/src/host/${name}.ts` : `/host/${name}.js`,
          ]),
        );
        return [
          {
            tag: 'script',
            attrs: { type: 'importmap' },
            children: JSON.stringify({ imports }, null, 2),
            injectTo: 'head-prepend' as const,
          },
        ];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), importMap()],
  resolve: {
    // Workspace packages resolve to their TypeScript sources (no prebuild step
    // for client code); setting conditions REPLACES Vite's defaults, so keep them.
    conditions: ['source', ...defaultClientConditions],
  },
  build: {
    rollupOptions: {
      input: { index: join(import.meta.dirname, 'index.html'), ...hostEntries },
      // Without this Rollup treats an entry's exports as internal and renames
      // them, so `/host/react.js` ends up exporting `r` instead of `useState`.
      // The host entries exist for consumers it cannot see, so their signatures
      // are the contract.
      preserveEntrySignatures: 'strict',
      output: {
        // Only the host entries get stable names; app chunks stay hashed so
        // they can be cached forever.
        entryFileNames: (chunk) =>
          chunk.name.startsWith('host-')
            ? `host/${chunk.name.slice('host-'.length)}.js`
            : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8901', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8901', ws: true },
      // Out-of-tree module chunks are served by the daemon in dev too, so a
      // module can be developed against `pnpm dev` and not only a built SPA.
      '/modules': { target: 'http://127.0.0.1:8901', changeOrigin: false },
    },
  },
});

import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Workspace packages resolve to their TypeScript sources (no prebuild step
    // for client code); setting conditions REPLACES Vite's defaults, so keep them.
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8901', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8901', ws: true },
    },
  },
});

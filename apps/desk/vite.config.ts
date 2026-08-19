import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = process.env.COMPANION_API_URL?.trim() || 'http://127.0.0.1:8901';

export default defineConfig({
  base: '/desk/',
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
});

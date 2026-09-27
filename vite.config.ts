import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  root: 'web',
  publicDir: '../public',
  server: {
    host: '127.0.0.1',
    port: Number(process.env.ATHLENTRY_VITE_PORT ?? '5173'),
    strictPort: true,
    ...(process.env.ATHLENTRY_E2E_HTTPS === '1'
      ? {
          https: {
            key: readFileSync(resolve('data/dev-localhost.key')),
            cert: readFileSync(resolve('data/dev-localhost.crt')),
          },
        }
      : {}),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.ATHLENTRY_API_PORT ?? '3001'}`,
      '/healthz': `http://127.0.0.1:${process.env.ATHLENTRY_API_PORT ?? '3001'}`,
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'assets/app-[hash].js' } },
  },
});

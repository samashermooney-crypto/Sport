import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import { aiFeatureFlag } from './web/src/config/ai-feature';

export default defineConfig(({ mode }) => {
  const environment = {
    ...loadEnv(mode, process.cwd(), ''),
    ...process.env,
  };
  return {
    define: {
      'import.meta.env.VITE_AI_ENABLED': JSON.stringify(
        aiFeatureFlag(environment),
      ),
    },
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
        // Production renders published organization pages through the API's
        // SSR router. Mirror that in development; explicit app=1 requests are
        // the interactive SPA routes and must remain with Vite.
        // Keep this slash boundary so `/site.css` continues to be served by
        // Vite's public directory instead of reaching the SSR API router.
        '/site/': {
          target: `http://127.0.0.1:${process.env.ATHLENTRY_API_PORT ?? '3001'}`,
          bypass: (request) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const pathSegments = url.pathname.split('/').filter(Boolean);
            // The API renders only the public organization home in this dev
            // proxy. Nested content routes stay in Vite's SPA router, where
            // crawler journeys can exercise the same interactive pages.
            if (
              url.searchParams.get('app') === '1' ||
              pathSegments.length !== 2
            )
              return request.url;
          },
        },
      },
    },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'assets/app-[hash].js' } },
    },
  };
});

import { defineConfig } from 'vitest/config';

const alias = {
  '@shared': new URL('./shared/src', import.meta.url).pathname,
  '@server': new URL('./server/src', import.meta.url).pathname,
  '@web': new URL('./web/src', import.meta.url).pathname,
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'server',
          include: ['server/src/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['server/test/global-setup.ts'],
          setupFiles: ['server/test/setup.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'web',
          include: ['web/src/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
  resolve: { alias },
});

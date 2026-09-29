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
          name: 'shared',
          include: ['shared/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'server',
          include: ['server/{src,test}/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15_000,
          hookTimeout: 30_000,
          sequence: { hooks: 'stack' },
          globalSetup: ['server/test/global-setup.ts'],
          setupFiles: ['server/test/setup.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'web',
          include: ['web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
    ],
  },
  resolve: { alias },
});

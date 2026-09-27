import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

interface OpenApiOperation {
  operationId?: string;
  'x-athlentry-resource'?: string;
  'x-athlentry-scope'?: string;
  'x-athlentry-tenancy-fixture'?: string;
}
interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

test.fixme('SEC-002 / Track C: foreign organization ids return 404 for every id-bearing GET, PATCH, and DELETE route', async () => {
  const document = JSON.parse(
    await readFile(
      new URL('../../docs/api/openapi.json', import.meta.url),
      'utf8',
    ),
  ) as OpenApiDocument;
  const uncovered: string[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    if (!path.startsWith('/api/v1/') || !/\{[^}]+\}/.test(path)) continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'patch', 'delete'].includes(method)) continue;
      if (
        !operation.operationId ||
        !operation['x-athlentry-resource'] ||
        !operation['x-athlentry-scope'] ||
        !operation['x-athlentry-tenancy-fixture']
      ) {
        uncovered.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  expect(uncovered).toEqual([]);
});

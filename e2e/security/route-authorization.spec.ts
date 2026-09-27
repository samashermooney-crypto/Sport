import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

interface OpenApiOperation {
  operationId?: string;
  'x-athlentry-permission'?: string;
  'x-athlentry-resource'?: string;
  'x-athlentry-scope'?: string;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

async function readOpenApi(): Promise<OpenApiDocument> {
  const source = await readFile(
    new URL('../../docs/api/openapi.json', import.meta.url),
    'utf8',
  );
  return JSON.parse(source) as OpenApiDocument;
}

test.fixme('SEC-002 / Track C: every API operation declares permission, resource, and scope metadata', async () => {
  const document = await readOpenApi();
  const missing: string[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    if (!path.startsWith('/api/v1/')) continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation.operationId) continue;
      if (
        !operation['x-athlentry-permission'] ||
        !operation['x-athlentry-resource'] ||
        !operation['x-athlentry-scope']
      ) {
        missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  expect(missing).toEqual([]);
});

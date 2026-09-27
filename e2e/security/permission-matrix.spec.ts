import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

const expectedRoles = [
  'anonymous',
  'owner',
  'admin',
  'registrar',
  'finance',
  'scheduler',
  'compliance',
  'communications',
  'director',
  'evaluator',
  'volunteer_coordinator',
  'reporter',
  'guardian',
  'self',
  'head_coach',
  'assistant_coach',
  'team_manager',
  'treasurer',
  'official',
  'volunteer',
  'platform_super_admin',
  'platform_support',
  'platform_finance_ops',
];

interface OpenApiOperation {
  operationId?: string;
}
interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}
interface PermissionMatrix {
  formatVersion: number;
  roles: string[];
  operations: Record<string, { allow: string[]; deny: string[] }>;
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, 'utf8')) as T;
}

test.fixme('SEC-002 / Track C: permission matrix covers every generated API operation and role', async () => {
  const [document, matrix] = await Promise.all([
    readJson<OpenApiDocument>(
      new URL('../../docs/api/openapi.json', import.meta.url),
    ),
    readJson<PermissionMatrix>(
      new URL(
        '../../server/test/security/permission-matrix.json',
        import.meta.url,
      ),
    ),
  ]);
  const operations = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .flatMap((operation) => operation.operationId ?? []);
  expect(matrix.formatVersion).toBe(1);
  expect(matrix.roles).toEqual(expectedRoles);
  expect(Object.keys(matrix.operations).sort()).toEqual(operations.sort());
  for (const operationId of operations) {
    const row = matrix.operations[operationId];
    if (!row) throw new Error(`Missing permission row for ${operationId}`);
    expect([...row.allow, ...row.deny].sort()).toEqual(expectedRoles);
    expect(row.allow.filter((role) => row.deny.includes(role))).toEqual([]);
  }
});

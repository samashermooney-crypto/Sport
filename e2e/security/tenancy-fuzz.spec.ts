import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const tenantScopes = new Set(['org', 'organization', 'tenant']);

interface OpenApiOperation {
  operationId?: string;
  'x-athlentry-permission'?: string;
  'x-athlentry-resource'?: string;
  'x-athlentry-scope'?: string;
  'x-athlentry-tenancy-fixture'?: {
    body?: Record<string, unknown>;
  };
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

function operationPath(path: string, foreignOrgId: string): string {
  return path.replace(/\{([^}]+)\}/g, (_placeholder, name: string) => {
    const normalized = name.toLowerCase();
    if (['orgid', 'organizationid', 'tenantid'].includes(normalized))
      return foreignOrgId;
    if (normalized.includes('slug'))
      return `security-${randomUUID().slice(0, 8)}`;
    if (normalized.endsWith('id')) return randomUUID();
    return `security-${randomUUID().slice(0, 8)}`;
  });
}

test.fixme('SEC-002 / Track C: fuzz every id-bearing organization GET, PATCH, and DELETE with a foreign org ID and require 404', async ({
  request,
}) => {
  const document = JSON.parse(
    await readFile(
      new URL('../../docs/api/openapi.json', import.meta.url),
      'utf8',
    ),
  ) as OpenApiDocument;
  const uncovered: string[] = [];
  const organizationOperations: Array<{
    path: string;
    method: 'get' | 'patch' | 'delete';
    body?: Record<string, unknown>;
  }> = [];

  for (const [path, methods] of Object.entries(document.paths)) {
    if (!path.startsWith('/api/v1/') || !/\{[^}]+\}/.test(path)) continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'patch', 'delete'].includes(method)) continue;
      const fixture = operation['x-athlentry-tenancy-fixture'];
      const tenantScoped =
        operation['x-athlentry-scope'] !== undefined &&
        tenantScopes.has(operation['x-athlentry-scope']);
      if (
        !operation.operationId ||
        !operation['x-athlentry-permission'] ||
        !operation['x-athlentry-resource'] ||
        !operation['x-athlentry-scope'] ||
        (tenantScoped && (!fixture || (method !== 'get' && !fixture.body)))
      ) {
        uncovered.push(`${method.toUpperCase()} ${path}`);
      }
      if (tenantScoped) {
        if (!/\{(?:orgId|organizationId|tenantId)\}/i.test(path)) {
          uncovered.push(
            `${method.toUpperCase()} ${path}: missing tenant path parameter`,
          );
          continue;
        }
        organizationOperations.push({
          path,
          method: method as 'get' | 'patch' | 'delete',
          ...(fixture?.body ? { body: fixture.body } : {}),
        });
      }
    }
  }
  expect(uncovered).toEqual([]);
  expect(organizationOperations.length).toBeGreaterThan(0);

  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const ownOrganization = await factories.actor();
    const foreignOrganization = await factories.actor();
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: ownOrganization.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    const headers = {
      Cookie: `__Host-athlentry_session=${session.token}`,
      Origin: `https://127.0.0.1:${String(5173 + offset)}`,
      'X-Athlentry-Request': '1',
    };
    const apiBase = `http://127.0.0.1:${String(3001 + offset)}`;

    for (const { path, method, body } of organizationOperations) {
      const target = operationPath(path, foreignOrganization.orgId);
      const url = `${apiBase}${target}`;
      const response =
        method === 'get'
          ? await request.get(url, { headers })
          : method === 'patch'
            ? await request.patch(url, { headers, data: body })
            : await request.delete(url, { headers, data: body });
      expect(
        response.status(),
        `${path} must hide a foreign organization from ${ownOrganization.orgId}`,
      ).toBe(404);
    }
  } finally {
    await database.destroy();
  }
});

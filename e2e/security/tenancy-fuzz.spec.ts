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
  parameters?: Array<{
    name: string;
    in: string;
    schema?: Record<string, unknown>;
  }>;
  'x-athlentry-permission'?: string;
  'x-athlentry-resource'?: string;
  'x-athlentry-scope'?: string;
  'x-athlentry-tenancy-fixture'?: {
    body?: unknown;
    query?: Record<string, string>;
    pathResource?: 'file';
  };
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

function operationPath(
  path: string,
  foreignOrgId: string,
  pathResource?: 'file',
  foreignFileId?: string,
  parameters: OpenApiOperation['parameters'] = [],
): string {
  const pathParameters = new Map(
    parameters
      .filter((parameter) => parameter.in === 'path')
      .map((parameter) => [parameter.name, parameter.schema ?? {}]),
  );
  return path.replace(/\{([^}]+)\}/g, (_placeholder, name: string) => {
    const normalized = name.toLowerCase();
    if (pathResource === 'file' && normalized === 'id' && foreignFileId)
      return foreignFileId;
    if (['orgid', 'organizationid', 'tenantid'].includes(normalized))
      return foreignOrgId;
    if (normalized === 'year') return '2026';
    const schema = pathParameters.get(name);
    if (Array.isArray(schema?.enum) && typeof schema.enum[0] === 'string')
      return schema.enum[0];
    if (typeof schema?.pattern === 'string' && schema.pattern.includes('po_'))
      return 'po_tenant_fuzz';
    if (schema?.type === 'integer' || schema?.type === 'number')
      return String(typeof schema.minimum === 'number' ? schema.minimum : 2026);
    if (schema?.format === 'uuid') return randomUUID();
    if (normalized.includes('slug'))
      return `security-${randomUUID().slice(0, 8)}`;
    if (normalized.endsWith('id')) return randomUUID();
    return `security-${randomUUID().slice(0, 8)}`;
  });
}

test('SEC-002 / Track C: fuzz every id-bearing organization GET, PATCH, and DELETE with a foreign org ID and require 404', async ({
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
    body?: unknown;
    query?: Record<string, string>;
    pathResource?: 'file';
    parameters?: OpenApiOperation['parameters'];
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
        if (
          !/\{(?:orgId|organizationId|tenantId)\}/i.test(path) &&
          fixture?.pathResource !== 'file'
        ) {
          uncovered.push(
            `${method.toUpperCase()} ${path}: missing tenant path parameter`,
          );
          continue;
        }
        organizationOperations.push({
          path,
          method: method as 'get' | 'patch' | 'delete',
          ...(fixture?.body ? { body: fixture.body } : {}),
          ...(fixture?.query ? { query: fixture.query } : {}),
          ...(fixture?.pathResource
            ? { pathResource: fixture.pathResource }
            : {}),
          ...(operation.parameters ? { parameters: operation.parameters } : {}),
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
    await factories.row(ownOrganization, 'role_assignments', {
      id: randomUUID(),
      org_id: ownOrganization.orgId,
      account_id: ownOrganization.accountId,
      role: 'communications',
      scope_type: 'org',
      scope_id: null,
      granted_by: ownOrganization.accountId,
      revoked_at: null,
      pending_mfa: false,
    });
    const foreignFileId = randomUUID();
    await factories.row(foreignOrganization, 'files', {
      id: foreignFileId,
      org_id: foreignOrganization.orgId,
      purpose: 'document',
      owner_type: null,
      owner_id: null,
      storage_key: `security-fuzz/${foreignFileId}`,
      mime: 'application/pdf',
      bytes: 1,
      sha256: null,
      width: null,
      height: null,
      sensitivity: 'internal',
      created_by: foreignOrganization.accountId,
      upload_state: 'complete',
      deleted_at: null,
    });
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
    const violations: string[] = [];

    for (const {
      path,
      method,
      body,
      query,
      pathResource,
      parameters,
    } of organizationOperations) {
      const target = operationPath(
        path,
        foreignOrganization.orgId,
        pathResource,
        foreignFileId,
        parameters,
      );
      const queryString = new URLSearchParams(query ?? {}).toString();
      const url = `${apiBase}${target}${queryString ? `?${queryString}` : ''}`;
      const operationHeaders =
        pathResource === 'file'
          ? { ...headers, 'X-Athlentry-Org': ownOrganization.orgId }
          : headers;
      const response =
        method === 'get'
          ? await request.get(url, { headers: operationHeaders })
          : method === 'patch'
            ? await request.patch(url, {
                headers: operationHeaders,
                data: body,
              })
            : await request.delete(url, {
                headers: operationHeaders,
                data: body,
              });
      if (response.status() !== 404)
        violations.push(
          `${method.toUpperCase()} ${path}: ${String(response.status())} ${await response.text()}`,
        );
    }
    expect(violations).toEqual([]);
  } finally {
    await database.destroy();
  }
});

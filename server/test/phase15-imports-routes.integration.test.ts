import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { parseEncryptionKeys } from '../src/lib/crypto';
import { tenantGuard } from '../src/lib/tenant-guard';
import type { AuthDependencies } from '../src/modules/auth/routes';
import { issueSession } from '../src/modules/auth/sessions';
import { moduleDefinition as importsModule } from '../src/modules/imports/module';
import { runPhase15ImportJob } from '../src/modules/imports/phase15-jobs';
import { phase15ImportOpenApiRoutes } from '../src/modules/imports/phase15-openapi';
import type { ImportKind } from '../src/modules/imports/phase15-schema';
import { renderTemplate } from '../src/modules/imports/phase15-templates';

import { createTestFactories } from './factories';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-30T18:00:00.000Z');
const kinds: ImportKind[] = [
  'people',
  'households',
  'registrations',
  'teams',
  'rosters',
  'schedule',
  'facilities',
  'credentials',
  'historical_payments',
  'volunteer_hours',
];

let database: ReturnType<typeof createDatabase>;
let server: ReturnType<express.Express['listen']> | null = null;
let baseUrl = '';
let ownerOrgId = '';
let otherOrgId = '';
let ownerCookie = '';
let otherCookie = '';
let impersonationCookie = '';
let impersonationId = '';
const previousDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_APP_URL ?? process.env.TEST_DATABASE_URL;
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const other = await factories.actor();
  ownerOrgId = owner.orgId;
  otherOrgId = other.orgId;
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', owner.accountId)
      .execute()
      .then(() => undefined),
  );
  for (const [actor, setCookie, privileged] of [
    [owner, (value: string) => (ownerCookie = value), false],
    [owner, (value: string) => (impersonationCookie = value), true],
    [other, (value: string) => (otherCookie = value), false],
  ] as const) {
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged,
          ...(privileged ? { mfaVerifiedAt: now } : {}),
        },
        now,
      ),
    );
    setCookie(`__Host-athlentry_session=${session.token}`);
  }

  impersonationId = randomUUID();
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO platform_staff(account_id, role) VALUES ($1, $2)',
      [owner.accountId, 'support'],
    );
    await admin.query(
      `INSERT INTO platform_impersonations(id, staff_account_id, target_organization_id,
       reason, started_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        impersonationId,
        owner.accountId,
        ownerOrgId,
        'Reviewing an import support request',
        now,
        new Date(now.getTime() + 60 * 60_000),
      ],
    );
  } finally {
    await admin.end();
  }

  const dependencies = {
    database,
    encryption: parseEncryptionKeys(
      JSON.stringify({ test: randomBytes(32).toString('base64') }),
      'test',
    ),
    appUrl: origin,
    clock: () => now,
  } as AuthDependencies;
  const app = express();
  app.use('/api/v1', tenantGuard(dependencies));
  app.use(importsModule.path, importsModule.router(dependencies));
  for (const extra of importsModule.extraRouters)
    app.use(extra.path, extra.router(dependencies));
  app.use('/direct', (request, _response, next) => {
    if (request.get('X-Test-Import-Impersonation'))
      (
        request as express.Request & {
          impersonation?: { id: string; orgId: string; accountId: string };
        }
      ).impersonation = {
        id: impersonationId,
        orgId: ownerOrgId,
        accountId: '00000000-0000-4000-8000-000000000000',
      };
    next();
  });
  app.use(`/direct${importsModule.path}`, importsModule.router(dependencies));
  for (const extra of importsModule.extraRouters)
    app.use(`/direct${extra.path}`, extra.router(dependencies));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  const runningServer = server;
  if (runningServer)
    await new Promise<void>((resolve, reject) => {
      runningServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  await database.destroy();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

function get(path: string, cookie = ownerCookie): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
  });
}

function postJson(
  path: string,
  body: unknown,
  options: { cookie?: string; requestOrigin?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Cookie: options.cookie ?? ownerCookie,
      'Content-Type': 'application/json',
      Origin: options.requestOrigin ?? origin,
      'X-Athlentry-Request': '1',
    },
    body: JSON.stringify(body),
  });
}

function postCsv(
  path: string,
  body: string,
  requestOrigin = origin,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Cookie: ownerCookie,
      'Content-Type': 'text/csv',
      Origin: requestOrigin,
      'X-Athlentry-Request': '1',
    },
    body,
  });
}

describe('Phase 15 import HTTP contract', () => {
  it('serves templates and protects import routes by session, origin, and tenant', async () => {
    expect(importsModule.name).toBe('imports');
    expect(importsModule.path).toBe('/api/v1/imports');
    expect(importsModule.openapiRoutes.length).toBeGreaterThan(10);
    expect(phase15ImportOpenApiRoutes).toHaveLength(14);

    const unauthorized = await fetch(
      `${baseUrl}/api/v1/imports/orgs/${ownerOrgId}/phase15/batches`,
    );
    expect(unauthorized.status).toBe(401);

    const hidden = await get(
      `/api/v1/imports/orgs/${ownerOrgId}/phase15/batches`,
      otherCookie,
    );
    expect(hidden.status).toBe(404);

    const impersonatedRead = await fetch(
      `${baseUrl}/api/v1/imports/orgs/${ownerOrgId}/phase15/batches`,
      {
        headers: {
          Cookie: impersonationCookie,
          'X-Athlentry-Impersonation': impersonationId,
        },
      },
    );
    expect(impersonatedRead.status).toBe(200);
    const mismatchedImpersonationScope = await fetch(
      `${baseUrl}/api/v1/imports/orgs/${otherOrgId}/phase15/batches`,
      {
        headers: {
          Cookie: impersonationCookie,
          'X-Athlentry-Impersonation': impersonationId,
        },
      },
    );
    expect(mismatchedImpersonationScope.status).toBe(404);
    const impersonatedWrite = await fetch(
      `${baseUrl}/api/v1/imports/orgs/${ownerOrgId}/phase15/batches?kind=people&name=read-only.csv`,
      {
        method: 'POST',
        headers: {
          Cookie: impersonationCookie,
          'X-Athlentry-Impersonation': impersonationId,
          'Content-Type': 'text/csv',
          Origin: origin,
          'X-Athlentry-Request': '1',
        },
        body: 'First name,Last name\nCasey,Player',
      },
    );
    expect(impersonatedWrite.status).toBe(403);

    for (const kind of kinds) {
      const response = await fetch(
        `${baseUrl}/api/v1/imports/phase15/templates/${kind}.csv`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/csv');
      expect(response.headers.get('content-disposition')).toContain(
        `${kind}.csv`,
      );
      expect(await response.text()).toBe(renderTemplate(kind));
    }
    expect(
      (
        await fetch(
          `${baseUrl}/api/v1/imports/phase15/templates/not-a-kind.csv`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await get('/api/v1/imports/orgs/not-a-uuid/phase15/batches')).status,
    ).toBe(400);
    expect(
      (
        await get(
          `/api/v1/imports/orgs/${ownerOrgId}/phase15/presets?kind=unsupported`,
        )
      ).status,
    ).toBe(400);

    const kindsResponse = await get(
      `/api/v1/imports/orgs/${ownerOrgId}/phase15/kinds`,
    );
    expect(kindsResponse.status).toBe(200);
    const kindsBody = (await kindsResponse.json()) as {
      items: Array<{ kind: string; fields: Array<{ key: string }> }>;
    };
    expect(kindsBody.items.map((item) => item.kind)).toEqual(kinds);
    expect(
      kindsBody.items.find((item) => item.kind === 'people')?.fields,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'first_name' }),
        expect.objectContaining({ key: 'last_name' }),
      ]),
    );

    const invalidOrigin = await postCsv(
      `/api/v1/imports/orgs/${ownerOrgId}/phase15/batches?kind=people&name=members.csv`,
      'First name,Last name,Email\nJamie,Player,jamie@example.test',
      'https://attacker.example',
    );
    expect(invalidOrigin.status).toBe(403);

    const invalidKind = await postCsv(
      `/api/v1/imports/orgs/${ownerOrgId}/phase15/batches?kind=unknown&name=members.csv`,
      'First name,Last name,Email\nJamie,Player,jamie@example.test',
    );
    expect(invalidKind.status).toBe(400);
    const missingFilename = await postCsv(
      `/api/v1/imports/orgs/${ownerOrgId}/phase15/batches?kind=people`,
      'First name,Last name,Email\nJamie,Player,jamie@example.test',
    );
    expect(missingFilename.status).toBe(400);
    const unsupportedBody = await postJson(
      `/api/v1/imports/orgs/${ownerOrgId}/phase15/batches?kind=people&name=members.csv`,
      {
        content: 'First name,Last name,Email\nJamie,Player,jamie@example.test',
      },
    );
    expect(unsupportedBody.status).toBe(400);
  });

  it('uploads CSV, saves mappings and presets, and paginates rows', async () => {
    const upload = await fetch(
      `${baseUrl}/api/v1/imports/orgs/${ownerOrgId}/phase15/batches?kind=people&name=members.csv`,
      {
        method: 'POST',
        headers: {
          Cookie: ownerCookie,
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Content-Type': 'text/csv',
        },
        body: 'First name,Last name,Email\nJamie,Player,jamie@example.test\nAlex,Athlete,alex@example.test',
      },
    );
    expect(upload.status).toBe(201);
    const batch = (await upload.json()) as { id: string; rowCount: number };
    expect(batch.rowCount).toBe(2);

    const batchPath = `/api/v1/imports/orgs/${ownerOrgId}/phase15/batches/${batch.id}`;
    const detail = await get(batchPath);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: batch.id,
      kind: 'people',
      fileName: 'members.csv',
      status: 'uploaded',
      rowCount: 2,
    });
    expect(
      (
        await get(
          `/api/v1/imports/orgs/${ownerOrgId}/phase15/batches/not-a-uuid`,
        )
      ).status,
    ).toBe(400);

    const rowsPath = `${batchPath}/rows`;
    const invalidFilter = await get(`${rowsPath}?filter=unknown`);
    expect(invalidFilter.status).toBe(400);
    const firstPage = await get(`${rowsPath}?limit=1`);
    expect(firstPage.status).toBe(200);
    expect(await firstPage.json()).toMatchObject({
      items: [{ rowNumber: 1, raw: { 'First name': 'Jamie' } }],
      nextCursor: '1',
    });
    const nextPage = await get(`${rowsPath}?limit=1&cursor=1`);
    expect(await nextPage.json()).toMatchObject({
      items: [{ rowNumber: 2, raw: { 'First name': 'Alex' } }],
      nextCursor: null,
    });

    const missingRequired = await postJson(`${batchPath}/mapping`, {
      mapping: { columns: { 'First name': 'first_name' } },
    });
    expect(missingRequired.status).toBe(400);
    const unknownTarget = await postJson(`${batchPath}/mapping`, {
      mapping: {
        columns: {
          'First name': 'first_name',
          'Last name': 'last_name',
          Email: 'email',
          Extra: 'unexpected_field',
        },
      },
    });
    expect(unknownTarget.status).toBe(400);

    const mapping = {
      columns: {
        'First name': 'first_name',
        'Last name': 'last_name',
        Email: 'email',
      },
    };
    const savedMapping = await postJson(`${batchPath}/mapping`, {
      mapping,
      savePresetAs: 'Three-column people import',
    });
    expect(savedMapping.status).toBe(200);
    expect(await savedMapping.json()).toMatchObject({
      id: batch.id,
      status: 'mapped',
      mapping,
    });

    const stream = await fetch(`${baseUrl}${batchPath}/events`, {
      headers: { Cookie: ownerCookie },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('Expected a progress event stream');
    const firstEvent = await reader.read();
    expect(new TextDecoder().decode(firstEvent.value)).toContain(
      'event: progress',
    );
    await reader.cancel();

    const presets = await get(
      `/api/v1/imports/orgs/${ownerOrgId}/phase15/presets?kind=people`,
    );
    expect(presets.status).toBe(200);
    expect(await presets.json()).toMatchObject({
      items: [
        expect.objectContaining({
          name: 'Three-column people import',
          kind: 'people',
          mapping,
          builtin: false,
        }),
      ],
    });

    const invalidDecisions = await postJson(`${batchPath}/rows/decisions`, {
      decisions: [],
    });
    expect(invalidDecisions.status).toBe(400);
    const invalidDecisionOrigin = await postJson(
      `${batchPath}/rows/decisions`,
      { decisions: [] },
      { requestOrigin: 'https://attacker.example' },
    );
    expect(invalidDecisionOrigin.status).toBe(403);
    const duplicateSkipBeforeValidation = await postJson(
      `${batchPath}/rows/skip-duplicates`,
      {},
    );
    expect(duplicateSkipBeforeValidation.status).toBe(409);
    const invalidSkipOrigin = await postJson(
      `${batchPath}/rows/skip-duplicates`,
      {},
      { requestOrigin: 'https://attacker.example' },
    );
    expect(invalidSkipOrigin.status).toBe(403);
    const impersonatedDecision = await fetch(
      `${baseUrl}/direct/api/v1/imports/orgs/${ownerOrgId}/phase15/batches/${batch.id}/rows/decisions`,
      {
        method: 'POST',
        headers: {
          Cookie: ownerCookie,
          'X-Test-Import-Impersonation': 'present',
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Athlentry-Request': '1',
        },
        body: JSON.stringify({ decisions: [] }),
      },
    );
    expect(impersonatedDecision.status).toBe(403);
    const impersonatedDuplicateSkip = await fetch(
      `${baseUrl}/direct/api/v1/imports/orgs/${ownerOrgId}/phase15/batches/${batch.id}/rows/skip-duplicates`,
      {
        method: 'POST',
        headers: {
          Cookie: ownerCookie,
          'X-Test-Import-Impersonation': 'present',
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Athlentry-Request': '1',
        },
        body: JSON.stringify({}),
      },
    );
    expect(impersonatedDuplicateSkip.status).toBe(403);
    const invalidWriteOrigin = await postJson(
      `${batchPath}/validate`,
      {},
      { requestOrigin: 'https://attacker.example' },
    );
    expect(invalidWriteOrigin.status).toBe(403);
    const commitBeforeValidation = await postJson(`${batchPath}/commit`, {});
    expect(commitBeforeValidation.status).toBe(409);
    const rollbackBeforeCommit = await postJson(`${batchPath}/rollback`, {});
    expect(rollbackBeforeCommit.status).toBe(409);

    const legacyWrite = await postJson(
      `/api/v1/imports/orgs/${ownerOrgId}/batches`,
      {},
      { requestOrigin: 'https://attacker.example' },
    );
    expect(legacyWrite.status).toBe(403);
    expect(
      (await get(`/api/v1/imports/orgs/${ownerOrgId}/batches/not-a-uuid`))
        .status,
    ).toBe(400);
    expect(
      (await get(`/api/v1/imports/orgs/${ownerOrgId}/presets?kind=bad-kind`))
        .status,
    ).toBe(400);

    const legacyBatchList = await get(
      `/api/v1/imports/orgs/${ownerOrgId}/batches`,
    );
    expect(legacyBatchList.status).toBe(200);
    expect(legacyBatchList.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects malformed worker jobs before initializing runtime dependencies', async () => {
    await expect(runPhase15ImportJob({ step: 'commit' })).rejects.toMatchObject(
      {
        name: 'ZodError',
      },
    );
  });
});

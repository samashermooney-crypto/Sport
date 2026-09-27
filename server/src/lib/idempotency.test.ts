import { randomUUID } from 'node:crypto';

import type { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../db/kysely';
import { createWithOrg } from '../db/withOrg';

import {
  idempotencyHash,
  idempotentRoute,
  parseIdempotencyKey,
} from './idempotency';

const orgId = randomUUID();
const actorId = randomUUID();
const key = randomUUID();
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO organizations(id, slug, name, kind, timezone) VALUES ($1, $2, $3, $4, $5)',
      [
        orgId,
        `idempotency-${orgId.slice(0, 8)}`,
        'Idempotency test',
        'club',
        'UTC',
      ],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

type ResponseCapture = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

describe('idempotency middleware', () => {
  it('normalizes JSON field order and enforces UUID keys', () => {
    expect(idempotencyHash('POST', '/test', { a: 1, b: 2 })).toEqual(
      idempotencyHash('POST', '/test', { b: 2, a: 1 }),
    );
    expect(() => parseIdempotencyKey('not-a-uuid')).toThrow();
  });

  it('stores the first response, replays equal requests and rejects changed payloads', async () => {
    let executions = 0;
    const handler = idempotentRoute({
      context: () => ({ orgId, actor: { accountId: actorId } }),
      runWithOrg: createWithOrg(database),
      execute: () =>
        Promise.resolve({ status: 201, body: { execution: ++executions } }),
    });
    function call(
      body: unknown,
      idempotencyKey: string = key,
    ): Promise<ResponseCapture> {
      return new Promise((resolve, reject) => {
        let status = 200;
        const headers: Record<string, string> = {};
        const request = {
          method: 'POST',
          originalUrl: '/api/v1/orgs/test/messages',
          path: '/test/messages',
          body,
          get: (name: string) =>
            name === 'Idempotency-Key' ? idempotencyKey : undefined,
        } as unknown as Request;
        const response = {
          status(code: number) {
            status = code;
            return this;
          },
          setHeader(name: string, value: string) {
            headers[name] = value;
            return this;
          },
          json(value: unknown) {
            resolve({ status, body: value, headers });
            return this;
          },
        } as unknown as Response;
        handler(request, response, reject as NextFunction);
      });
    }
    expect(await call({ body: 'hello' })).toMatchObject({
      status: 201,
      body: { execution: 1 },
    });
    expect(await call({ body: 'hello' })).toMatchObject({
      status: 201,
      body: { execution: 1 },
      headers: { 'Idempotent-Replayed': 'true' },
    });
    expect(await call({ body: 'changed' })).toMatchObject({
      status: 409,
      body: { error: { code: 'CONFLICT' } },
    });
    expect(await call({}, 'invalid')).toMatchObject({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(executions).toBe(1);
    const concurrentKey = randomUUID();
    const concurrent = await Promise.all([
      call({ body: 'parallel' }, concurrentKey),
      call({ body: 'parallel' }, concurrentKey),
    ]);
    expect(concurrent.map((item) => item.body)).toEqual([
      { execution: 2 },
      { execution: 2 },
    ]);
    expect(executions).toBe(2);
  });
});

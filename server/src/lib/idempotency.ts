import { createHash, randomUUID } from 'node:crypto';

import { apiErrorSchema } from '@shared/schemas/errors';
import type { RequestHandler, Request } from 'express';

import type { Json } from '../db/types';
import { withOrg } from '../db/withOrg';
import type { OrgContext, OrgTransaction } from '../db/withOrg';

export type IdempotentResult = { status: number; body: unknown };
export type IdempotencyOptions = {
  context: (request: Request) => Promise<OrgContext> | OrgContext;
  execute: (request: Request, trx: OrgTransaction) => Promise<IdempotentResult>;
  runWithOrg?: typeof withOrg;
};

function canonicalJson(value: unknown): string {
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  )
    throw new TypeError('Request body must be JSON');
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function idempotencyHash(
  method: string,
  path: string,
  body: unknown,
): Buffer {
  return createHash('sha256')
    .update(method.toUpperCase())
    .update('\n')
    .update(path)
    .update('\n')
    .update(canonicalJson(body))
    .digest();
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new RangeError('Idempotency-Key must be a UUID');
  return value.toLowerCase();
}

export function idempotentRoute(options: IdempotencyOptions): RequestHandler {
  return (request, response, next) => {
    void (async () => {
      let key: string;
      try {
        key = parseIdempotencyKey(request.get('Idempotency-Key'));
      } catch {
        response.status(400).json(
          apiErrorSchema.parse({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Idempotency-Key must be a UUID',
            },
          }),
        );
        return;
      }
      const context = await options.context(request);
      const hash = idempotencyHash(
        request.method,
        request.originalUrl.split('?')[0] ?? request.path,
        request.body ?? null,
      );
      const run = options.runWithOrg ?? withOrg;
      const result = await run(context, async (trx) => {
        await trx
          .deleteFrom('idempotency_keys')
          .where('org_id', '=', context.orgId)
          .where('actor_id', '=', context.actor.accountId)
          .where('key', '=', key)
          .where('created_at', '<', new Date(Date.now() - 24 * 60 * 60 * 1000))
          .execute();
        await trx
          .insertInto('idempotency_keys')
          .values({
            id: randomUUID(),
            org_id: context.orgId,
            actor_id: context.actor.accountId,
            key,
            request_hash: hash,
          })
          .onConflict((conflict) =>
            conflict.columns(['org_id', 'actor_id', 'key']).doNothing(),
          )
          .execute();
        const saved = await trx
          .selectFrom('idempotency_keys')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('actor_id', '=', context.actor.accountId)
          .where('key', '=', key)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (!saved.request_hash.equals(hash))
          return { conflict: true as const };
        if (saved.response_status !== null)
          return {
            replay: true as const,
            status: saved.response_status,
            body: saved.response_body,
          };
        const produced = await options.execute(request, trx);
        if (
          !Number.isSafeInteger(produced.status) ||
          produced.status < 200 ||
          produced.status > 599
        )
          throw new RangeError('Invalid idempotent response status');
        const body = JSON.parse(canonicalJson(produced.body)) as Json;
        await trx
          .updateTable('idempotency_keys')
          .set({
            response_status: produced.status,
            response_body: body,
          })
          .where('id', '=', saved.id)
          .execute();
        return { replay: false as const, status: produced.status, body };
      });
      if ('conflict' in result) {
        response.status(409).json(
          apiErrorSchema.parse({
            error: {
              code: 'CONFLICT',
              message:
                'Idempotency-Key was already used for a different request',
            },
          }),
        );
        return;
      }
      if (result.replay) response.setHeader('Idempotent-Replayed', 'true');
      response.status(result.status).json(result.body);
    })().catch(next);
  };
}

import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

const code = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/);
export const glCodeBodySchema = z.strictObject({
  code,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['income', 'liability', 'expense']),
});
export const glCodeReplaceSchema = glCodeBodySchema.extend({
  expectedVersion: z.number().int().positive(),
});
export const glCodeSchema = glCodeBodySchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
});
export const glCodeListSchema = z.strictObject({
  codes: z.array(glCodeSchema),
});
export type GlCode = z.output<typeof glCodeSchema>;
export class GlCodeConflictError extends Error {}

interface Row {
  id: string;
  code: string;
  name: string;
  kind: string;
  version: number;
  creation_hash: string | null;
}

function present(row: Row): GlCode {
  return glCodeSchema.parse({
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    version: row.version,
  });
}

function uniqueCodeConflict(error: unknown): never {
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'gl_codes_org_id_code_key'
  )
    throw new GlCodeConflictError('GL code already exists');
  throw error;
}

/** Versioned org GL catalog. Existing invoice codes stay frozen on their lines. */
export class PostgresGlCodes {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  list(): Promise<GlCode[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<Row>`
        SELECT id, code, name, kind, version, creation_hash
        FROM gl_codes WHERE org_id = ${this.context.orgId}::uuid
        ORDER BY code, id
      `.execute(trx);
      return rows.rows.map(present);
    });
  }

  create(raw: z.output<typeof glCodeBodySchema>, key: string): Promise<GlCode> {
    const body = glCodeBodySchema.parse(raw);
    const creationKey = z.uuid().parse(key);
    const hash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    return this.withOrg(this.context, async (trx) => {
      const inserted = await sql<Row>`
        INSERT INTO gl_codes
          (id, org_id, code, name, kind, creation_key, creation_hash)
        VALUES (${newId()}::uuid, ${this.context.orgId}::uuid,
          ${body.code}, ${body.name}, ${body.kind},
          ${creationKey}::uuid, ${hash})
        ON CONFLICT (org_id, creation_key) WHERE creation_key IS NOT NULL
          DO NOTHING RETURNING id, code, name, kind, version, creation_hash
      `
        .execute(trx)
        .catch(uniqueCodeConflict);
      const row = inserted.rows[0];
      if (row) {
        await appendAuditEvent(trx, this.context, {
          action: 'gl_code.created',
          entityType: 'gl_code',
          entityId: row.id,
          changes: { code: { tier: 'internal', after: body.code } },
        });
        return present(row);
      }
      const replay = await sql<Row>`
        SELECT id, code, name, kind, version, creation_hash
        FROM gl_codes WHERE org_id = ${this.context.orgId}::uuid
          AND creation_key = ${creationKey}::uuid
      `.execute(trx);
      if (!replay.rows[0] || replay.rows[0].creation_hash !== hash)
        throw new GlCodeConflictError('GL code creation key was reused');
      return present(replay.rows[0]);
    });
  }

  replace(
    id: string,
    raw: z.output<typeof glCodeReplaceSchema>,
  ): Promise<GlCode> {
    const codeId = z.uuid().parse(id);
    const body = glCodeReplaceSchema.parse(raw);
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('gl_codes')
        .select(['id', 'code', 'name', 'kind', 'version'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', codeId)
        .forUpdate()
        .executeTakeFirst();
      if (!current || current.version !== body.expectedVersion)
        throw new GlCodeConflictError('GL code version changed');
      const result = await sql<Row>`
        UPDATE gl_codes SET code = ${body.code}, name = ${body.name},
          kind = ${body.kind}, version = version + 1
        WHERE org_id = ${this.context.orgId}::uuid
          AND id = ${codeId}::uuid
        RETURNING id, code, name, kind, version, creation_hash
      `
        .execute(trx)
        .catch(uniqueCodeConflict);
      const updated = result.rows[0];
      if (!updated) throw new GlCodeConflictError('GL code changed');
      await appendAuditEvent(trx, this.context, {
        action: 'gl_code.replaced',
        entityType: 'gl_code',
        entityId: codeId,
        changes: {
          code: { tier: 'internal', before: current.code, after: body.code },
          name: { tier: 'internal', before: current.name, after: body.name },
          kind: { tier: 'internal', before: current.kind, after: body.kind },
        },
      });
      return present(updated);
    });
  }
}

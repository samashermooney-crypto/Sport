import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const aidProgramCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  seasonId: z.uuid(),
  applicationFormId: z.uuid().nullable(),
  budgetCents: cents,
});
export const aidProgramReplaceSchema = aidProgramCreateSchema
  .omit({ seasonId: true })
  .extend({
    expectedVersion: z.number().int().positive(),
    status: z.enum(['draft', 'open', 'closed', 'archived']),
  });
export const aidProgramSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  seasonId: z.uuid(),
  applicationFormId: z.uuid().nullable(),
  budgetCents: cents,
  awardedCents: cents,
  status: z.enum(['draft', 'open', 'closed', 'archived']),
  version: z.number().int().positive(),
});
export const aidProgramListSchema = z.strictObject({
  programs: z.array(aidProgramSchema),
});
export type AidProgram = z.output<typeof aidProgramSchema>;
export class AidProgramConflictError extends Error {}

interface ProgramRow {
  id: string;
  name: string;
  season_id: string;
  application_form_id: string | null;
  budget_cents: number;
  awarded_cents: number;
  status: string;
  version: number;
  creation_hash: string | null;
}

function view(row: ProgramRow): AidProgram {
  return aidProgramSchema.parse({
    id: row.id,
    name: row.name,
    seasonId: row.season_id,
    applicationFormId: row.application_form_id,
    budgetCents: row.budget_cents,
    awardedCents: row.awarded_cents,
    status: row.status,
    version: row.version,
  });
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Keeps season aid configuration versioned and budget-safe under the award lock. */
export class PostgresAidPrograms {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async create(
    input: z.output<typeof aidProgramCreateSchema>,
    creationKey: string,
  ): Promise<AidProgram> {
    const value = aidProgramCreateSchema.parse(input);
    const key = z.uuid().parse(creationKey);
    const requestHash = hash(value);
    return this.withOrg(this.context, async (trx) => {
      const prior = await sql<ProgramRow>`
        SELECT * FROM financial_aid_programs
        WHERE org_id = ${this.context.orgId}::uuid
          AND creation_key = ${key}::uuid
      `.execute(trx);
      if (prior.rows[0]) {
        if (prior.rows[0].creation_hash !== requestHash)
          throw new AidProgramConflictError('Aid creation key was reused');
        return view(prior.rows[0]);
      }
      const season = await trx
        .selectFrom('seasons')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.seasonId)
        .executeTakeFirst();
      if (!season) throw new AidProgramConflictError('Aid season unavailable');
      if (value.applicationFormId)
        await this.requirePublishedForm(trx, value.applicationFormId);
      const id = newId();
      const inserted = await sql<ProgramRow>`
        INSERT INTO financial_aid_programs
          (id, org_id, name, season_id, application_form_id,
            budget_cents, status, creation_key, creation_hash)
        VALUES (${id}::uuid, ${this.context.orgId}::uuid, ${value.name},
          ${value.seasonId}::uuid, ${value.applicationFormId}::uuid,
          ${value.budgetCents}, 'draft', ${key}::uuid, ${requestHash})
        ON CONFLICT (org_id, creation_key) WHERE creation_key IS NOT NULL
          DO NOTHING RETURNING *
      `.execute(trx);
      const row = inserted.rows[0];
      if (row) {
        await appendAuditEvent(trx, this.context, {
          action: 'aid.program_created',
          entityType: 'financial_aid_program',
          entityId: row.id,
          changes: {
            budgetCents: { tier: 'restricted', after: value.budgetCents },
          },
        });
        return view(row);
      }
      const replay = await sql<ProgramRow>`
        SELECT * FROM financial_aid_programs
        WHERE org_id = ${this.context.orgId}::uuid
          AND creation_key = ${key}::uuid
      `.execute(trx);
      const existing = replay.rows[0];
      if (!existing || existing.creation_hash !== requestHash)
        throw new AidProgramConflictError('Aid creation key was reused');
      return view(existing);
    });
  }

  async replace(
    id: string,
    input: z.output<typeof aidProgramReplaceSchema>,
  ): Promise<AidProgram> {
    const programId = z.uuid().parse(id);
    const value = aidProgramReplaceSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      const result = await sql<ProgramRow>`
        SELECT * FROM financial_aid_programs
        WHERE org_id = ${this.context.orgId}::uuid
          AND id = ${programId}::uuid FOR UPDATE
      `.execute(trx);
      const current = result.rows[0];
      if (!current || current.version !== value.expectedVersion)
        throw new AidProgramConflictError('Aid program version changed');
      const allowed: Record<string, string[]> = {
        draft: ['draft', 'open', 'archived'],
        open: ['open', 'closed'],
        closed: ['closed', 'open', 'archived'],
        archived: ['archived'],
      };
      if (
        !allowed[current.status]?.includes(value.status) ||
        (current.status === 'archived' && value.status === 'archived')
      )
        throw new AidProgramConflictError(
          'Aid program transition is unavailable',
        );
      if (value.applicationFormId !== current.application_form_id) {
        if (current.status !== 'draft')
          throw new AidProgramConflictError(
            'Aid application form is immutable after opening',
          );
        const application = await trx
          .selectFrom('aid_applications')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('financial_aid_program_id', '=', programId)
          .executeTakeFirst();
        if (application)
          throw new AidProgramConflictError(
            'Aid applications already use this form',
          );
      }
      if (value.status === 'open') {
        if (!value.applicationFormId)
          throw new AidProgramConflictError('Published aid form is required');
        await this.requirePublishedForm(trx, value.applicationFormId);
      } else if (value.applicationFormId) {
        await this.requirePublishedForm(trx, value.applicationFormId);
      }
      const updated = await sql<ProgramRow>`
        UPDATE financial_aid_programs SET name = ${value.name},
          application_form_id = ${value.applicationFormId}::uuid,
          budget_cents = ${value.budgetCents}, status = ${value.status},
          version = version + 1
        WHERE org_id = ${this.context.orgId}::uuid
          AND id = ${programId}::uuid
          AND awarded_cents <= ${value.budgetCents}
        RETURNING *
      `.execute(trx);
      const row = updated.rows[0];
      if (!row)
        throw new AidProgramConflictError('Budget is below reserved awards');
      await appendAuditEvent(trx, this.context, {
        action: 'aid.program_replaced',
        entityType: 'financial_aid_program',
        entityId: programId,
        changes: {
          budgetCents: {
            tier: 'restricted',
            before: current.budget_cents,
            after: value.budgetCents,
          },
          status: {
            tier: 'restricted',
            before: current.status,
            after: value.status,
          },
        },
      });
      return view(row);
    });
  }

  async list(seasonId?: string): Promise<AidProgram[]> {
    const season = seasonId ? z.uuid().parse(seasonId) : null;
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<ProgramRow>`
        SELECT * FROM financial_aid_programs
        WHERE org_id = ${this.context.orgId}::uuid
          AND (${season}::uuid IS NULL OR season_id = ${season}::uuid)
        ORDER BY created_at DESC, id DESC
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'restricted.read',
        entityType: 'financial_aid_program',
        entityId: this.context.orgId,
        changes: {
          budgetCents: { tier: 'restricted', after: '[read]' },
          awardedCents: { tier: 'restricted', after: '[read]' },
        },
      });
      return rows.rows.map(view);
    });
  }

  private async requirePublishedForm(
    trx: Transaction<DB>,
    formId: string,
  ): Promise<void> {
    const form = await trx
      .selectFrom('form_definitions')
      .select('id')
      .where('org_id', '=', this.context.orgId)
      .where('id', '=', formId)
      .where('scope', '=', 'custom')
      .where('published_at', 'is not', null)
      .where('retired_at', 'is', null)
      .executeTakeFirst();
    if (!form)
      throw new AidProgramConflictError(
        'Published custom aid form is required',
      );
  }
}

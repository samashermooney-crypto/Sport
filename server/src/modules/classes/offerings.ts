import { newId } from '@shared/ids';
import type {
  ClassOffering,
  ClassOfferingBody,
  ClassOfferingUpdate,
} from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { requireVersion } from '../../lib/version-check.js';
import { appendAuditEvent } from '../audit/service.js';

import { ClassesConflictError, ClassesNotFoundError } from './errors.js';

interface OfferingRow {
  id: string;
  org_id: string;
  program_id: string;
  skill_level_id: string | null;
  name: string;
  description: string | null;
  age_min_months: number | null;
  age_max_months: number | null;
  capacity: number;
  instructor_ratio: string;
  billing: string;
  price_cents: number;
  punch_card_uses: number | null;
  tuition_tiers: unknown;
  annual_fee_cents: number;
  trial_allowed: boolean;
  trial_price_cents: number;
  makeup_policy: unknown;
  sibling_discount_bps: unknown;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  enrolled_count: number;
  level_name: string | null;
  program_name: string;
}

const OFFERING_SELECT = sql<OfferingRow>`
  SELECT o.id, o.org_id, o.program_id, o.skill_level_id, o.name, o.description,
    o.age_min_months, o.age_max_months, o.capacity, o.instructor_ratio,
    o.billing, o.price_cents, o.punch_card_uses, o.tuition_tiers,
    o.annual_fee_cents, o.trial_allowed, o.trial_price_cents,
    o.makeup_policy, o.sibling_discount_bps, o.status, o.version,
    o.created_at, o.updated_at,
    (SELECT count(*)::integer FROM class_enrollments e
      WHERE e.org_id = o.org_id AND e.class_offering_id = o.id
        AND e.status IN ('trial', 'active', 'paused')) AS enrolled_count,
    level.name AS level_name, program.name AS program_name
  FROM class_offerings o
  JOIN programs program ON program.org_id = o.org_id AND program.id = o.program_id
  LEFT JOIN skill_levels level ON level.org_id = o.org_id AND level.id = o.skill_level_id
`;

function mapOffering(row: OfferingRow): ClassOffering {
  return {
    id: row.id,
    orgId: row.org_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    programId: row.program_id,
    skillLevelId: row.skill_level_id,
    name: row.name,
    description: row.description,
    ageMinMonths: row.age_min_months,
    ageMaxMonths: row.age_max_months,
    capacity: row.capacity,
    instructorRatio: Number(row.instructor_ratio),
    billing: row.billing as ClassOffering['billing'],
    priceCents: row.price_cents,
    punchCardUses: row.punch_card_uses,
    tuitionTiers: z
      .array(
        z.strictObject({
          maxClassesPerWeek: z.number().int().positive().nullable(),
          amountCents: z.number().int().nonnegative(),
        }),
      )
      .parse(row.tuition_tiers),
    annualFeeCents: row.annual_fee_cents,
    trialAllowed: row.trial_allowed,
    trialPriceCents: row.trial_price_cents,
    makeupPolicy: z
      .strictObject({
        creditsPerTerm: z.number().int().nonnegative(),
        expiryDays: z.number().int().positive(),
        eligibleLevelIds: z.array(z.uuid()).nullable(),
        eligibleOfferingIds: z.array(z.uuid()).nullable(),
      })
      .parse(row.makeup_policy),
    siblingDiscountBps: z
      .array(z.number().int())
      .parse(row.sibling_discount_bps),
    status: row.status as ClassOffering['status'],
    enrolledCount: row.enrolled_count,
    spotsRemaining: Math.max(0, row.capacity - row.enrolled_count),
    levelName: row.level_name,
    programName: row.program_name,
    version: row.version,
  };
}

export class PostgresClassOfferings {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async list(input: {
    programId?: string;
    levelId?: string;
    status?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: ClassOffering[]; nextCursor: string | null }> {
    return this.withOrg(this.context, async (trx) => {
      const cursor = input.cursor
        ? decodeCursor(input.cursor, 'created_at')
        : null;
      const rows = await sql<OfferingRow>`
        SELECT o.id, o.org_id, o.program_id, o.skill_level_id, o.name, o.description,
          o.age_min_months, o.age_max_months, o.capacity, o.instructor_ratio,
          o.billing, o.price_cents, o.punch_card_uses, o.tuition_tiers,
          o.annual_fee_cents, o.trial_allowed, o.trial_price_cents,
          o.makeup_policy, o.sibling_discount_bps, o.status, o.version,
          o.created_at, o.updated_at,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = o.org_id AND e.class_offering_id = o.id
              AND e.status IN ('trial', 'active', 'paused')) AS enrolled_count,
          level.name AS level_name, program.name AS program_name
        FROM class_offerings o
        JOIN programs program
          ON program.org_id = o.org_id AND program.id = o.program_id
        LEFT JOIN skill_levels level
          ON level.org_id = o.org_id AND level.id = o.skill_level_id
        WHERE o.org_id = ${this.context.orgId}::uuid
          ${input.programId ? sql`AND o.program_id = ${input.programId}::uuid` : sql``}
          ${input.levelId ? sql`AND o.skill_level_id = ${input.levelId}::uuid` : sql``}
          ${input.status ? sql`AND o.status = ${input.status}` : sql`AND o.status <> 'archived'`}
          ${cursor ? sql`AND o.created_at < ${String(cursor.value)}::timestamptz` : sql``}
        ORDER BY o.created_at DESC, o.id
        LIMIT ${input.limit + 1}
      `.execute(trx);
      const page = rows.rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map(mapOffering),
        nextCursor:
          rows.rows.length > input.limit && last
            ? encodeCursor({
                sort: 'created_at',
                value: last.created_at.toISOString(),
                id: last.id,
              })
            : null,
      };
    });
  }

  private async getInTransaction(
    trx: OrgTransaction,
    offeringId: string,
  ): Promise<ClassOffering> {
    const row = await sql<OfferingRow>`
      ${OFFERING_SELECT}
      WHERE o.org_id = ${this.context.orgId}::uuid
        AND o.id = ${offeringId}::uuid
    `.execute(trx);
    const found = row.rows[0];
    if (!found) throw new ClassesNotFoundError('Class offering not found');
    return mapOffering(found);
  }

  async get(offeringId: string): Promise<ClassOffering> {
    return this.withOrg(this.context, (trx) =>
      this.getInTransaction(trx, offeringId),
    );
  }

  async create(input: ClassOfferingBody): Promise<ClassOffering> {
    return this.withOrg(this.context, async (trx) => {
      const program = await trx
        .selectFrom('programs')
        .select(['id', 'mode', 'sport_profile_id', 'status'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', input.programId)
        .executeTakeFirst();
      if (!program || program.mode !== 'class')
        throw new ClassesConflictError(
          'Class offerings must belong to a class-mode program',
          'PROGRAM_MODE',
        );
      if (program.status === 'archived')
        throw new ClassesConflictError('The program is archived');
      if (input.skillLevelId) {
        const level = await trx
          .selectFrom('skill_levels')
          .select(['id', 'sport_profile_id'])
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', input.skillLevelId)
          .executeTakeFirst();
        if (!level) throw new ClassesConflictError('Skill level was not found');
        if (level.sport_profile_id !== program.sport_profile_id)
          throw new ClassesConflictError(
            'Skill level belongs to a different sport profile',
          );
      }
      const id = newId();
      await trx
        .insertInto('class_offerings')
        .values({
          id,
          org_id: this.context.orgId,
          program_id: input.programId,
          skill_level_id: input.skillLevelId,
          name: input.name,
          description: input.description,
          age_min_months: input.ageMinMonths,
          age_max_months: input.ageMaxMonths,
          capacity: input.capacity,
          instructor_ratio: input.instructorRatio,
          billing: input.billing,
          price_cents: input.priceCents,
          punch_card_uses:
            input.billing === 'punch_card' ? input.punchCardUses : null,
          tuition_tiers: JSON.stringify(input.tuitionTiers),
          annual_fee_cents: input.annualFeeCents,
          trial_allowed: input.trialAllowed,
          trial_price_cents: input.trialPriceCents,
          makeup_policy: JSON.stringify(input.makeupPolicy),
          sibling_discount_bps: input.siblingDiscountBps,
          status: input.status,
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.offering_created',
        entityType: 'class_offering',
        entityId: id,
        changes: { name: { tier: 'internal', after: input.name } },
      });
      return this.getInTransaction(trx, id);
    });
  }

  async update(
    offeringId: string,
    input: ClassOfferingUpdate,
  ): Promise<ClassOffering> {
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('class_offerings')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', offeringId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ClassesNotFoundError('Class offering not found');
      requireVersion(current, input.expectedVersion);
      const live = await trx
        .selectFrom('class_enrollments')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('org_id', '=', this.context.orgId)
        .where('class_offering_id', '=', offeringId)
        .where('status', 'in', ['trial', 'active', 'paused'])
        .executeTakeFirstOrThrow();
      if (input.capacity !== undefined && input.capacity < live.count)
        throw new ClassesConflictError(
          'Capacity cannot be below the live enrollment count',
        );
      await trx
        .updateTable('class_offerings')
        .set({
          name: input.name ?? current.name,
          description:
            input.description === undefined
              ? current.description
              : input.description,
          skill_level_id:
            input.skillLevelId === undefined
              ? current.skill_level_id
              : input.skillLevelId,
          age_min_months:
            input.ageMinMonths === undefined
              ? current.age_min_months
              : input.ageMinMonths,
          age_max_months:
            input.ageMaxMonths === undefined
              ? current.age_max_months
              : input.ageMaxMonths,
          capacity: input.capacity ?? current.capacity,
          instructor_ratio: input.instructorRatio ?? current.instructor_ratio,
          billing: input.billing ?? current.billing,
          price_cents: input.priceCents ?? current.price_cents,
          punch_card_uses:
            input.punchCardUses === undefined
              ? current.punch_card_uses
              : input.punchCardUses,
          tuition_tiers:
            input.tuitionTiers === undefined
              ? JSON.stringify(current.tuition_tiers)
              : JSON.stringify(input.tuitionTiers),
          annual_fee_cents: input.annualFeeCents ?? current.annual_fee_cents,
          trial_allowed: input.trialAllowed ?? current.trial_allowed,
          trial_price_cents: input.trialPriceCents ?? current.trial_price_cents,
          makeup_policy:
            input.makeupPolicy === undefined
              ? JSON.stringify(current.makeup_policy)
              : JSON.stringify(input.makeupPolicy),
          sibling_discount_bps:
            input.siblingDiscountBps ?? current.sibling_discount_bps,
          status: input.status ?? current.status,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', offeringId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.offering_updated',
        entityType: 'class_offering',
        entityId: offeringId,
        changes: {},
      });
      return this.getInTransaction(trx, offeringId);
    });
  }

  async archive(offeringId: string, expectedVersion: number): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('class_offerings')
        .select(['version'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', offeringId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ClassesNotFoundError('Class offering not found');
      requireVersion(current, expectedVersion);
      const live = await trx
        .selectFrom('class_enrollments')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('org_id', '=', this.context.orgId)
        .where('class_offering_id', '=', offeringId)
        .where('status', 'in', ['trial', 'active', 'paused'])
        .executeTakeFirstOrThrow();
      if (live.count > 0)
        throw new ClassesConflictError(
          'Withdraw all enrollments before archiving',
          'SCHEDULE_HAS_ENROLLMENTS',
        );
      await trx
        .updateTable('class_offerings')
        .set({ status: 'archived', version: sql`version + 1` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', offeringId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.offering_archived',
        entityType: 'class_offering',
        entityId: offeringId,
        changes: {},
      });
    });
  }
}

import { newId } from '@shared/ids';
import type {
  AthleteProgress,
  Skill,
  SkillBody,
  SkillLevel,
  SkillLevelBody,
  SkillLevelDetail,
} from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { requireVersion } from '../../lib/version-check.js';
import { appendAuditEvent } from '../audit/service.js';

import { ClassesNotFoundError } from './errors.js';

const i18nSchema = z.object({ en: z.string().min(1), es: z.string().min(1) });
const profileSchema = z.looseObject({
  skillLevels: z
    .array(z.object({ name: i18nSchema, skills: z.array(i18nSchema) }))
    .optional(),
});

function mapLevel(row: {
  id: string;
  org_id: string;
  sport_profile_id: string;
  name: string;
  description: string | null;
  sort_order: number;
  skill_count: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}): SkillLevel {
  return {
    id: row.id,
    orgId: row.org_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sportProfileId: row.sport_profile_id,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    skillCount: row.skill_count,
    version: row.version,
  };
}

function mapSkill(row: {
  id: string;
  org_id: string;
  skill_level_id: string;
  name: string;
  description: string | null;
  video_url: string | null;
  sort_order: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}): Skill {
  return {
    id: row.id,
    orgId: row.org_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    skillLevelId: row.skill_level_id,
    name: row.name,
    description: row.description,
    videoUrl: row.video_url,
    sortOrder: row.sort_order,
    version: row.version,
  };
}

export class PostgresClassSkills {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async listLevels(sportProfileId?: string): Promise<SkillLevel[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<{
        id: string;
        org_id: string;
        sport_profile_id: string;
        name: string;
        description: string | null;
        sort_order: number;
        skill_count: number;
        version: number;
        created_at: Date;
        updated_at: Date;
      }>`
        SELECT level.id, level.org_id, level.sport_profile_id, level.name,
          level.description, level.sort_order, level.version,
          level.created_at, level.updated_at,
          (SELECT count(*)::integer FROM skills s
            WHERE s.org_id = level.org_id AND s.skill_level_id = level.id
              AND s.archived_at IS NULL) AS skill_count
        FROM skill_levels level
        WHERE level.org_id = ${this.context.orgId}::uuid
          ${sportProfileId ? sql`AND level.sport_profile_id = ${sportProfileId}::uuid` : sql``}
        ORDER BY level.sport_profile_id, level.sort_order
      `.execute(trx);
      return rows.rows.map(mapLevel);
    });
  }

  private async getLevelInTransaction(
    trx: OrgTransaction,
    levelId: string,
  ): Promise<SkillLevelDetail> {
    {
      const level = await trx
        .selectFrom('skill_levels')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', levelId)
        .executeTakeFirst();
      if (!level) throw new ClassesNotFoundError('Skill level not found');
      const skills = await trx
        .selectFrom('skills')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('skill_level_id', '=', levelId)
        .where('archived_at', 'is', null)
        .orderBy('sort_order')
        .execute();
      return {
        ...mapLevel({
          ...level,
          skill_count: skills.length,
        }),
        skills: skills.map((row) =>
          mapSkill(row as unknown as Parameters<typeof mapSkill>[0]),
        ),
      };
    }
  }

  async getLevel(levelId: string): Promise<SkillLevelDetail> {
    return this.withOrg(this.context, (trx) =>
      this.getLevelInTransaction(trx, levelId),
    );
  }

  async createLevel(input: SkillLevelBody): Promise<SkillLevel> {
    return this.withOrg(this.context, async (trx) => {
      const profile = await trx
        .selectFrom('sport_profiles')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', input.sportProfileId)
        .executeTakeFirst();
      if (!profile) throw new ClassesNotFoundError('Sport profile not found');
      const sortOrder =
        input.sortOrder ??
        (await this.nextSortOrder(trx, input.sportProfileId));
      const id = newId();
      await trx
        .insertInto('skill_levels')
        .values({
          id,
          org_id: this.context.orgId,
          sport_profile_id: input.sportProfileId,
          name: input.name,
          description: input.description,
          sort_order: sortOrder,
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.level_created',
        entityType: 'skill_level',
        entityId: id,
        changes: { name: { tier: 'internal', after: input.name } },
      });
      return mapLevel({
        id,
        org_id: this.context.orgId,
        sport_profile_id: input.sportProfileId,
        name: input.name,
        description: input.description,
        sort_order: sortOrder,
        skill_count: 0,
        version: 1,
        created_at: new Date(),
        updated_at: new Date(),
      });
    });
  }

  private async nextSortOrder(
    trx: OrgTransaction,
    sportProfileId: string,
  ): Promise<number> {
    const row = await trx
      .selectFrom('skill_levels')
      .select(sql<number>`coalesce(max(sort_order), 0) + 1`.as('next'))
      .where('org_id', '=', this.context.orgId)
      .where('sport_profile_id', '=', sportProfileId)
      .executeTakeFirstOrThrow();
    return row.next;
  }

  async updateLevel(
    levelId: string,
    input: {
      name?: string;
      description?: string | null;
      sortOrder?: number;
      expectedVersion: number;
    },
  ): Promise<SkillLevel> {
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('skill_levels')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', levelId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ClassesNotFoundError('Skill level not found');
      requireVersion(current, input.expectedVersion);
      await trx
        .updateTable('skill_levels')
        .set({
          name: input.name ?? current.name,
          description:
            input.description === undefined
              ? current.description
              : input.description,
          sort_order: input.sortOrder ?? current.sort_order,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', levelId)
        .execute();
      return this.getLevelInTransaction(trx, levelId);
    });
  }

  async addSkill(levelId: string, input: SkillBody): Promise<Skill> {
    return this.withOrg(this.context, async (trx) => {
      const level = await trx
        .selectFrom('skill_levels')
        .select(['id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', levelId)
        .executeTakeFirst();
      if (!level) throw new ClassesNotFoundError('Skill level not found');
      const next = await trx
        .selectFrom('skills')
        .select(sql<number>`coalesce(max(sort_order), 0) + 1`.as('next'))
        .where('org_id', '=', this.context.orgId)
        .where('skill_level_id', '=', levelId)
        .executeTakeFirstOrThrow();
      const id = newId();
      await trx
        .insertInto('skills')
        .values({
          id,
          org_id: this.context.orgId,
          skill_level_id: levelId,
          name: input.name,
          description: input.description,
          video_url: input.videoUrl,
          sort_order: input.sortOrder ?? next.next,
        })
        .execute();
      return {
        id,
        orgId: this.context.orgId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        skillLevelId: levelId,
        name: input.name,
        description: input.description,
        videoUrl: input.videoUrl,
        sortOrder: input.sortOrder ?? next.next,
        version: 1,
      };
    });
  }

  async updateSkill(
    skillId: string,
    input: {
      name?: string;
      description?: string | null;
      videoUrl?: string | null;
      sortOrder?: number;
      expectedVersion: number;
    },
  ): Promise<Skill> {
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('skills')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', skillId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ClassesNotFoundError('Skill not found');
      requireVersion(current, input.expectedVersion);
      await trx
        .updateTable('skills')
        .set({
          name: input.name ?? current.name,
          description:
            input.description === undefined
              ? current.description
              : input.description,
          video_url:
            input.videoUrl === undefined ? current.video_url : input.videoUrl,
          sort_order: input.sortOrder ?? current.sort_order,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', skillId)
        .execute();
      const updated = await trx
        .selectFrom('skills')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', skillId)
        .executeTakeFirstOrThrow();
      return mapSkill(updated);
    });
  }

  /** Import the profile's built-in skill levels (idempotent by name). */
  async syncFromProfile(sportProfileId: string): Promise<{
    levelsCreated: number;
    skillsCreated: number;
  }> {
    return this.withOrg(this.context, async (trx) => {
      const profile = await trx
        .selectFrom('sport_profiles')
        .select(['id', 'profile'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', sportProfileId)
        .executeTakeFirst();
      if (!profile) throw new ClassesNotFoundError('Sport profile not found');
      const parsed = profileSchema.safeParse(profile.profile);
      if (!parsed.success || !parsed.data.skillLevels?.length)
        return { levelsCreated: 0, skillsCreated: 0 };
      let levelsCreated = 0;
      let skillsCreated = 0;
      for (const levelInput of parsed.data.skillLevels) {
        let level = await trx
          .selectFrom('skill_levels')
          .select(['id', 'sort_order'])
          .where('org_id', '=', this.context.orgId)
          .where('sport_profile_id', '=', sportProfileId)
          .where('name', '=', levelInput.name.en)
          .executeTakeFirst();
        if (!level) {
          const id = newId();
          const sortOrder = await this.nextSortOrder(trx, sportProfileId);
          await trx
            .insertInto('skill_levels')
            .values({
              id,
              org_id: this.context.orgId,
              sport_profile_id: sportProfileId,
              name: levelInput.name.en,
              sort_order: sortOrder,
            })
            .execute();
          levelsCreated += 1;
          level = { id, sort_order: sortOrder };
        }
        for (const [skillIndex, skillInput] of levelInput.skills.entries()) {
          const exists = await trx
            .selectFrom('skills')
            .select('id')
            .where('org_id', '=', this.context.orgId)
            .where('skill_level_id', '=', level.id)
            .where('name', '=', skillInput.en)
            .executeTakeFirst();
          if (exists) continue;
          await trx
            .insertInto('skills')
            .values({
              id: newId(),
              org_id: this.context.orgId,
              skill_level_id: level.id,
              name: skillInput.en,
              sort_order: skillIndex + 1,
            })
            .execute();
          skillsCreated += 1;
        }
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.levels_synced',
        entityType: 'sport_profile',
        entityId: sportProfileId,
        changes: {
          levelsCreated: { tier: 'internal', after: levelsCreated },
          skillsCreated: { tier: 'internal', after: skillsCreated },
        },
      });
      return { levelsCreated, skillsCreated };
    });
  }

  async recordSkill(
    personId: string,
    input: {
      skillId: string;
      status: 'not_started' | 'in_progress' | 'achieved';
      note?: string | null;
    },
  ): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const skill = await trx
        .selectFrom('skills')
        .select(['id', 'archived_at'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', input.skillId)
        .executeTakeFirst();
      if (!skill || skill.archived_at)
        throw new ClassesNotFoundError('Skill not found');
      const person = await trx
        .selectFrom('people')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', personId)
        .executeTakeFirst();
      if (!person) throw new ClassesNotFoundError('Person not found');
      const existing = await trx
        .selectFrom('athlete_skill_records')
        .select(['id'])
        .where('org_id', '=', this.context.orgId)
        .where('person_id', '=', personId)
        .where('skill_id', '=', input.skillId)
        .executeTakeFirst();
      if (existing) {
        await trx
          .updateTable('athlete_skill_records')
          .set({
            status: input.status,
            assessed_by: this.context.actor.accountId,
            assessed_at: sql`now()`,
            note: input.note ?? null,
            version: sql`version + 1`,
            updated_at: sql`now()`,
          })
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', existing.id)
          .execute();
      } else {
        await trx
          .insertInto('athlete_skill_records')
          .values({
            id: newId(),
            org_id: this.context.orgId,
            person_id: personId,
            skill_id: input.skillId,
            status: input.status,
            assessed_by: this.context.actor.accountId,
            assessed_at: sql`now()`,
            note: input.note ?? null,
          })
          .execute();
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.skill_recorded',
        entityType: 'person',
        entityId: personId,
        changes: {
          skillId: { tier: 'internal', after: input.skillId },
          status: { tier: 'internal', after: input.status },
        },
      });
    });
  }

  async athleteProgress(personId: string): Promise<AthleteProgress> {
    return this.withOrg(this.context, async (trx) => {
      const person = await trx
        .selectFrom('people')
        .select(['id', 'first_name', 'last_name'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', personId)
        .executeTakeFirst();
      if (!person) throw new ClassesNotFoundError('Person not found');
      const currentLevel = await sql<{
        level_id: string;
        level_name: string;
      }>`
        SELECT level.id AS level_id, level.name AS level_name
        FROM level_promotions promotion
        JOIN skill_levels level ON level.org_id = promotion.org_id
          AND level.id = promotion.to_level_id
        WHERE promotion.org_id = ${this.context.orgId}::uuid
          AND promotion.person_id = ${personId}::uuid
          AND promotion.status = 'completed'
        ORDER BY promotion.created_at DESC
        LIMIT 1
      `.execute(trx);
      const enrollment = await trx
        .selectFrom('class_enrollments as enrollment')
        .innerJoin('class_offerings as offering', (join) =>
          join
            .onRef('offering.org_id', '=', 'enrollment.org_id')
            .onRef('offering.id', '=', 'enrollment.class_offering_id'),
        )
        .select('offering.skill_level_id')
        .where('enrollment.org_id', '=', this.context.orgId)
        .where('enrollment.person_id', '=', personId)
        .where('enrollment.status', 'in', ['trial', 'active', 'paused'])
        .where('offering.skill_level_id', 'is not', null)
        .executeTakeFirst();
      const levelId =
        currentLevel.rows[0]?.level_id ?? enrollment?.skill_level_id ?? null;
      const levelRows = levelId
        ? await trx
            .selectFrom('skill_levels')
            .select(['sport_profile_id'])
            .where('org_id', '=', this.context.orgId)
            .where('id', '=', levelId)
            .executeTakeFirst()
        : null;
      const levels = levelRows
        ? await sql<{
            level_id: string;
            level_name: string;
            sort_order: number;
            skill_id: string;
            skill_name: string;
            status: string | null;
            assessed_at: Date | null;
          }>`
            SELECT level.id AS level_id, level.name AS level_name,
              level.sort_order,
              skill.id AS skill_id, skill.name AS skill_name,
              record.status, record.assessed_at
            FROM skill_levels level
            LEFT JOIN skills skill ON skill.org_id = level.org_id
              AND skill.skill_level_id = level.id AND skill.archived_at IS NULL
            LEFT JOIN athlete_skill_records record
              ON record.org_id = skill.org_id AND record.skill_id = skill.id
              AND record.person_id = ${personId}::uuid
            WHERE level.org_id = ${this.context.orgId}::uuid
              AND level.sport_profile_id = ${levelRows.sport_profile_id}::uuid
            ORDER BY level.sort_order, skill.sort_order
          `.execute(trx)
        : { rows: [] };
      const byLevel = new Map<string, AthleteProgress['levels'][number]>();
      for (const row of levels.rows) {
        const level = byLevel.get(row.level_id) ?? {
          levelId: row.level_id,
          levelName: row.level_name,
          sortOrder: row.sort_order,
          skills: [],
          achievedCount: 0,
          totalCount: 0,
        };
        if (row.skill_id) {
          const status = (row.status ?? 'not_started') as
            'not_started' | 'in_progress' | 'achieved';
          level.skills.push({
            skillId: row.skill_id,
            name: row.skill_name,
            status,
            assessedAt: row.assessed_at?.toISOString() ?? null,
          });
          level.totalCount += 1;
          if (status === 'achieved') level.achievedCount += 1;
        }
        byLevel.set(row.level_id, level);
      }
      const levelName = currentLevel.rows[0]?.level_name ?? null;
      return {
        personId,
        personName: `${person.first_name} ${person.last_name}`,
        currentLevelId: levelId,
        currentLevelName: levelName,
        levels: [...byLevel.values()].sort((a, b) => a.sortOrder - b.sortOrder),
      };
    });
  }
}

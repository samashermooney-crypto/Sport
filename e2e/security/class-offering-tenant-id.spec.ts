import { expect, test } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { PostgresClassOfferings } from '../../server/src/modules/classes/offerings';
import { PostgresClassSchedules } from '../../server/src/modules/classes/schedules';
import { PostgresClassSessions } from '../../server/src/modules/classes/sessions';
import { PostgresClassSkills } from '../../server/src/modules/classes/skills';
import { createTestFactories } from '../../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

function offeringInput(programId: string) {
  return {
    programId,
    skillLevelId: null,
    name: 'Tenant isolation fixture',
    description: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    capacity: 8,
    instructorRatio: 8,
    billing: 'monthly' as const,
    priceCents: 12_000,
    punchCardUses: null,
    tuitionTiers: [],
    annualFeeCents: 0,
    trialAllowed: false,
    trialPriceCents: 0,
    makeupPolicy: {
      creditsPerTerm: 2,
      expiryDays: 60,
      eligibleLevelIds: null,
      eligibleOfferingIds: null,
    },
    siblingDiscountBps: [],
    status: 'active' as const,
  };
}

test('SEC-002: class offering routes hide existing foreign IDs on direct and nested paths', async ({
  request,
}) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const apiOrigin = `http://127.0.0.1:${String(3001 + offset)}`;
  const apiBase = `${apiOrigin}/api/v1/classes/orgs`;
  const webOrigin = `https://127.0.0.1:${String(5173 + offset)}`;

  try {
    const factories = createTestFactories(database);
    const own = await factories.actor();
    const foreign = await factories.actor();
    const foreignPersonId = await factories.person(foreign);
    const ownProgram = await factories.program(own);
    const foreignProgram = await factories.program(foreign);
    const foreignSkills = new PostgresClassSkills(database, foreign);
    const foreignLevel = await foreignSkills.createLevel({
      sportProfileId: foreignProgram.sportProfileId,
      name: 'Foreign class level',
      description: null,
    });
    const foreignSkill = await foreignSkills.addSkill(foreignLevel.id, {
      name: 'Foreign class skill',
      description: null,
      videoUrl: null,
    });
    const withOrg = createWithOrg(database);

    for (const [actor, programId] of [
      [own, ownProgram.programId],
      [foreign, foreignProgram.programId],
    ] as const) {
      await withOrg(actor, async (trx) => {
        await trx
          .updateTable('programs')
          .set({ mode: 'class', status: 'published', visibility: 'public' })
          .where('org_id', '=', actor.orgId)
          .where('id', '=', programId)
          .execute();
        await trx
          .updateTable('role_assignments')
          .set({ pending_mfa: false })
          .where('org_id', '=', actor.orgId)
          .where('account_id', '=', actor.accountId)
          .execute();
      });
    }

    const ownOffering = await new PostgresClassOfferings(database, own).create(
      offeringInput(ownProgram.programId),
    );
    const foreignOffering = await new PostgresClassOfferings(
      database,
      foreign,
    ).create(offeringInput(foreignProgram.programId));
    const foreignSchedule = await new PostgresClassSchedules(
      database,
      foreign,
    ).create(
      foreignOffering.id,
      {
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: ['TH'],
          startsOn: '2026-10-01',
          endsOn: '2026-10-01',
          exceptions: [],
          additions: [],
        },
        startTime: '10:00',
        durationMinutes: 60,
        timezone: 'America/Chicago',
        spaceId: null,
        locationText: 'Tenant isolation fixture',
        termStart: '2026-10-01',
        termEnd: '2026-10-01',
      },
      [],
    );
    const foreignSessions = await new PostgresClassSessions(
      database,
      foreign,
    ).list({
      offeringId: foreignOffering.id,
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
      limit: 10,
    });
    const foreignSession = foreignSessions[0];
    if (!foreignSession)
      throw new Error('Expected a materialized foreign class session');
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: own.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );

    let apiReady = false;
    for (let attempt = 0; attempt < 50 && !apiReady; attempt += 1) {
      try {
        const health = await request.get(`${apiOrigin}/healthz`, {
          timeout: 500,
        });
        apiReady = health.status() === 200;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    expect(
      apiReady,
      'API server should start before the security requests',
    ).toBe(true);

    const headers = {
      Cookie: `__Host-athlentry_session=${session.token}`,
      Origin: webOrigin,
    };
    const ownResponse = await request.get(
      `${apiBase}/${own.orgId}/offerings/${ownOffering.id}`,
      { headers },
    );
    expect(ownResponse.status()).toBe(200);
    const ownSchedules = await request.get(
      `${apiBase}/${own.orgId}/offerings/${ownOffering.id}/schedules`,
      { headers },
    );
    expect(ownSchedules.status()).toBe(200);
    const ownWaitlist = await request.get(
      `${apiBase}/${own.orgId}/offerings/${ownOffering.id}/waitlist`,
      { headers },
    );
    expect(ownWaitlist.status()).toBe(200);

    const offeringPath = `${apiBase}/${own.orgId}/offerings/${ownOffering.id}`;
    const missingRequestMarker = await request.patch(offeringPath, {
      headers,
      data: {},
    });
    expect(missingRequestMarker.status()).toBe(403);

    const hostileOrigin = await request.patch(offeringPath, {
      headers: {
        ...headers,
        Origin: 'https://attacker.invalid',
        'X-Athlentry-Request': '1',
      },
      data: {},
    });
    expect(hostileOrigin.status()).toBe(403);

    const foreignResponse = await request.get(
      `${apiBase}/${own.orgId}/offerings/${foreignOffering.id}`,
      { headers },
    );
    expect(foreignResponse.status()).toBe(404);
    const foreignSchedules = await request.get(
      `${apiBase}/${own.orgId}/offerings/${foreignOffering.id}/schedules`,
      { headers },
    );
    expect(foreignSchedules.status()).toBe(404);
    const foreignWaitlist = await request.get(
      `${apiBase}/${own.orgId}/offerings/${foreignOffering.id}/waitlist`,
      { headers },
    );
    expect(foreignWaitlist.status()).toBe(404);

    const foreignSchedulePath = `${apiBase}/${own.orgId}/schedules/${foreignSchedule.id}`;
    const foreignScheduleInstructors = await request.get(
      `${foreignSchedulePath}/instructors`,
      { headers },
    );
    expect(foreignScheduleInstructors.status()).toBe(404);
    const foreignSchedulePatch = await request.patch(foreignSchedulePath, {
      headers: { ...headers, 'X-Athlentry-Request': '1' },
      data: { expectedVersion: foreignSchedule.version, regenerate: false },
    });
    expect(foreignSchedulePatch.status()).toBe(404);

    const foreignSessionPath = `${apiBase}/${own.orgId}/sessions/${foreignSession.id}`;
    const foreignSessionResponse = await request.get(foreignSessionPath, {
      headers,
    });
    expect(foreignSessionResponse.status()).toBe(404);
    const foreignRoster = await request.get(`${foreignSessionPath}/roster`, {
      headers,
    });
    expect(foreignRoster.status()).toBe(404);
    const foreignPickups = await request.get(
      `${foreignSessionPath}/people/${foreignPersonId}/pickups`,
      { headers },
    );
    expect(foreignPickups.status()).toBe(404);

    const foreignLevelPath = `${apiBase}/${own.orgId}/levels/${foreignLevel.id}`;
    const foreignLevelResponse = await request.get(foreignLevelPath, {
      headers,
    });
    expect(foreignLevelResponse.status()).toBe(404);
    const foreignLevelPatch = await request.patch(foreignLevelPath, {
      headers: { ...headers, 'X-Athlentry-Request': '1' },
      data: {
        expectedVersion: foreignLevel.version,
        name: 'Cross-tenant edit',
      },
    });
    expect(foreignLevelPatch.status()).toBe(404);
    const foreignSkillPatch = await request.patch(
      `${apiBase}/${own.orgId}/skills/${foreignSkill.id}`,
      {
        headers: { ...headers, 'X-Athlentry-Request': '1' },
        data: {
          expectedVersion: foreignSkill.version,
          name: 'Cross-tenant edit',
        },
      },
    );
    expect(foreignSkillPatch.status()).toBe(404);
    const foreignProgress = await request.get(
      `${apiBase}/${own.orgId}/people/${foreignPersonId}/progress`,
      { headers },
    );
    expect(foreignProgress.status()).toBe(404);

    const foreignPatch = await request.patch(
      `${apiBase}/${own.orgId}/offerings/${foreignOffering.id}`,
      {
        headers: { ...headers, 'X-Athlentry-Request': '1' },
        data: {
          expectedVersion: foreignOffering.version,
          name: 'Cross-tenant tampering attempt',
        },
      },
    );
    expect(foreignPatch.status()).toBe(404);
    const foreignAfterPatch = await new PostgresClassOfferings(
      database,
      foreign,
    ).get(foreignOffering.id);
    expect(foreignAfterPatch.name).toBe(foreignOffering.name);
  } finally {
    await database.destroy();
  }
});

import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import type { ActorFixture } from '../../server/test/factories';
import { createTestFactories } from '../../server/test/factories';
import { e2eDatabaseUrl } from '../database';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('QA-SEC-012 / Track J: revoked roster sharing hides the league entry snapshot immediately', async ({
  request,
}) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  const withOrg = createWithOrg(database);
  const apiBase = `http://127.0.0.1:${String(3001 + offset)}`;
  const origin = `https://127.0.0.1:${String(5173 + offset)}`;

  const authHeaders = (token: string, mutation = false) => ({
    Cookie: `__Host-athlentry_session=${token}`,
    ...(mutation
      ? {
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': newId(),
        }
      : {}),
  });

  const sessionFor = async (actor: ActorFixture): Promise<string> => {
    await withOrg(actor, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute(),
    );
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    return session.token;
  };

  try {
    const factories = createTestFactories(database);
    const league = await factories.actor();
    const club = await factories.actor();
    const leagueProgram = await factories.program(league);
    const clubProgram = await factories.program(club);
    const team = await factories.team(club, clubProgram);
    const personId = await factories.person(club, {
      firstName: 'RosterRevocationSecret',
      lastName: 'QA',
    });
    await withOrg(league, (trx) =>
      trx
        .updateTable('registration_offerings')
        .set({ registrant_role: 'team_entry', active: true })
        .where('org_id', '=', league.orgId)
        .where('id', '=', leagueProgram.offeringId)
        .execute(),
    );
    await withOrg(club, (trx) =>
      trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: club.orgId,
          team_season_id: team.teamSeasonId,
          person_id: personId,
          status: 'active',
        })
        .execute(),
    );

    const leagueSession = await sessionFor(league);
    const clubSession = await sessionFor(club);
    const leagueApi = `${apiBase}/api/v1/federation/organizations/${league.orgId}`;
    const clubApi = `${apiBase}/api/v1/federation/organizations/${club.orgId}`;

    const inviteResponse = await request.post(`${leagueApi}/relationships`, {
      headers: authHeaders(leagueSession, true),
      data: {
        direction: 'invite',
        organizationId: club.orgId,
        type: 'member_club',
        dataSharing: { rosters: true, team_entries: true },
      },
    });
    expect(inviteResponse.status()).toBe(201);
    const relationship = (await inviteResponse.json()) as { id: string };

    const acceptResponse = await request.post(
      `${clubApi}/relationships/${relationship.id}/accept`,
      { headers: authHeaders(clubSession, true), data: {} },
    );
    expect(acceptResponse.status()).toBe(200);

    const entryResponse = await request.post(`${clubApi}/submitted-entries`, {
      headers: authHeaders(clubSession, true),
      data: {
        leagueOrgId: league.orgId,
        programId: leagueProgram.programId,
        divisionId: leagueProgram.divisionId,
        teamSeasonId: team.teamSeasonId,
      },
    });
    expect(entryResponse.status()).toBe(201);
    const entry = (await entryResponse.json()) as {
      id: string;
      version: number;
    };
    const reviewResponse = await request.post(
      `${leagueApi}/entries/${entry.id}/review`,
      {
        headers: authHeaders(leagueSession, true),
        data: { action: 'accept', version: entry.version },
      },
    );
    expect(reviewResponse.status()).toBe(200);

    const activeRelationship = await withOrg(club, (trx) =>
      trx
        .selectFrom('org_relationships')
        .select(['id', 'version'])
        .where('parent_org_id', '=', league.orgId)
        .where('child_org_id', '=', club.orgId)
        .executeTakeFirstOrThrow(),
    );
    const revokeResponse = await request.post(
      `${clubApi}/relationships/${activeRelationship.id}/sharing`,
      {
        headers: authHeaders(clubSession, true),
        data: {
          dataSharing: { team_entries: true },
          version: activeRelationship.version,
        },
      },
    );
    expect(revokeResponse.status()).toBe(200);

    const savedAgreement = await withOrg(club, (trx) =>
      trx
        .selectFrom('org_relationships')
        .select('data_sharing')
        .where('id', '=', activeRelationship.id)
        .executeTakeFirstOrThrow(),
    );
    expect(
      (savedAgreement.data_sharing as { rosters?: boolean }).rosters,
    ).not.toBe(true);

    const memberTeamsResponse = await request.get(
      `${leagueApi}/members/${club.orgId}/teams`,
      { headers: authHeaders(leagueSession) },
    );
    expect(memberTeamsResponse.status()).toBe(200);
    const memberTeams = (await memberTeamsResponse.json()) as {
      teams: Array<Record<string, unknown>>;
    };
    const visibleTeam = memberTeams.teams.find(
      (candidate) => candidate.teamSeasonId === team.teamSeasonId,
    );
    expect(visibleTeam).toBeDefined();
    expect(visibleTeam).not.toHaveProperty('rosterSize');

    const listResponse = await request.get(`${leagueApi}/entries`, {
      headers: authHeaders(leagueSession),
    });
    expect(listResponse.status()).toBe(200);
    const listPayload = (await listResponse.json()) as {
      items: Array<{
        id: string;
        snapshot: { playerCount: number } | null;
      }>;
    };
    const listedEntry = listPayload.items.find((item) => item.id === entry.id);
    expect(listedEntry).toBeDefined();
    expect(listedEntry?.snapshot).toBeNull();

    const detailResponse = await request.get(
      `${leagueApi}/entries/${entry.id}`,
      { headers: authHeaders(leagueSession) },
    );
    expect(detailResponse.status()).toBe(200);
    const detail = (await detailResponse.json()) as {
      roster: {
        players: Array<{ personRef: string; firstName: string }>;
      } | null;
    };
    expect(detail.roster).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('RosterRevocationSecret');
    expect(JSON.stringify(detail)).not.toContain(personId);
  } finally {
    await database.destroy();
  }
});

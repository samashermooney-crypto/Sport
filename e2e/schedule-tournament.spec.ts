import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl } from './database';


test('director generates and publishes a seeded 13-team double-elimination bracket', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const teams = [];
    for (let index = 0; index < 13; index += 1) {
      const team = await factories.team(actor, program);
      teams.push(team);
      await createWithOrg(database)(actor, (trx) =>
        trx
          .updateTable('teams')
          .set({ name: `Cup Team ${String(index + 1).padStart(2, '0')}` })
          .where('org_id', '=', actor.orgId)
          .where('id', '=', team.teamId)
          .execute()
          .then(() => undefined),
      );
    }
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute()
        .then(() => undefined),
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
    const baseURL = String(testInfo.project.use.baseURL);
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    await page.getByLabel('Program *').selectOption(program.programId);
    const panel = page.locator('section[aria-labelledby="tournament-heading"]');
    const form = panel.locator('form').first();
    await form.getByLabel('Tournament name').fill('13 Team Weekend Cup');
    const division = form.getByLabel('Division');
    await expect(division).toBeEnabled();
    await division.selectOption(program.divisionId);
    await expect(division).toHaveValue(program.divisionId);
    await form.getByLabel('Format').selectOption('double_elim');
    for (let index = 0; index < teams.length; index += 1) {
      const label = `Cup Team ${String(index + 1).padStart(2, '0')}`;
      const entry = form.getByLabel(`Add ${label} to tournament`);
      await form.getByText(label, { exact: true }).click();
      await expect(entry).toBeChecked();
      await expect(form.getByLabel(`Seed for ${label}`)).toHaveValue(
        String(index + 1),
      );
    }
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith('/tournaments/orgs/' + actor.orgId + '/brackets'),
    );
    await form.getByRole('button', { name: 'Create tournament' }).click();
    const createdResponse = await createResponse;
    expect(createdResponse.ok()).toBe(true);
    const created = (await createdResponse.json()) as { id: string };

    const generateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/brackets/${created.id}/generate`),
    );
    await panel.getByRole('button', { name: 'Generate bracket' }).click();
    expect((await generateResponse).ok()).toBe(true);
    await expect(panel.getByRole('status')).toHaveText('Bracket generated.');
    await expect(
      panel.getByText('13 Team Weekend Cup', { exact: true }),
    ).toBeVisible();
    await expect(panel.locator('.table-scroll').first()).toBeVisible();

    const persisted = await createWithOrg(database)(actor, async (trx) => {
      const bracket = await trx
        .selectFrom('brackets')
        .select(['status', 'version'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      const entriesCount = await trx
        .selectFrom('tournament_entries')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', actor.orgId)
        .where('bracket_id', '=', created.id)
        .executeTakeFirstOrThrow();
      const matches = await trx
        .selectFrom('bracket_matches')
        .select(['round', 'participant_a', 'participant_b'])
        .where('org_id', '=', actor.orgId)
        .where('bracket_id', '=', created.id)
        .execute();
      return { bracket, entriesCount: entriesCount.count, matches };
    });
    expect(persisted.bracket.status).not.toBe('draft');
    expect(persisted.entriesCount).toBe(13);
    const openingWinnersMatches = persisted.matches.filter((match) => {
      const home = match.participant_a as { bracketKind?: string } | null;
      const away = match.participant_b as { bracketKind?: string } | null;
      return (
        home?.bracketKind === 'winners' &&
        away?.bracketKind === 'winners' &&
        match.round === 1
      );
    });
    expect(openingWinnersMatches).toHaveLength(8);
    expect(
      openingWinnersMatches.filter((match) => {
        const home = match.participant_a as { finalized?: boolean } | null;
        const away = match.participant_b as { finalized?: boolean } | null;
        return home?.finalized && away?.finalized;
      }),
    ).toHaveLength(3);

    const organization = await database
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', actor.orgId)
      .executeTakeFirstOrThrow();
    await page.goto(`/orgs/${organization.slug}/tournaments/${created.id}`);
    await expect(
      page.getByRole('heading', { name: '13 Team Weekend Cup' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Print bracket / Save PDF' }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Cup Team 01', exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Cup Team 13', exact: true }).first(),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});

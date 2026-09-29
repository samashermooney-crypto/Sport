import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import {
  issueSession,
  resolveSession,
  rotateSessionForStepUp,
} from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('owner keyboards through privacy deletion and confirms anonymization', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const now = new Date();
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const personId = await factories.person(actor);
    const withOrg = createWithOrg(database);
    await withOrg(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
    });
    const session = await database.transaction().execute(async (trx) => {
      const issued = await issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: true,
          mfaVerifiedAt: now,
        },
        now,
      );
      const active = await resolveSession(trx, issued.token, now);
      if (!active) throw new Error('New test session did not resolve');
      const elevated = await rotateSessionForStepUp(trx, active, now);
      if (!elevated) throw new Error('Test session step-up failed');
      return elevated;
    });
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: String(testInfo.project.use.baseURL),
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.addInitScript(() => {
      localStorage.setItem('athlentry-language', 'en');
    });

    await page.goto(`/console/orgs/${actor.orgId}/data`);
    await expect(
      page.getByRole('heading', { name: 'Privacy requests and retention' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const requestType = page.getByLabel('Request type');
    await requestType.focus();
    await requestType.press('d');
    await expect(requestType).toHaveValue('deletion');

    const subjectId = page.getByLabel('Subject ID');
    await subjectId.focus();
    await page.keyboard.type(personId);
    const createRequest = page.getByRole('button', { name: 'Create request' });
    await createRequest.focus();
    await expect(createRequest).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Privacy request created',
    );

    const request = page.getByRole('article').filter({
      has: page.getByRole('heading', { name: 'deletion · person' }),
    });
    const startReview = request.getByRole('button', { name: 'Start review' });
    await startReview.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Privacy request in review.',
    );

    const approve = request.getByRole('button', { name: 'Approve' });
    await approve.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Privacy request approved.',
    );

    const resolutionNote = request.getByLabel(/^Resolution note for /);
    await resolutionNote.focus();
    await page.keyboard.type('Approved deletion; evidence retained.');
    const complete = request.getByRole('button', {
      name: 'Anonymize subject and complete',
    });
    await complete.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Privacy request completed.',
    );

    const person = await withOrg(actor, (trx) =>
      trx
        .selectFrom('people')
        .select(['first_name', 'last_name', 'email', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', personId)
        .executeTakeFirstOrThrow(),
    );
    expect(person).toEqual({
      first_name: 'Deleted',
      last_name: 'Person',
      email: null,
      status: 'anonymized',
    });
  } finally {
    await database.destroy();
  }
});

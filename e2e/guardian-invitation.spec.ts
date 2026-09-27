import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('staff invites a guardian and the verified adult accepts on a phone', async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const guardianContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const factories = createTestFactories(database);
    const staff = await factories.actor();
    await createWithOrg(database)(staff, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', staff.orgId)
        .where('account_id', '=', staff.accountId)
        .execute();
    });
    const childId = await factories.person(staff, {
      firstName: 'Mia',
      lastName: 'Rivera',
    });
    const guardianId = newId();
    const guardianEmail = `guardian-${randomUUID()}@example.invalid`;
    await database
      .insertInto('accounts')
      .values({
        id: guardianId,
        email: guardianEmail,
        first_name: 'Jordan',
        last_name: 'Rivera',
        date_of_birth: '1980-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    const staffSession = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: staff.accountId,
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
        value: staffSession.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.goto(`/console/orgs/${staff.orgId}/people/${childId}`);
    await page
      .getByRole('textbox', { name: 'Existing verified adult account email' })
      .fill(guardianEmail);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(
      page.getByText(
        'Guardian invitation sent. The recipient must verify their email and accept.',
      ),
    ).toBeVisible();
    let link = '';
    await expect
      .poll(async () => {
        const mailbox = (await (
          await request.get(
            `http://127.0.0.1:${String(8025 + offset)}/api/v1/messages`,
          )
        ).json()) as {
          messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
        };
        for (const message of mailbox.messages) {
          if (
            !message.To.some((recipient) => recipient.Address === guardianEmail)
          )
            continue;
          const detail = (await (
            await request.get(
              `http://127.0.0.1:${String(8025 + offset)}/api/v1/message/${message.ID}`,
            )
          ).json()) as { Text: string };
          link =
            /https?:\/\/[^\s]+\/guardian-invitations\/[0-9a-f-]+\/[A-Za-z0-9_-]+/.exec(
              detail.Text,
            )?.[0] ?? '';
          if (link) break;
        }
        return link;
      })
      .not.toBe('');
    const guardianSession = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: guardianId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    await guardianContext.addCookies([
      {
        name: '__Host-athlentry_session',
        value: guardianSession.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const guardianPage = await guardianContext.newPage();
    await guardianPage.goto(link);
    await expect(
      guardianPage.getByRole('heading', { name: 'Guardian invitation' }),
    ).toBeVisible();
    expect(await accessibilityViolations(guardianPage)).toEqual([]);
    await guardianPage
      .getByRole('button', { name: 'Accept guardian invitation' })
      .click();
    await expect(
      guardianPage.getByText('Guardian access is active.'),
    ).toBeVisible();
    const links = await createWithOrg(database)(staff, (trx) =>
      trx
        .selectFrom('person_account_links')
        .select(['account_id', 'verified_at'])
        .where('org_id', '=', staff.orgId)
        .where('person_id', '=', childId)
        .where('relationship', '=', 'guardian')
        .where('revoked_at', 'is', null)
        .execute(),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.account_id).toBe(guardianId);
    expect(links[0]?.verified_at).not.toBeNull();
  } finally {
    await guardianContext.close();
    await database.destroy();
  }
});

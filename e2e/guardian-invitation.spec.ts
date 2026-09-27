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
    const secondOrg = await factories.actor();
    const secondChildId = await factories.person(secondOrg, {
      firstName: 'Zoe',
      lastName: 'Morgan',
    });
    await createWithOrg(database)(secondOrg, async (trx) => {
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: secondOrg.orgId,
          person_id: secondChildId,
          account_id: guardianId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
    });
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
    await guardianPage.goto('/me/family');
    await expect(
      guardianPage.getByRole('heading', { name: 'Your family' }),
    ).toBeVisible();
    await expect(guardianPage.getByText('Mia Rivera')).toBeVisible();
    await expect(guardianPage.getByText('Zoe Morgan')).toBeVisible();
    expect(await accessibilityViolations(guardianPage)).toEqual([]);
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

test('staff issues an adult profile claim and the invited account accepts', async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const recipientContext = await browser.newContext({
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
    const adultId = await factories.person(staff, {
      firstName: 'Taylor',
      lastName: 'Rivera',
      dateOfBirth: '1980-01-01',
    });
    const recipientId = newId();
    const email = `claim-${randomUUID()}@example.invalid`;
    await database
      .insertInto('accounts')
      .values({
        id: recipientId,
        email,
        first_name: 'Taylor',
        last_name: 'Rivera',
        date_of_birth: '1980-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    const baseURL = String(testInfo.project.use.baseURL);
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
    await page.goto(`/console/orgs/${staff.orgId}/people/${adultId}`);
    await page
      .getByRole('textbox', { name: 'Adult account email', exact: true })
      .fill(email);
    await page.getByRole('button', { name: 'Send profile invitation' }).click();
    await expect(
      page.getByText(
        'Profile invitation sent. The recipient must verify their email and accept.',
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
          if (!message.To.some((recipient) => recipient.Address === email))
            continue;
          const detail = (await (
            await request.get(
              `http://127.0.0.1:${String(8025 + offset)}/api/v1/message/${message.ID}`,
            )
          ).json()) as { Text: string };
          link =
            /https?:\/\/[^\s]+\/claim-person\/[0-9a-f-]+\/[A-Za-z0-9_-]+/.exec(
              detail.Text,
            )?.[0] ?? '';
          if (link) break;
        }
        return link;
      })
      .not.toBe('');
    const recipientSession = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: recipientId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    await recipientContext.addCookies([
      {
        name: '__Host-athlentry_session',
        value: recipientSession.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const recipientPage = await recipientContext.newPage();
    await recipientPage.goto(link);
    await expect(
      recipientPage.getByRole('heading', { name: 'Claim your profile' }),
    ).toBeVisible();
    expect(await accessibilityViolations(recipientPage)).toEqual([]);
    await recipientPage.getByRole('button', { name: 'Claim profile' }).click();
    await expect(
      recipientPage.getByText('Your profile is linked.'),
    ).toBeVisible();
    await recipientPage.goto('/me/family');
    await expect(recipientPage.getByText('Taylor Rivera')).toBeVisible();
    await expect(recipientPage.getByText('Your profile')).toBeVisible();
    expect(await accessibilityViolations(recipientPage)).toEqual([]);
  } finally {
    await recipientContext.close();
    await database.destroy();
  }
});

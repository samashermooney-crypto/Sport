import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import {
  issueSession,
  stepUpSession,
} from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';
import { newId } from '../shared/src/ids';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl, e2eMailpitApiBaseUrl } from './database';

const connection = e2eDatabaseUrl('app');
const mailpit = `${e2eMailpitApiBaseUrl()}/api/v1/messages`;

test('recipient accepts owner transfer from the staff screen', async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(connection);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const now = new Date();
    const factory = createTestFactories(database);
    const actor = await factory.actor();
    const program = await factory.program(actor);
    const recipientId = newId();
    const recipientEmail = `transfer-${randomUUID()}@example.invalid`;
    await database
      .insertInto('accounts')
      .values({
        id: recipientId,
        email: recipientEmail,
        first_name: 'Future',
        last_name: 'Owner',
        date_of_birth: '1990-01-01',
        email_verified_at: now,
      })
      .execute();
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: actor.orgId,
          account_id: recipientId,
          status: 'active',
          joined_at: now,
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: actor.orgId,
          account_id: recipientId,
          role: 'registrar',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    for (const accountId of [actor.accountId, recipientId]) {
      await database
        .insertInto('mfa_factors')
        .values({
          id: newId(),
          account_id: accountId,
          type: 'totp',
          secret_enc: Buffer.alloc(32),
          confirmed_at: now,
        })
        .execute();
    }
    const ownerSession = await database.transaction().execute(async (trx) => {
      const session = await issueSession(
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
      await stepUpSession(trx, session.id, actor.accountId, now);
      return session;
    });
    const baseURL = String(testInfo.project.use.baseURL);
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: ownerSession.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.goto(`/orgs/${actor.orgId}/profile`);
    await expect(
      page.getByRole('heading', { name: 'Organization profile' }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: /Organization name/ })
      .fill('Updated Fixture Club');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status')).toContainText('profile saved');
    await page
      .getByLabel('Choose logo')
      .setInputFiles('e2e/visual-reference/sign-in-390.png');
    await page.getByRole('button', { name: 'Upload logo and save' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Logo uploaded' }),
    ).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'Updated Fixture Club logo' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.goto(`/orgs/${actor.orgId}/staff`);
    const member = page.getByRole('region', { name: 'Roles for Future Owner' });
    await expect(member).toBeVisible();
    await member
      .getByRole('combobox', { name: /Select scope/ })
      .selectOption(program.programId);
    await member.getByRole('button', { name: 'Grant scoped role' }).click();
    await expect(member).toContainText('Scoped role granted');
    expect(await accessibilityViolations(page)).toEqual([]);
    page.once('dialog', (dialog) => void dialog.accept());
    await member
      .getByRole('button', { name: 'Request ownership transfer' })
      .click();
    await expect(member).toContainText('Ownership acceptance link sent');
    let link = '';
    await expect
      .poll(async () => {
        const response = await request.get(mailpit);
        const mailbox = (await response.json()) as {
          messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
        };
        for (const message of mailbox.messages) {
          if (!message.To.some((item) => item.Address === recipientEmail))
            continue;
          const detailResponse = await request.get(
            `${e2eMailpitApiBaseUrl()}/api/v1/message/${message.ID}`,
          );
          const detail = (await detailResponse.json()) as { Text: string };
          link =
            /https?:\/\/[^\s]+\/ownership-transfer\/[0-9a-f-]+\/[A-Za-z0-9_-]+/.exec(
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
          privileged: true,
          mfaVerifiedAt: new Date(),
        },
        new Date(),
      ),
    );
    await context.addCookies([
      {
        name: '__Host-athlentry_session',
        value: recipientSession.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const recipient = await context.newPage();
    await recipient.goto(link);
    await expect(
      recipient.getByRole('heading', { name: 'Accept organization ownership' }),
    ).toBeVisible();
    expect(await accessibilityViolations(recipient)).toEqual([]);
    await recipient.getByRole('button', { name: 'Accept ownership' }).click();
    await expect(recipient.getByRole('status')).toContainText(
      'Ownership transferred',
    );
    await page.goto('/me');
    await expect(
      page.getByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    await recipient.goto('/me');
    await expect(
      recipient.getByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    const roles = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('role_assignments')
        .select(['account_id', 'revoked_at'])
        .where('org_id', '=', actor.orgId)
        .where('role', '=', 'owner')
        .execute(),
    );
    expect(
      roles.find((item) => item.account_id === actor.accountId)?.revoked_at,
    ).not.toBeNull();
    expect(
      roles.find((item) => item.account_id === recipientId)?.revoked_at,
    ).toBeNull();
  } finally {
    await context.close();
    await database.destroy();
  }
});

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { newId } from '@shared/ids';
import Stripe from 'stripe';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { StripeSdkGateway } from '../server/src/integrations/stripe/sdk';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const testEmail = (): string => `phase15-${randomUUID()}@example.test`;

async function signIn(
  page: Page,
  testInfo: TestInfo,
  database: ReturnType<typeof createDatabase>,
  accountId: string,
): Promise<void> {
  const session = await database
    .transaction()
    .execute((trx) =>
      issueSession(
        trx,
        { accountId, kind: 'cookie', client: 'web', privileged: false },
        new Date(),
      ),
    );
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
}

function makeZip(entries: { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offsetBytes = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const bytes = Buffer.from(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(bytes.length, 20);
    centralHeader.writeUInt32LE(bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offsetBytes, 42);
    central.push(centralHeader, name);
    offsetBytes += header.length + name.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offsetBytes, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

test('a new organization persists and auto-completes its nine setup items using Stripe mock', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const withOrg = createWithOrg(database);
    await withOrg(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
    });

    // Create the connected account against the local stripe-mock container.
    const stripe = new Stripe('sk_test_mock', {
      host: '127.0.0.1',
      port: 12111 + offset,
      protocol: 'http',
    });
    const stripeAccount = await new StripeSdkGateway(
      'sk_test_mock',
      stripe,
    ).createExpressAccount({
      orgId: actor.orgId,
      email: testEmail(),
      idempotencyKey: `phase15:${actor.orgId}`,
    });

    const fixtureProgram = await factories.program(actor);
    await withOrg(actor, async (trx) => {
      const now = new Date();
      await trx
        .insertInto('payment_accounts')
        .values({
          id: newId(),
          org_id: actor.orgId,
          stripe_account_id: stripeAccount.id,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          onboarding_status: 'active',
        })
        .execute();
      await trx
        .updateTable('programs')
        .set({
          registration_opens_at: new Date(now.getTime() - 60_000),
          registration_closes_at: new Date(now.getTime() + 86_400_000),
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', fixtureProgram.programId)
        .execute();
      await trx
        .updateTable('organizations')
        .set({ website_url: 'https://fixture.example.test' })
        .where('id', '=', actor.orgId)
        .execute();
      await trx
        .insertInto('facilities')
        .values({
          id: newId(),
          org_id: actor.orgId,
          name: 'Fixture Field',
          ownership: 'owned',
        })
        .execute();
      await trx
        .insertInto('credential_types')
        .values({
          id: newId(),
          org_id: actor.orgId,
          key: 'coach_safety',
          name: 'Coach safety',
          verification: 'manual_staff',
          validity: {},
          applies_to: { roles: ['head_coach'] },
          blocks_activation: true,
        })
        .execute();
    });
    await withOrg(actor, async (trx) => {
      const type = await trx
        .selectFrom('credential_types')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('key', '=', 'coach_safety')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('role_credential_requirements')
        .values({
          id: newId(),
          org_id: actor.orgId,
          credential_type_id: type.id,
          role: 'head_coach',
          scope_type: 'org',
          active: true,
          minimum_age: 18,
        })
        .execute();
      await trx
        .insertInto('phase15_import_batches')
        .values({
          id: newId(),
          org_id: actor.orgId,
          kind: 'people',
          file_name: 'members.csv',
          file_bytes: 1,
          status: 'committed',
          created_by: actor.accountId,
          committed_at: new Date(),
        })
        .execute();
      const staffId = newId();
      await database
        .insertInto('accounts')
        .values({
          id: staffId,
          email: testEmail(),
          first_name: 'Second',
          last_name: 'Staff',
          date_of_birth: '1988-01-01',
          email_verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: actor.orgId,
          account_id: staffId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
    });

    await signIn(page, testInfo, database, actor.accountId);
    await page.goto(`/console/orgs/${actor.orgId}/onboarding`);
    await expect(
      page.getByRole('heading', { name: 'Organization setup' }),
    ).toBeVisible();
    await expect(page.getByText('9/9 done')).toBeVisible();
    await expect(page.getByText('Connect payments')).toBeVisible();
    await expect(page.getByText('Open registration')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const persisted = await withOrg(actor, (trx) =>
      trx
        .selectFrom('org_onboarding_items')
        .select('completed_at')
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(persisted).toHaveLength(9);
    expect(persisted.every((item) => item.completed_at !== null)).toBe(true);

    let aiRequests = 0;
    await page.route('**/api/v1/ai/**', async (route) => {
      aiRequests += 1;
      await route.continue();
    });
    await page.goto(`/console/orgs/${actor.orgId}/ai`);
    await expect(
      page.getByRole('heading', { name: 'AI assistance' }),
    ).toHaveCount(0);
    expect(aiRequests).toBe(0);
  } finally {
    await database.destroy();
  }
});

test('staff previews, commits, and reverses team, roster, and credential imports', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const email = testEmail();
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
    });
    const program = await factories.program(actor);
    const personId = await factories.person(actor, {
      firstName: 'Robin',
      lastName: 'Player',
    });
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('people')
        .set({ email })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', personId)
        .execute()
        .then(() => undefined),
    );
    await signIn(page, testInfo, database, actor.accountId);
    await page.goto(`/console/orgs/${actor.orgId}/onboarding/imports`);
    await expect(page.getByRole('heading', { name: 'Imports' })).toBeVisible();

    const upload = async (
      name: string,
      mimeType: string,
      buffer: Buffer,
      kind: string,
    ): Promise<void> => {
      await page.getByLabel('Import type').selectOption(kind);
      await page.getByLabel('File').setInputFiles({ name, mimeType, buffer });
      const uploadResponse = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes(`/api/v1/imports/orgs/${actor.orgId}/phase15/batches`) &&
          response.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: 'Upload' }).click();
      const response = await uploadResponse;
      if (!response.ok())
        throw new Error(
          `Import upload returned ${String(response.status())}: ${await response.text()}`,
        );
      await expect(page.getByRole('heading', { name })).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole('button', { name: 'Save mapping' }).click();
      await page.getByRole('button', { name: 'Validate rows' }).click();
      await expect(page.getByRole('heading', { name: 'Commit' })).toBeVisible({
        timeout: 45_000,
      });
      await page.getByRole('button', { name: 'Commit import' }).click();
      await expect(
        page.getByRole('heading', { name: 'Committed' }),
      ).toBeVisible({ timeout: 45_000 });
      expect(await accessibilityViolations(page)).toEqual([]);
    };
    const rollback = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Roll back this import' }).click();
      await expect(
        page.getByRole('heading', { name: 'Rolled back' }),
      ).toBeVisible({ timeout: 30_000 });
      expect(await accessibilityViolations(page)).toEqual([]);
    };

    await upload(
      'teams.csv',
      'text/csv',
      Buffer.from(
        `Team name,Program,Division\nPhase 15 Falcons,Fixture League,Open`,
      ),
      'teams',
    );
    await page.getByRole('button', { name: 'Back to imports' }).click();
    await upload(
      'roster.csv',
      'text/csv',
      Buffer.from(
        `Team name,Program,Person email,Role,Number\nPhase 15 Falcons,Fixture League,${email},player,12`,
      ),
      'rosters',
    );
    await rollback();
    await page.getByRole('button', { name: 'Back to imports' }).click();
    await upload(
      'credentials.zip',
      'application/zip',
      makeZip([
        {
          name: 'credentials.csv',
          bytes: Buffer.from(
            `Person email,Credential type,Status,Expires on,Identifier,Document file\n${email},Background check,verified,2027-01-01,ABC-123,check.pdf`,
          ),
        },
        { name: 'docs/check.pdf', bytes: Buffer.from('%PDF-1.4 fixture') },
      ]),
      'credentials',
    );
    await rollback();
    await page.getByRole('button', { name: 'Back to imports' }).click();
    const teamRow = page.getByRole('row').filter({ hasText: 'teams.csv' });
    await teamRow.getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: 'Roll back this import' }).click();
    await expect(
      page.getByRole('heading', { name: 'Rolled back' }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Back to imports' }).click();
    for (const filename of ['teams.csv', 'roster.csv', 'credentials.zip']) {
      const row = page.getByRole('row').filter({ hasText: filename });
      await expect(row).toBeVisible();
      await expect(row).toContainText('rolled_back');
    }

    const status = await createWithOrg(database)(actor, async (trx) => {
      const team = await trx
        .selectFrom('teams')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('name', '=', 'Phase 15 Falcons')
        .executeTakeFirstOrThrow();
      const season = await trx
        .selectFrom('team_seasons')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('team_id', '=', team.id)
        .executeTakeFirstOrThrow();
      const credential = await trx
        .selectFrom('person_credentials')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('person_id', '=', personId)
        .executeTakeFirstOrThrow();
      return { season: season.status, credential: credential.status };
    });
    expect(status).toEqual({ season: 'withdrawn', credential: 'revoked' });
    expect(program.programId).toBeTruthy();
  } finally {
    await database.destroy();
  }
});

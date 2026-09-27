import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { issueSession, resolveSession } from '../src/modules/auth/sessions';
import { createAthleteLinksRepository } from '../src/modules/people/athleteLinks';
import { createGuardianLinksRepository } from '../src/modules/people/guardianLinks';

import { createTestFactories } from './factories';
import type { ActorFixture } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

const timezone = 'America/Chicago';
const appUrl = 'https://athlentry.test';

function birthDate(ageYears: number, offsetDays = 0): string {
  return Temporal.PlainDate.from(orgToday(timezone))
    .subtract({ years: ageYears })
    .add({ days: offsetDays })
    .toString();
}

async function account(
  email: string,
  dateOfBirth: string,
  verified = true,
): Promise<string> {
  const id = newId();
  await database
    .insertInto('accounts')
    .values({
      id,
      email,
      first_name: 'Minor',
      last_name: 'Athlete',
      date_of_birth: dateOfBirth,
      email_verified_at: verified ? new Date() : null,
    })
    .execute();
  return id;
}

async function guardianOf(
  factories: ReturnType<typeof createTestFactories>,
  actor: ActorFixture,
  personId: string,
  accountId: string,
): Promise<string> {
  const id = newId();
  await factories.row(actor, 'person_account_links', {
    id,
    org_id: actor.orgId,
    person_id: personId,
    account_id: accountId,
    relationship: 'guardian',
    verified_at: new Date(),
  });
  return id;
}

function sentToken(sender: FakeEmailSender, index = 0): string {
  return (
    sender.messages[index]?.text.match(
      /athlete-invitations\/[0-9a-f-]+\/([A-Za-z0-9_-]{43})/,
    )?.[1] ?? ''
  );
}

it('restricts athlete link reads and invitations to a verified guardian in the same organization', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const otherOrg = await factories.actor();
  const links = createAthleteLinksRepository(database);
  const sender = new FakeEmailSender();
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );
  const strangerId = await account(
    `stranger-${randomUUID()}@example.invalid`,
    '1985-05-05',
  );
  const childId = await factories.person(staff, { dateOfBirth: birthDate(14) });
  const foreignChildId = await factories.person(otherOrg, {
    dateOfBirth: birthDate(14),
  });

  await expect(
    links.get(staff.orgId, strangerId, childId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    links.invite(
      staff.orgId,
      strangerId,
      childId,
      `a-${randomUUID()}@example.invalid`,
      sender,
      appUrl,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await guardianOf(factories, staff, childId, guardianId);
  await expect(
    links.get(otherOrg.orgId, guardianId, foreignChildId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    links.invite(
      otherOrg.orgId,
      guardianId,
      foreignChildId,
      `b-${randomUUID()}@example.invalid`,
      sender,
      appUrl,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    links.invite(
      staff.orgId,
      guardianId,
      foreignChildId,
      `c-${randomUUID()}@example.invalid`,
      sender,
      appUrl,
    ),
  ).rejects.toMatchObject({ status: 404 });

  const empty = await links.get(staff.orgId, guardianId, childId);
  expect(empty.accountId).toBeNull();
  expect(empty.email).toBeNull();
  const invitation = await links.invite(
    staff.orgId,
    guardianId,
    childId,
    `d-${randomUUID()}@example.invalid`,
    sender,
    appUrl,
  );
  expect(invitation.id).toBeTruthy();
  expect(sender.messages).toHaveLength(1);
});

it('enforces the 13–17 age window at issue on exact birthdays', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const links = createAthleteLinksRepository(database);
  const sender = new FakeEmailSender();
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );

  const cases: Array<{ offset: number; years: number; ok: boolean }> = [
    { years: 13, offset: 0, ok: true },
    { years: 13, offset: 1, ok: false },
    { years: 18, offset: 0, ok: false },
    { years: 18, offset: 1, ok: true },
    { years: 40, offset: 0, ok: false },
  ];
  for (const [index, entry] of cases.entries()) {
    const personId = await factories.person(staff, {
      dateOfBirth: birthDate(entry.years, entry.offset),
    });
    await guardianOf(factories, staff, personId, guardianId);
    const pending = links.invite(
      staff.orgId,
      guardianId,
      personId,
      `age-${String(index)}-${randomUUID()}@example.invalid`,
      sender,
      appUrl,
    );
    if (entry.ok)
      await expect(pending).resolves.toMatchObject({
        email: expect.any(String) as string,
      });
    else await expect(pending).rejects.toMatchObject({ status: 409 });
  }
  expect(sender.messages).toHaveLength(2);
});

it('binds redemption to the invited email, matching birth date and a verified account; consumes once', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const links = createAthleteLinksRepository(database);
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );
  const dob = birthDate(15);
  const childId = await factories.person(staff, { dateOfBirth: dob });
  await guardianOf(factories, staff, childId, guardianId);
  const email = `athlete-${randomUUID()}@example.invalid`;
  const sender = new FakeEmailSender();
  await links.invite(staff.orgId, guardianId, childId, email, sender, appUrl);
  const token = sentToken(sender);
  expect(token).not.toBe('');

  const athleteId = await account(email, dob, false);
  await expect(
    links.accept(staff.orgId, athleteId, token),
  ).rejects.toMatchObject({ status: 403 });
  const otherOrg = await factories.actor();
  await database
    .updateTable('accounts')
    .set({ email_verified_at: new Date() })
    .where('id', '=', athleteId)
    .execute();
  await expect(
    links.accept(otherOrg.orgId, athleteId, token),
  ).rejects.toMatchObject({ status: 404 });
  await links.invite(staff.orgId, guardianId, childId, email, sender, appUrl);
  const second = sentToken(sender, 1);
  const wrongId = await account(`wrong-${randomUUID()}@example.invalid`, dob);
  await expect(
    links.accept(staff.orgId, wrongId, second),
  ).rejects.toMatchObject({ status: 404 });
  const accepted = await links.accept(staff.orgId, athleteId, second);
  expect(accepted.personId).toBe(childId);
  await expect(
    links.accept(staff.orgId, athleteId, second),
  ).rejects.toMatchObject({ status: 404 });
  const linked = await links.get(staff.orgId, guardianId, childId);
  expect(linked.accountId).toBe(athleteId);
  expect(linked.email).toBe(email);
  await expect(
    links.invite(staff.orgId, guardianId, childId, email, sender, appUrl),
  ).rejects.toMatchObject({ status: 409 });
});

it('rejects mismatched birth dates, duplicate profile emails and existing athlete links', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const links = createAthleteLinksRepository(database);
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );
  const dob = birthDate(16);
  const childId = await factories.person(staff, { dateOfBirth: dob });
  await guardianOf(factories, staff, childId, guardianId);
  const sender = new FakeEmailSender();

  const mismatchEmail = `mismatch-${randomUUID()}@example.invalid`;
  await account(mismatchEmail, '1990-06-15');
  await expect(
    links.invite(
      staff.orgId,
      guardianId,
      childId,
      mismatchEmail,
      sender,
      appUrl,
    ),
  ).rejects.toMatchObject({ status: 409 });

  const takenEmail = `taken-${randomUUID()}@example.invalid`;
  const otherChildId = await factories.person(staff, {
    dateOfBirth: birthDate(15),
  });
  await factories.scoped(staff, (trx) =>
    trx
      .updateTable('people')
      .set({ email: takenEmail })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', otherChildId)
      .execute(),
  );
  await expect(
    links.invite(staff.orgId, guardianId, childId, takenEmail, sender, appUrl),
  ).rejects.toMatchObject({ status: 409 });

  const profileEmail = `profile-${randomUUID()}@example.invalid`;
  await factories.scoped(staff, (trx) =>
    trx
      .updateTable('people')
      .set({ email: profileEmail })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', childId)
      .execute(),
  );
  await expect(
    links.invite(
      staff.orgId,
      guardianId,
      childId,
      `other-${randomUUID()}@example.invalid`,
      sender,
      appUrl,
    ),
  ).rejects.toMatchObject({ status: 409 });

  const athleteId = await account(profileEmail, dob);
  await links.invite(
    staff.orgId,
    guardianId,
    childId,
    profileEmail,
    sender,
    appUrl,
  );
  const token = sentToken(sender, sender.messages.length - 1);
  await links.accept(staff.orgId, athleteId, token);
  await expect(
    links.invite(
      staff.orgId,
      guardianId,
      childId,
      profileEmail,
      sender,
      appUrl,
    ),
  ).rejects.toMatchObject({ status: 409 });
});

it('re-validates guardian authority, person status and profile email at redemption', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const links = createAthleteLinksRepository(database);
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );
  const dob = birthDate(14);
  const childId = await factories.person(staff, { dateOfBirth: dob });
  const linkId = await guardianOf(factories, staff, childId, guardianId);
  const sender = new FakeEmailSender();
  const email = `athlete-${randomUUID()}@example.invalid`;
  await links.invite(staff.orgId, guardianId, childId, email, sender, appUrl);
  const first = sentToken(sender);
  const athleteId = await account(email, dob);

  await factories.scoped(staff, (trx) =>
    trx
      .updateTable('person_account_links')
      .set({ revoked_at: new Date() })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', linkId)
      .execute(),
  );
  await expect(
    links.accept(staff.orgId, athleteId, first),
  ).rejects.toMatchObject({ status: 404 });
  const secondGuardianId = await account(
    `guardian2-${randomUUID()}@example.invalid`,
    '1978-03-03',
  );
  await guardianOf(factories, staff, childId, secondGuardianId);
  await links.invite(
    staff.orgId,
    secondGuardianId,
    childId,
    email,
    sender,
    appUrl,
  );
  const second = sentToken(sender, 1);
  await factories.scoped(staff, (trx) =>
    trx
      .updateTable('people')
      .set({ email: `changed-${randomUUID()}@example.invalid` })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', childId)
      .execute(),
  );
  await expect(
    links.accept(staff.orgId, athleteId, second),
  ).rejects.toMatchObject({ status: 409 });
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('people')
      .set({ email })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', childId)
      .execute();
  });
  await links.invite(
    staff.orgId,
    secondGuardianId,
    childId,
    email,
    sender,
    appUrl,
  );
  const third = sentToken(sender, 2);
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('people')
      .set({ status: 'archived' })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', childId)
      .execute();
  });
  await expect(
    links.invite(staff.orgId, secondGuardianId, childId, email, sender, appUrl),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    links.accept(staff.orgId, athleteId, third),
  ).rejects.toMatchObject({ status: 404 });
});

it('revokes the pending invitation when delivery fails', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const links = createAthleteLinksRepository(database);
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );
  const childId = await factories.person(staff, { dateOfBirth: birthDate(14) });
  await guardianOf(factories, staff, childId, guardianId);
  const email = `fail-${randomUUID()}@example.invalid`;
  await expect(
    links.invite(
      staff.orgId,
      guardianId,
      childId,
      email,
      {
        send: () => Promise.reject(new Error('preview unavailable')),
      },
      appUrl,
    ),
  ).rejects.toThrow('preview unavailable');
  const saved = await factories.scoped(staff, (trx) =>
    trx
      .selectFrom('auth_tokens')
      .select('revoked_at')
      .where('org_id', '=', staff.orgId)
      .where('purpose', '=', 'athlete_account_invitation')
      .where('email', '=', email)
      .executeTakeFirstOrThrow(),
  );
  expect(saved.revoked_at).not.toBeNull();
});

it('protects the final guardian, lets a guardian revoke the athlete link and expires athlete sessions', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', staff.orgId)
      .where('account_id', '=', staff.accountId)
      .execute();
  });
  const links = createAthleteLinksRepository(database);
  const guardians = createGuardianLinksRepository(database);
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );
  const dob = birthDate(14);
  const childId = await factories.person(staff, { dateOfBirth: dob });
  const guardianLinkId = await guardianOf(
    factories,
    staff,
    childId,
    guardianId,
  );
  const email = `athlete-${randomUUID()}@example.invalid`;
  const athleteId = await account(email, dob);
  const sender = new FakeEmailSender();
  await links.invite(staff.orgId, guardianId, childId, email, sender, appUrl);
  await links.accept(staff.orgId, athleteId, sentToken(sender));

  const session = await database.transaction().execute((trx) =>
    issueSession(
      trx,
      {
        accountId: athleteId,
        kind: 'bearer',
        client: 'ios',
        privileged: false,
      },
      new Date(),
    ),
  );
  const resolved = await database
    .transaction()
    .execute((trx) => resolveSession(trx, session.token, new Date()));
  expect(resolved?.accountId).toBe(athleteId);

  await expect(
    guardians.revoke(staff.orgId, staff.accountId, childId, guardianLinkId),
  ).rejects.toMatchObject({ status: 409 });

  const removed = await links.revoke(staff.orgId, guardianId, childId);
  expect(removed.accountId).toBeNull();
  const after = await database
    .transaction()
    .execute((trx) => resolveSession(trx, session.token, new Date()));
  expect(after).toBeNull();
  await expect(
    links.revoke(staff.orgId, guardianId, childId),
  ).rejects.toMatchObject({ status: 404 });

  const audit = await factories.scoped(staff, (trx) =>
    trx
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', childId)
      .where('action', 'like', 'athlete.%')
      .orderBy('created_at')
      .execute(),
  );
  expect(audit.map((entry) => entry.action)).toEqual([
    'athlete.invited',
    'athlete.invitation_accepted',
    'athlete.link_revoked',
  ]);
});

it('excludes adult profiles from athlete invitations and guardian revocation', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const links = createAthleteLinksRepository(database);
  const guardianId = await account(
    `guardian-${randomUUID()}@example.invalid`,
    '1980-01-01',
  );
  const adultId = await factories.person(staff, { dateOfBirth: birthDate(30) });
  await guardianOf(factories, staff, adultId, guardianId);
  const sender = new FakeEmailSender();
  await expect(
    links.invite(
      staff.orgId,
      guardianId,
      adultId,
      `adult-${randomUUID()}@example.invalid`,
      sender,
      appUrl,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const athleteId = await account(
    `self-${randomUUID()}@example.invalid`,
    birthDate(30),
  );
  await factories.row(staff, 'person_account_links', {
    id: newId(),
    org_id: staff.orgId,
    person_id: adultId,
    account_id: athleteId,
    relationship: 'self',
    verified_at: new Date(),
  });
  await expect(
    links.revoke(staff.orgId, guardianId, adultId),
  ).rejects.toMatchObject({ status: 403 });
});

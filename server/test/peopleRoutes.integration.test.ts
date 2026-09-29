import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { parseEncryptionKeys } from '../src/lib/crypto';
import type { AuthDependencies } from '../src/modules/auth/routes';
import { createPeopleRouter } from '../src/modules/people/routes';

import { createTestFactories } from './factories';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-28T18:00:00.000Z');
const email = new FakeEmailSender();
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: randomBytes(32).toString('base64') }),
  'test',
);
let database: Kysely<DB>;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let orgId: string;
let ownerId: string;
let ownerPersonId: string;
let childId: string;
let claimPersonId: string;
let linkPersonId: string;
let duplicateSurvivorId: string;
let duplicateMergedId: string;
let guardianId: string;
let guardianEmail: string;
let claimantId: string;
let athleteId: string;
let claimEmail: string;
let ownerToken: string;
let guardianToken: string;
let claimantToken: string;
let athleteToken: string;

async function account(
  emailAddress: string,
  dateOfBirth: string,
): Promise<string> {
  const id = newId();
  await database
    .insertInto('accounts')
    .values({
      id,
      email: emailAddress,
      first_name: 'Route',
      last_name: 'Account',
      date_of_birth: dateOfBirth,
      email_verified_at: now,
    })
    .execute();
  return id;
}

async function session(accountId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: accountId,
      token_hash: createHash('sha256').update(token).digest(),
      kind: 'cookie',
      client: 'web',
      privileged: false,
      idle_expires_at: new Date(now.getTime() + 3_600_000),
      absolute_expires_at: new Date(now.getTime() + 86_400_000),
    })
    .execute();
  return token;
}

async function request(
  method: string,
  path: string,
  token = ownerToken,
  body?: unknown,
  validOrigin = true,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: `__Host-athlentry_session=${token}`,
      'X-Athlentry-Request': '1',
      ...(validOrigin ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function invitationToken(index: number): string {
  const tokens = email.messages[index]?.text.match(/[A-Za-z0-9_-]{43}/g);
  const token = tokens?.at(-1);
  if (!token) throw new Error('Expected an invitation token in the fake email');
  return token;
}

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  orgId = owner.orgId;
  ownerId = owner.accountId;
  await factories.scoped(owner, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', orgId)
      .where('account_id', '=', ownerId)
      .execute();
  });
  ownerPersonId = await factories.person(owner, {
    firstName: 'Riley',
    lastName: 'Owner',
    dateOfBirth: '1985-01-01',
  });
  childId = await factories.person(owner, {
    firstName: 'Alex',
    lastName: 'Youth',
    dateOfBirth: '2012-01-01',
  });
  claimEmail = `route-claim-${randomUUID()}@example.invalid`;
  claimPersonId = await factories.person(owner, {
    firstName: 'Casey',
    lastName: 'Claim',
    dateOfBirth: '1986-05-01',
  });
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('people')
      .set({ email: claimEmail })
      .where('id', '=', claimPersonId)
      .execute()
      .then(() => undefined),
  );
  linkPersonId = await factories.person(owner, {
    firstName: 'Linked',
    lastName: 'Adult',
    dateOfBirth: '1988-02-03',
  });
  duplicateSurvivorId = await factories.person(owner, {
    firstName: 'Jordan',
    lastName: 'Miller',
    dateOfBirth: '2010-03-04',
  });
  duplicateMergedId = await factories.person(owner, {
    firstName: 'Jordan',
    lastName: 'Miller',
    dateOfBirth: '2010-03-04',
  });
  guardianEmail = `route-guardian-${randomUUID()}@example.invalid`;
  guardianId = await account(guardianEmail, '1988-02-03');
  claimantId = await account(claimEmail, '1986-05-01');
  const athleteEmail = `route-athlete-${randomUUID()}@example.invalid`;
  athleteId = await account(athleteEmail, '2012-01-01');
  await factories.row(owner, 'person_account_links', {
    id: newId(),
    org_id: orgId,
    person_id: ownerPersonId,
    account_id: ownerId,
    relationship: 'self',
    verified_at: now,
  });
  await factories.row(owner, 'person_account_links', {
    id: newId(),
    org_id: orgId,
    person_id: childId,
    account_id: guardianId,
    relationship: 'guardian',
    verified_at: now,
  });
  ownerToken = await session(ownerId);
  guardianToken = await session(guardianId);
  claimantToken = await session(claimantId);
  athleteToken = await session(athleteId);

  const app = express();
  app.use(
    '/api/v1/people',
    createPeopleRouter({
      database,
      appUrl: origin,
      clock: () => now,
      encryption,
      email,
    } as unknown as AuthDependencies),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/people`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
});

describe('people HTTP routes', () => {
  it('requires a session on every documented route before reading tenant data', async () => {
    const contactId = newId();
    const householdId = newId();
    const memberId = newId();
    const calls: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/me/family' },
      { method: 'GET', path: `/orgs/${orgId}/${childId}/medical` },
      { method: 'GET', path: `/orgs/${orgId}/${childId}/family-profile` },
      { method: 'GET', path: `/orgs/${orgId}/${childId}/family-documents` },
      {
        method: 'PATCH',
        path: `/orgs/${orgId}/${childId}/family-profile`,
        body: {},
      },
      { method: 'PATCH', path: `/orgs/${orgId}/${childId}/medical`, body: {} },
      { method: 'GET', path: `/orgs/${orgId}/${childId}/emergency-contacts` },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/emergency-contacts`,
        body: {},
      },
      {
        method: 'PATCH',
        path: `/orgs/${orgId}/${childId}/emergency-contacts/${contactId}`,
        body: {},
      },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/emergency-contacts/${contactId}/remove`,
        body: {},
      },
      { method: 'GET', path: `/orgs/${orgId}` },
      { method: 'GET', path: `/orgs/${orgId}/duplicates` },
      { method: 'POST', path: `/orgs/${orgId}/merges`, body: {} },
      { method: 'GET', path: `/orgs/${orgId}/filter-options?kind=program` },
      { method: 'GET', path: `/orgs/${orgId}/${childId}` },
      { method: 'GET', path: `/orgs/${orgId}/${childId}/guardians` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/guardians`, body: {} },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/guardians/invitations`,
        body: {},
      },
      {
        method: 'POST',
        path: `/orgs/${orgId}/guardians/invitations/accept`,
        body: {},
      },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/guardians/${contactId}/revoke`,
      },
      { method: 'GET', path: `/orgs/${orgId}/${childId}/athlete-link` },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/athlete-invitations`,
        body: {},
      },
      {
        method: 'POST',
        path: `/orgs/${orgId}/athlete-invitations/accept`,
        body: {},
      },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/athlete-link/revoke` },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${claimPersonId}/claim-invitations`,
        body: {},
      },
      {
        method: 'POST',
        path: `/orgs/${orgId}/claim-invitations/accept`,
        body: {},
      },
      { method: 'POST', path: `/orgs/${orgId}`, body: {} },
      { method: 'PATCH', path: `/orgs/${orgId}/${childId}`, body: {} },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/photo`, body: {} },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/family-photo`,
        body: {},
      },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/archive`, body: {} },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/restore`, body: {} },
      { method: 'GET', path: `/households/orgs/${orgId}` },
      { method: 'GET', path: `/households/orgs/${orgId}/${householdId}` },
      { method: 'POST', path: `/households/orgs/${orgId}`, body: {} },
      {
        method: 'PATCH',
        path: `/households/orgs/${orgId}/${householdId}`,
        body: {},
      },
      {
        method: 'POST',
        path: `/households/orgs/${orgId}/${householdId}/members`,
        body: {},
      },
      {
        method: 'PATCH',
        path: `/households/orgs/${orgId}/${householdId}/members/${memberId}`,
        body: {},
      },
      {
        method: 'POST',
        path: `/households/orgs/${orgId}/${householdId}/members/${memberId}/remove`,
        body: {},
      },
    ];
    for (const call of calls) {
      const response = await request(call.method, call.path, '', call.body);
      expect(response.status, `${call.method} ${call.path}`).toBe(401);
    }
  });

  it('rejects cross-origin writes across profile, claims, guardians, and households', async () => {
    const contactId = newId();
    const householdId = newId();
    const memberId = newId();
    const calls: Array<{ method: string; path: string }> = [
      { method: 'PATCH', path: `/orgs/${orgId}/${childId}/family-profile` },
      { method: 'PATCH', path: `/orgs/${orgId}/${childId}/medical` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/emergency-contacts` },
      {
        method: 'PATCH',
        path: `/orgs/${orgId}/${childId}/emergency-contacts/${contactId}`,
      },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/emergency-contacts/${contactId}/remove`,
      },
      { method: 'POST', path: `/orgs/${orgId}/merges` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/guardians` },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/guardians/invitations`,
      },
      { method: 'POST', path: `/orgs/${orgId}/guardians/invitations/accept` },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${childId}/guardians/${contactId}/revoke`,
      },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/athlete-invitations` },
      { method: 'POST', path: `/orgs/${orgId}/athlete-invitations/accept` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/athlete-link/revoke` },
      {
        method: 'POST',
        path: `/orgs/${orgId}/${claimPersonId}/claim-invitations`,
      },
      { method: 'POST', path: `/orgs/${orgId}/claim-invitations/accept` },
      { method: 'POST', path: `/orgs/${orgId}` },
      { method: 'PATCH', path: `/orgs/${orgId}/${childId}` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/photo` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/family-photo` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/archive` },
      { method: 'POST', path: `/orgs/${orgId}/${childId}/restore` },
      { method: 'POST', path: `/households/orgs/${orgId}` },
      { method: 'PATCH', path: `/households/orgs/${orgId}/${householdId}` },
      {
        method: 'POST',
        path: `/households/orgs/${orgId}/${householdId}/members`,
      },
      {
        method: 'PATCH',
        path: `/households/orgs/${orgId}/${householdId}/members/${memberId}`,
      },
      {
        method: 'POST',
        path: `/households/orgs/${orgId}/${householdId}/members/${memberId}/remove`,
      },
    ];
    for (const call of calls) {
      const response = await request(
        call.method,
        call.path,
        ownerToken,
        {},
        false,
      );
      expect(response.status, `${call.method} ${call.path}`).toBe(403);
    }
  });

  it('serves staff person, household, family, medical, and contact workflows', async () => {
    expect((await request('GET', `/orgs/${orgId}`, '')).status).toBe(401);
    expect(
      (
        await request(
          'POST',
          `/orgs/${orgId}`,
          ownerToken,
          {
            firstName: 'Blocked',
            lastName: 'Write',
            dateOfBirth: '2000-01-01',
          },
          false,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request('GET', `/orgs/${orgId}?minAge=not-a-number`)).status,
    ).toBe(400);

    const listed = await request('GET', `/orgs/${orgId}?q=Riley`);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      items: Array<{ id: string }>;
    };
    expect(listedBody.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ownerPersonId })]),
    );
    expect(
      (await request('GET', `/orgs/${orgId}/filter-options?kind=program`))
        .status,
    ).toBe(200);
    expect((await request('GET', `/orgs/${orgId}/duplicates`)).status).toBe(
      200,
    );
    const merge = await request('POST', `/orgs/${orgId}/merges`, ownerToken, {
      survivorId: duplicateSurvivorId,
      mergedId: duplicateMergedId,
    });
    expect(merge.status, await merge.clone().text()).toBe(201);
    expect(await merge.json()).toMatchObject({
      survivorId: duplicateSurvivorId,
      mergedId: duplicateMergedId,
    });
    expect(
      (
        await request(
          'POST',
          `/orgs/${orgId}/${linkPersonId}/guardians`,
          ownerToken,
          { email: guardianEmail },
        )
      ).status,
    ).toBe(201);

    const created = await request('POST', `/orgs/${orgId}`, ownerToken, {
      firstName: 'Created',
      lastName: 'Route',
      dateOfBirth: '2001-02-03',
      preferredName: null,
      graduationYear: null,
      gender: 'unspecified',
      email: null,
      phoneE164: null,
      mediaConsent: 'granted',
    });
    expect(created.status).toBe(201);
    const createdPerson = (await created.json()) as {
      id: string;
      version: number;
    };
    expect(
      (await request('GET', `/orgs/${orgId}/${createdPerson.id}`)).status,
    ).toBe(200);
    const updated = await request(
      'PATCH',
      `/orgs/${orgId}/${createdPerson.id}`,
      ownerToken,
      { expectedVersion: createdPerson.version, firstName: 'Updated' },
    );
    expect(updated.status).toBe(200);
    const updatedPerson = (await updated.json()) as {
      id: string;
      version: number;
    };
    const photo = await request(
      'POST',
      `/orgs/${orgId}/${createdPerson.id}/photo`,
      ownerToken,
      { expectedVersion: updatedPerson.version, fileId: null },
    );
    expect(photo.status).toBe(200);
    const photoPerson = (await photo.json()) as { version: number };
    const archived = await request(
      'POST',
      `/orgs/${orgId}/${createdPerson.id}/archive`,
      ownerToken,
      { expectedVersion: photoPerson.version },
    );
    expect(archived.status).toBe(200);
    const archivedPerson = (await archived.json()) as { version: number };
    expect(
      (await request('GET', `/orgs/${orgId}?status=archived&q=Updated`)).status,
    ).toBe(200);
    expect(
      (
        await request(
          'POST',
          `/orgs/${orgId}/${createdPerson.id}/restore`,
          ownerToken,
          { expectedVersion: archivedPerson.version },
        )
      ).status,
    ).toBe(200);

    const contactsPath = `/orgs/${orgId}/${childId}/emergency-contacts`;
    expect((await request('GET', contactsPath, guardianToken)).status).toBe(
      200,
    );
    const contacts = await request('POST', contactsPath, guardianToken, {
      name: 'Backup Guardian',
      relationship: 'Aunt',
      phoneE164: '+13125550100',
      altPhoneE164: null,
      priority: 1,
    });
    expect(contacts.status).toBe(201);
    const contact = (
      (await contacts.json()) as {
        items: Array<{ id: string; version: number }>;
      }
    ).items[0];
    if (!contact) throw new Error('Expected a saved emergency contact');
    const editedContacts = await request(
      'PATCH',
      `${contactsPath}/${contact.id}`,
      guardianToken,
      { expectedVersion: contact.version, name: 'Updated Backup' },
    );
    expect(editedContacts.status).toBe(200);
    const updatedContact = (
      (await editedContacts.json()) as {
        items: Array<{ id: string; version: number }>;
      }
    ).items[0];
    if (!updatedContact) throw new Error('Expected the edited contact');
    expect(
      (
        await request(
          'POST',
          `${contactsPath}/${contact.id}/remove`,
          guardianToken,
          { expectedVersion: updatedContact.version },
        )
      ).status,
    ).toBe(200);

    expect((await request('GET', '/me/family', guardianToken)).status).toBe(
      200,
    );
    const profilePath = `/orgs/${orgId}/${childId}/family-profile`;
    const familyProfile = await request('GET', profilePath, guardianToken);
    expect(familyProfile.status).toBe(200);
    const currentProfile = (await familyProfile.json()) as {
      version: number;
    };
    const familyUpdate = await request('PATCH', profilePath, guardianToken, {
      expectedVersion: currentProfile.version,
      preferredName: 'Al',
    });
    expect(familyUpdate.status).toBe(200);
    const updatedProfile = (await familyUpdate.json()) as {
      version: number;
    };
    expect(
      (
        await request(
          'GET',
          `/orgs/${orgId}/${childId}/family-documents`,
          guardianToken,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          'POST',
          `/orgs/${orgId}/${childId}/family-photo`,
          guardianToken,
          { expectedVersion: updatedProfile.version, fileId: null },
        )
      ).status,
    ).toBe(200);

    const medicalPath = `/orgs/${orgId}/${childId}/medical`;
    expect((await request('GET', medicalPath, guardianToken)).status).toBe(200);
    expect(
      (
        await request('PATCH', medicalPath, guardianToken, {
          expectedVersion: 0,
          allergies: 'Pollen',
          allergyFlags: ['seasonal_allergies'],
          conditions: null,
          medications: null,
          physicianName: null,
          physicianPhone: null,
          insuranceCarrier: null,
          insurancePolicy: null,
          notes: null,
        })
      ).status,
    ).toBe(200);

    const household = await request(
      'POST',
      `/households/orgs/${orgId}`,
      ownerToken,
      { name: 'Route Family', address: null },
    );
    expect(household.status).toBe(201);
    let householdBody = (await household.json()) as {
      id: string;
      version: number;
      members: Array<{ id: string }>;
    };
    expect(
      (await request('GET', `/households/orgs/${orgId}?q=Route`)).status,
    ).toBe(200);
    const addMember = await request(
      'POST',
      `/households/orgs/${orgId}/${householdBody.id}/members`,
      ownerToken,
      { personId: ownerPersonId, role: 'guardian', isPrimaryContact: true },
    );
    expect(addMember.status).toBe(201);
    householdBody = (await addMember.json()) as typeof householdBody;
    const householdPath = `/households/orgs/${orgId}/${householdBody.id}`;
    expect((await request('GET', householdPath)).status).toBe(200);
    const editedHousehold = await request('PATCH', householdPath, ownerToken, {
      expectedVersion: householdBody.version,
      name: 'Updated Route Family',
    });
    expect(editedHousehold.status).toBe(200);
    householdBody = (await editedHousehold.json()) as typeof householdBody;
    const member = householdBody.members[0];
    if (!member) throw new Error('Expected the household member');
    const memberEdit = await request(
      'PATCH',
      `${householdPath}/members/${member.id}`,
      ownerToken,
      {
        expectedVersion: householdBody.version,
        canPickUp: true,
        isPrimaryContact: true,
      },
    );
    expect(memberEdit.status, await memberEdit.clone().text()).toBe(200);
    householdBody = (await memberEdit.json()) as typeof householdBody;
    const removed = await request(
      'POST',
      `${householdPath}/members/${member.id}/remove`,
      ownerToken,
      { expectedVersion: householdBody.version },
    );
    expect(removed.status).toBe(200);
  });

  it('redeems adult claims, guardian invitations, and teen athlete invitations', async () => {
    const claimInvite = await request(
      'POST',
      `/orgs/${orgId}/${claimPersonId}/claim-invitations`,
      ownerToken,
      { email: claimEmail },
    );
    expect(claimInvite.status).toBe(201);
    const claim = await request(
      'POST',
      `/orgs/${orgId}/claim-invitations/accept`,
      claimantToken,
      { token: invitationToken(0) },
    );
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({ personId: claimPersonId });

    const guardianInvite = await request(
      'POST',
      `/orgs/${orgId}/${childId}/guardians/invitations`,
      ownerToken,
      { email: `additional-${randomUUID()}@example.invalid` },
    );
    expect(guardianInvite.status).toBe(201);
    const guardianInviteBody = (await guardianInvite.json()) as {
      email: string;
    };
    const invitedGuardianId = await account(
      guardianInviteBody.email,
      '1987-06-01',
    );
    const invitedGuardianToken = await session(invitedGuardianId);
    const acceptedGuardian = await request(
      'POST',
      `/orgs/${orgId}/guardians/invitations/accept`,
      invitedGuardianToken,
      { token: invitationToken(1) },
    );
    expect(acceptedGuardian.status).toBe(200);
    const guardianLinks = await request(
      'GET',
      `/orgs/${orgId}/${childId}/guardians`,
      ownerToken,
    );
    expect(guardianLinks.status).toBe(200);
    const linkedGuardians = (
      (await guardianLinks.json()) as {
        items: Array<{ id: string; email: string }>;
      }
    ).items;
    const invitedGuardianLink = linkedGuardians.find(
      (link) => link.email === guardianInviteBody.email,
    );
    if (!invitedGuardianLink)
      throw new Error('Expected the invited guardian link');
    expect(
      (
        await request(
          'POST',
          `/orgs/${orgId}/${childId}/guardians/${invitedGuardianLink.id}/revoke`,
          ownerToken,
        )
      ).status,
    ).toBe(200);

    const athleteInvite = await request(
      'POST',
      `/orgs/${orgId}/${childId}/athlete-invitations`,
      guardianToken,
      {
        email: (
          await database
            .selectFrom('accounts')
            .select('email')
            .where('id', '=', athleteId)
            .executeTakeFirstOrThrow()
        ).email,
      },
    );
    expect(athleteInvite.status).toBe(201);
    const athleteAccepted = await request(
      'POST',
      `/orgs/${orgId}/athlete-invitations/accept`,
      athleteToken,
      { token: invitationToken(2) },
    );
    expect(athleteAccepted.status).toBe(200);
    expect(
      (
        await request(
          'GET',
          `/orgs/${orgId}/${childId}/athlete-link`,
          guardianToken,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          'POST',
          `/orgs/${orgId}/${childId}/athlete-link/revoke`,
          guardianToken,
        )
      ).status,
    ).toBe(200);
  });
});

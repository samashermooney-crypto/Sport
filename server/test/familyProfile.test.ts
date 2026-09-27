import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { createPeopleRepository } from '../src/modules/people/repo';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => database.destroy());

it('allows verified guardians and adult selves to edit while teen selves stay read-only', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const otherOrg = await factories.actor();
  const people = createPeopleRepository(database);

  const guardianId = newId();
  const guardianEmail = `guardian-${randomUUID()}@example.invalid`;
  const childId = await factories.person(staff, {
    firstName: 'Mia',
    dateOfBirth: '2012-01-01',
  });
  await database
    .insertInto('accounts')
    .values({
      id: guardianId,
      email: guardianEmail,
      first_name: 'Morgan',
      last_name: 'Guardian',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await factories.row(staff, 'person_account_links', {
    id: newId(),
    org_id: staff.orgId,
    person_id: childId,
    account_id: guardianId,
    relationship: 'guardian',
    verified_at: new Date(),
  });

  const linkedChild = await people.getRelated(staff.orgId, guardianId, childId);
  expect(linkedChild.canEdit).toBe(true);
  const editedChild = await people.updateRelated(
    staff.orgId,
    guardianId,
    childId,
    { expectedVersion: linkedChild.version, preferredName: 'Mimi' },
  );
  expect(editedChild).toMatchObject({ preferredName: 'Mimi', version: 2 });
  const consentedChild = await people.updateRelated(
    staff.orgId,
    guardianId,
    childId,
    { expectedVersion: editedChild.version, mediaConsent: 'granted' },
  );
  const photoId = newId();
  await factories.row(staff, 'files', {
    id: photoId,
    org_id: staff.orgId,
    purpose: 'image',
    owner_type: 'person',
    owner_id: childId,
    storage_key: `family-photo-${randomUUID()}`,
    mime: 'image/jpeg',
    bytes: 123,
    sensitivity: 'sensitive',
    created_by: staff.accountId,
    upload_state: 'complete',
  });
  const familyPhoto = await people.setRelatedPhoto(
    staff.orgId,
    guardianId,
    childId,
    { expectedVersion: consentedChild.version, fileId: photoId },
  );
  expect(familyPhoto.photoFileId).toBe(photoId);
  await expect(
    people.setRelatedPhoto(staff.orgId, staff.accountId, childId, {
      expectedVersion: familyPhoto.version,
      fileId: null,
    }),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

  const familyDocumentId = newId();
  await factories.row(staff, 'files', {
    id: familyDocumentId,
    org_id: staff.orgId,
    purpose: 'document',
    owner_type: 'person_document',
    owner_id: childId,
    storage_key: `family-document-${randomUUID()}`,
    mime: 'application/pdf',
    bytes: 1234,
    sensitivity: 'restricted',
    created_by: staff.accountId,
    upload_state: 'complete',
  });
  const familyDocuments = await people.listFamilyDocuments(
    staff.orgId,
    guardianId,
    childId,
  );
  expect(familyDocuments.items).toMatchObject([
    { id: familyDocumentId, mime: 'application/pdf', bytes: 1234 },
  ]);
  await expect(
    people.listFamilyDocuments(staff.orgId, staff.accountId, childId),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  await expect(
    people.getRelated(otherOrg.orgId, guardianId, childId),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  await expect(
    people.getRelated(staff.orgId, staff.accountId, childId),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

  const teenId = newId();
  const teenEmail = `teen-${randomUUID()}@example.invalid`;
  const teenPersonId = await factories.person(staff, {
    firstName: 'Riley',
    dateOfBirth: '2010-01-01',
  });
  await database
    .insertInto('accounts')
    .values({
      id: teenId,
      email: teenEmail,
      first_name: 'Riley',
      last_name: 'Athlete',
      date_of_birth: '2010-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await factories.row(staff, 'person_account_links', {
    id: newId(),
    org_id: staff.orgId,
    person_id: teenPersonId,
    account_id: teenId,
    relationship: 'self',
    verified_at: new Date(),
  });
  const teenProfile = await people.getRelated(
    staff.orgId,
    teenId,
    teenPersonId,
  );
  expect(teenProfile.canEdit).toBe(false);
  await expect(
    people.updateRelated(staff.orgId, teenId, teenPersonId, {
      expectedVersion: teenProfile.version,
      preferredName: 'Rye',
    }),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

  const adultId = newId();
  const adultEmail = `adult-${randomUUID()}@example.invalid`;
  const adultPersonId = await factories.person(staff, {
    firstName: 'Taylor',
    dateOfBirth: '1988-01-01',
  });
  await database
    .insertInto('accounts')
    .values({
      id: adultId,
      email: adultEmail,
      first_name: 'Taylor',
      last_name: 'Adult',
      date_of_birth: '1988-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await factories.row(staff, 'person_account_links', {
    id: newId(),
    org_id: staff.orgId,
    person_id: adultPersonId,
    account_id: adultId,
    relationship: 'self',
    verified_at: new Date(),
  });
  const adultProfile = await people.getRelated(
    staff.orgId,
    adultId,
    adultPersonId,
  );
  expect(adultProfile.canEdit).toBe(true);
  await expect(
    people.updateRelated(staff.orgId, adultId, adultPersonId, {
      expectedVersion: adultProfile.version,
      preferredName: 'Tay',
    }),
  ).resolves.toMatchObject({ preferredName: 'Tay', canEdit: true });

  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('person_account_links')
      .set({ revoked_at: new Date() })
      .where('org_id', '=', staff.orgId)
      .where('person_id', '=', childId)
      .where('account_id', '=', guardianId)
      .execute();
  });
  await expect(
    people.getRelated(staff.orgId, guardianId, childId),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
});

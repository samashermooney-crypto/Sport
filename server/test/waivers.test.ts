import { createHash } from 'node:crypto';

import { createDatabase } from '@server/db/kysely';
import { createWaiversService } from '@server/modules/waivers/service';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { DB } from '../src/db/types';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => database.destroy());

it('versions published waivers, authorizes signers, and renders immutable PDF evidence', async () => {
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const outsider = await factories.actor();
  const minorId = await factories.person(owner, {
    firstName: 'Maya',
    dateOfBirth: '2012-01-01',
  });
  const adultId = await factories.person(owner, {
    firstName: 'Avery',
    dateOfBirth: '1990-01-01',
  });
  const guardianPersonId = await factories.person(owner, {
    firstName: 'Morgan',
    dateOfBirth: '1988-01-01',
  });
  const guardianId = newId();
  const adultAccountId = newId();
  await database
    .insertInto('accounts')
    .values([
      {
        id: guardianId,
        email: `guardian-${guardianId}@example.invalid`,
        first_name: 'Morgan',
        last_name: 'Guardian',
        date_of_birth: '1988-01-01',
        email_verified_at: new Date(),
      },
      {
        id: adultAccountId,
        email: `adult-${adultAccountId}@example.invalid`,
        first_name: 'Avery',
        last_name: 'Athlete',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      },
    ])
    .execute();

  await factories.scoped(owner, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', owner.accountId)
      .execute();
    await trx
      .insertInto('person_account_links')
      .values([
        {
          id: newId(),
          org_id: owner.orgId,
          person_id: minorId,
          account_id: guardianId,
          relationship: 'guardian',
          verified_at: new Date(),
        },
        {
          id: newId(),
          org_id: owner.orgId,
          person_id: adultId,
          account_id: adultAccountId,
          relationship: 'self',
          verified_at: new Date(),
        },
        {
          id: newId(),
          org_id: owner.orgId,
          person_id: guardianPersonId,
          account_id: guardianId,
          relationship: 'self',
          verified_at: new Date(),
        },
      ])
      .execute();
  });

  const waivers = createWaiversService(database);
  const guardian = {
    orgId: owner.orgId,
    actor: { accountId: guardianId },
  };
  const adult = {
    orgId: owner.orgId,
    actor: { accountId: adultAccountId },
  };
  const text =
    'I agree to the safety rules & emergency care.\n\nI confirm this signature is my own.';
  const draft = await waivers.create(owner, {
    name: 'Athlete safety waiver',
    bodyText: text,
    requires: 'guardian_if_minor',
    renewal: 'annual_season',
  });
  await waivers.publish(owner, draft.id, draft.version);

  await expect(
    waivers.create(guardian, {
      name: 'Unauthorized waiver',
      bodyText: text,
      requires: 'guardian_if_minor',
      renewal: 'annual_season',
    }),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  await expect(
    waivers.sign(
      outsider,
      draft.id,
      {
        participantPersonId: minorId,
        signerPersonId: null,
        signerNameTyped: 'Unauthorized',
        method: 'online_typed',
        signatureFileId: null,
        registrationId: null,
      },
      { ip: null, userAgent: null },
    ),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  await expect(
    waivers.sign(
      adult,
      draft.id,
      {
        participantPersonId: minorId,
        signerPersonId: null,
        signerNameTyped: 'Avery Athlete',
        method: 'online_typed',
        signatureFileId: null,
        registrationId: null,
      },
      { ip: null, userAgent: null },
    ),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  await expect(
    waivers.sign(
      guardian,
      draft.id,
      {
        participantPersonId: minorId,
        signerPersonId: adultId,
        signerNameTyped: 'Morgan Guardian',
        method: 'online_typed',
        signatureFileId: null,
        registrationId: null,
      },
      { ip: null, userAgent: null },
    ),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

  const signature = await waivers.sign(
    guardian,
    draft.id,
    {
      participantPersonId: minorId,
      signerPersonId: guardianPersonId,
      signerNameTyped: 'Morgan Guardian',
      method: 'online_typed',
      signatureFileId: null,
      registrationId: null,
    },
    { ip: '192.0.2.1', userAgent: 'Athlentry test' },
  );
  const expectedHash = createHash('sha256').update(text, 'utf8').digest('hex');
  expect(signature).toMatchObject({
    documentVersion: 1,
    documentHash: expectedHash,
    participantPersonId: minorId,
    signerAccountId: guardianId,
    signerPersonId: guardianPersonId,
    signerNameTyped: 'Morgan Guardian',
    method: 'online_typed',
  });

  const pdfBytes = await waivers.signedPdf(guardian, signature.id);
  const pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getTitle()).toBe('Athlete safety waiver — signed waiver');
  expect(pdf.getSubject()).toBe(text);
  const keywords = pdf.getKeywords() ?? '';
  expect(keywords).toContain('Signer: Morgan Guardian');
  expect(keywords).toContain('Method: online_typed');
  expect(keywords).toContain(`Signed at: ${signature.signedAt}`);
  expect(keywords).toContain(`Document SHA-256: ${expectedHash}`);

  await expect(
    factories.scoped(owner, (trx) =>
      trx
        .updateTable('waiver_documents')
        .set({ body_html: '<p>Altered after publication.</p>' })
        .where('org_id', '=', owner.orgId)
        .where('id', '=', draft.id)
        .execute(),
    ),
  ).rejects.toMatchObject({ code: '55000' });
  await expect(
    factories.scoped(owner, (trx) =>
      trx
        .updateTable('waiver_signatures')
        .set({ signer_name_typed: 'Altered signer' })
        .where('org_id', '=', owner.orgId)
        .where('id', '=', signature.id)
        .execute(),
    ),
  ).rejects.toMatchObject({ code: '55000' });
  await expect(
    factories.scoped(owner, (trx) =>
      trx
        .deleteFrom('waiver_signatures')
        .where('org_id', '=', owner.orgId)
        .where('id', '=', signature.id)
        .execute(),
    ),
  ).rejects.toMatchObject({ code: '55000' });

  const v2 = await waivers.update(owner, draft.id, {
    name: 'Athlete safety waiver',
    bodyText: `${text}\n\nUpdated season terms apply.`,
    requires: 'guardian_if_minor',
    renewal: 'annual_season',
    expectedVersion: 1,
  });
  expect(v2).toMatchObject({ version: 2, supersedesId: draft.id });
  await waivers.publish(owner, v2.id, v2.version);
  const documents = await waivers.list(owner);
  expect(
    documents.items.some(
      (document) => document.id === draft.id && document.retiredAt !== null,
    ),
  ).toBe(true);
  expect(
    documents.items.some(
      (document) =>
        document.id === v2.id &&
        document.version === 2 &&
        document.retiredAt === null,
    ),
  ).toBe(true);
  await expect(waivers.signedPdf(outsider, signature.id)).rejects.toMatchObject(
    {
      status: 404,
      code: 'NOT_FOUND',
    },
  );
});

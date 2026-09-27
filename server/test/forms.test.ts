import { randomBytes } from 'node:crypto';

import { createDatabase } from '@server/db/kysely';
import { parseEncryptionKeys } from '@server/lib/crypto';
import { createFormsService } from '@server/modules/forms/service';
import { newId } from '@shared/ids';
import { formSchema } from '@shared/schemas/forms';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { DB } from '../src/db/types';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => database.destroy());

it('versions published forms, preserves historical responses, encrypts tiers, and reuses profile answers', async () => {
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const reporter = await factories.actor();
  const guardianAccountId = newId();
  const childId = await factories.person(owner, {
    firstName: 'Maya',
    dateOfBirth: '2012-01-01',
  });
  await database
    .insertInto('accounts')
    .values({
      id: guardianAccountId,
      email: `guardian-${guardianAccountId}@example.invalid`,
      first_name: 'Morgan',
      last_name: 'Guardian',
      date_of_birth: '1988-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await factories.scoped(owner, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', owner.accountId)
      .execute();
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: owner.orgId,
        account_id: reporter.accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: owner.orgId,
        account_id: reporter.accountId,
        role: 'reporter',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
    await trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: owner.orgId,
        person_id: childId,
        account_id: guardianAccountId,
        relationship: 'guardian',
        verified_at: new Date(),
      })
      .execute();
  });
  const context = {
    orgId: owner.orgId,
    actor: { accountId: guardianAccountId },
  };
  const forms = createFormsService(
    database,
    parseEncryptionKeys(
      JSON.stringify({ test: randomBytes(32).toString('base64') }),
      'test',
    ),
  );
  await expect(
    forms.create(context, {
      name: 'Unauthorized draft',
      scope: 'person_profile',
      schema: { fields: [] },
    }),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  const schema = formSchema.parse({
    fields: [
      {
        key: 'has_allergies',
        type: 'checkbox' as const,
        label: { en: 'Any allergies?', es: '¿Alergias?' },
        required: true,
        tier: 'public' as const,
        profileScoped: true,
      },
      {
        key: 'allergy_details',
        type: 'textarea' as const,
        label: { en: 'Allergy details', es: 'Detalles de alergias' },
        required: true,
        tier: 'restricted' as const,
        visibility: { fieldKey: 'has_allergies', equals: true },
        profileScoped: true,
      },
      {
        key: 'season_note',
        type: 'textarea' as const,
        label: { en: 'Season note', es: 'Nota de temporada' },
        required: false,
        tier: 'sensitive' as const,
        profileScoped: true,
        askEverySeason: true,
      },
    ],
  });
  const v1 = await forms.create(owner, {
    name: 'Athlete medical intake',
    scope: 'person_profile',
    schema,
  });
  await forms.publish(owner, v1.id, v1.version);
  const responseV1 = await forms.submit(context, {
    formDefinitionId: v1.id,
    subjectType: 'person',
    subjectId: childId,
    answers: {
      has_allergies: true,
      allergy_details: 'Severe peanut allergy',
      season_note: 'Bring the inhaler',
    },
  });
  const reporterContext = {
    orgId: owner.orgId,
    actor: { accountId: reporter.accountId },
  };
  const redactedV1 = await forms.renderResponse(reporterContext, responseV1.id);
  expect(redactedV1.answers).toEqual({
    has_allergies: true,
    season_note: 'Bring the inhaler',
  });
  expect(responseV1).toMatchObject({
    definitionVersion: 1,
    form: { id: v1.id, version: 1 },
    answers: { allergy_details: 'Severe peanut allergy' },
  });
  const stored = await factories.scoped(owner, (trx) =>
    trx
      .selectFrom('form_responses')
      .select(['answers', 'answers_enc'])
      .where('org_id', '=', owner.orgId)
      .where('id', '=', responseV1.id)
      .executeTakeFirstOrThrow(),
  );
  expect(stored.answers).toEqual({ has_allergies: true });
  expect(stored.answers_enc).not.toBeNull();
  expect(
    stored.answers_enc?.includes(Buffer.from('Severe peanut allergy')),
  ).toBe(false);

  const v2 = await forms.update(owner, v1.id, {
    name: 'Athlete medical intake',
    scope: 'person_profile',
    schema: {
      fields: schema.fields.map((field) =>
        field.key === 'allergy_details'
          ? {
              ...field,
              label: {
                en: 'Describe allergies',
                es: 'Describa las alergias',
              },
            }
          : field,
      ),
    },
    expectedVersion: 1,
  });
  expect(v2).toMatchObject({ version: 2, supersedesId: v1.id });
  await expect(
    factories.scoped(owner, (trx) =>
      trx
        .updateTable('form_definitions')
        .set({ name: 'Tampered published form' })
        .where('org_id', '=', owner.orgId)
        .where('id', '=', v1.id)
        .execute(),
    ),
  ).rejects.toMatchObject({ code: '55000' });
  await forms.publish(owner, v2.id, v2.version);
  const renderedV1 = await forms.renderResponse(context, responseV1.id);
  expect(renderedV1).toMatchObject({
    definitionVersion: 1,
    form: {
      id: v1.id,
      version: 1,
    },
    answers: { allergy_details: 'Severe peanut allergy' },
  });
  expect(
    renderedV1.form.schema.fields.find(
      (field) => field.key === 'allergy_details',
    ),
  ).toMatchObject({ label: { en: 'Allergy details' } });
  await expect(
    forms.renderResponse(reporter, responseV1.id),
  ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  const restrictedReads = await factories.scoped(owner, (trx) =>
    trx
      .selectFrom('audit_log')
      .select(['actor_account_id', 'action', 'entity_id'])
      .where('org_id', '=', owner.orgId)
      .where('action', '=', 'restricted.read')
      .where('entity_type', '=', 'form_response')
      .where('entity_id', '=', responseV1.id)
      .execute(),
  );
  expect(
    restrictedReads.some(
      (entry) => entry.actor_account_id === guardianAccountId,
    ),
  ).toBe(true);
  expect(await forms.reusableAnswers(context, v2.id, childId)).toMatchObject({
    answers: {},
    reusedFromResponseId: null,
  });

  const responseV2 = await forms.submit(context, {
    formDefinitionId: v2.id,
    subjectType: 'person',
    subjectId: childId,
    answers: {
      has_allergies: true,
      allergy_details: 'Mild seasonal pollen allergy',
      season_note: 'Bring the inhaler',
    },
  });
  expect(await forms.reusableAnswers(context, v2.id, childId)).toMatchObject({
    reusedFromResponseId: responseV2.id,
    answers: {
      has_allergies: true,
      allergy_details: 'Mild seasonal pollen allergy',
    },
  });
  await expect(
    forms.submit(context, {
      formDefinitionId: v2.id,
      subjectType: 'person',
      subjectId: childId,
      answers: { has_allergies: false, allergy_details: 'hidden answer' },
    }),
  ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
});

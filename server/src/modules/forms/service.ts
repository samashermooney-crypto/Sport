import { newId } from '@shared/ids';
import {
  formAnswersSchema,
  formDefinitionCreateSchema,
  formDefinitionListSchema,
  formDefinitionSchema,
  formDefinitionUpdateSchema,
  formResponseSchema,
  formResponseSubmitSchema,
  formSchema,
} from '@shared/schemas/forms';
import type {
  FormDefinitionCreate,
  FormDefinitionUpdate,
  FormResponseSubmit,
  FormSchema,
} from '@shared/schemas/forms';
import { sql } from 'kysely';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';

import type { DB, FormDefinitions, FormResponses } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { decryptRestricted, encryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';
import { appendAuditEvent } from '../audit/service';

export class FormsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type FormRow = Selectable<FormDefinitions>;
type ResponseRow = Selectable<FormResponses>;
const jsonRecordSchema = z.record(z.string(), z.json());

function definitionView(row: FormRow) {
  return formDefinitionSchema.parse({
    id: row.id,
    name: row.name,
    scope: row.scope,
    version: row.version,
    schema: formSchema.parse(row.schema),
    publishedAt: row.published_at?.toISOString() ?? null,
    retiredAt: row.retired_at?.toISOString() ?? null,
    supersedesId: row.supersedes_id,
  });
}

function responseAnswers(
  row: ResponseRow,
  encryption: EncryptionKeys,
): Record<string, unknown> {
  const publicAnswers = z.record(z.string(), z.unknown()).parse(row.answers);
  const protectedAnswers = row.answers_enc
    ? z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            decryptRestricted(row.answers_enc, encryption).toString('utf8'),
          ),
        )
    : {};
  return { ...publicAnswers, ...protectedAnswers };
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function fieldValueValid(
  field: FormSchema['fields'][number],
  value: unknown,
): boolean {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'file':
    case 'signature':
    case 'phone':
    case 'email':
    case 'address':
      return typeof value === 'string' && value.length <= 4000;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      return z.iso.date().safeParse(value).success;
    case 'select':
      return typeof value === 'string' && field.options.includes(value);
    case 'multiselect':
      return (
        Array.isArray(value) &&
        value.every(
          (item) => typeof item === 'string' && field.options.includes(item),
        )
      );
    case 'checkbox':
      return typeof value === 'boolean';
    case 'heading':
    case 'paragraph':
      return isEmpty(value);
  }
}

function validateAnswers(
  schema: FormSchema,
  source: Record<string, unknown>,
): {
  publicAnswers: Record<string, unknown>;
  protectedAnswers: Record<string, unknown>;
} {
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(source)) {
    if (!fields.has(key))
      throw new FormsError(
        400,
        'VALIDATION_ERROR',
        `Unknown form field: ${key}`,
      );
  }
  const publicAnswers: Record<string, unknown> = {};
  const protectedAnswers: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.type === 'heading' || field.type === 'paragraph') continue;
    const isVisible =
      !field.visibility ||
      source[field.visibility.fieldKey] === field.visibility.equals;
    const value = source[field.key];
    if (!isVisible) {
      if (!isEmpty(value))
        throw new FormsError(
          400,
          'VALIDATION_ERROR',
          `Hidden field cannot be answered: ${field.key}`,
        );
      continue;
    }
    if (field.required && isEmpty(value))
      throw new FormsError(
        400,
        'VALIDATION_ERROR',
        `Required field is missing: ${field.key}`,
      );
    if (isEmpty(value)) continue;
    if (!fieldValueValid(field, value))
      throw new FormsError(
        400,
        'VALIDATION_ERROR',
        `Invalid answer for field: ${field.key}`,
      );
    if (field.tier === 'public') publicAnswers[field.key] = value;
    else protectedAnswers[field.key] = value;
  }
  return { publicAnswers, protectedAnswers };
}

async function auditRestrictedResponseRead(
  trx: OrgTransaction,
  context: OrgContext,
  responseId: string,
  fieldKeys: string[],
): Promise<void> {
  if (!fieldKeys.length) return;
  await appendAuditEvent(trx, context, {
    action: 'restricted.read',
    entityType: 'form_response',
    entityId: responseId,
    changes: Object.fromEntries(
      fieldKeys.map((key) => [key, { tier: 'restricted', after: '[read]' }]),
    ),
  });
}

function restrictedAnswerKeys(
  schema: FormSchema,
  answers: Record<string, unknown>,
): string[] {
  return schema.fields
    .filter(
      (field) =>
        field.tier === 'restricted' && Object.hasOwn(answers, field.key),
    )
    .map((field) => field.key);
}

async function requireFormManager(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<void> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!membership) throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
  const role = await trx
    .selectFrom('role_assignments')
    .select('role')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('scope_type', '=', 'org')
    .where('pending_mfa', '=', false)
    .where('revoked_at', 'is', null)
    .where('role', 'in', ['owner', 'admin', 'registrar'])
    .executeTakeFirst();
  if (!role) throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
}

async function requirePersonLink(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
): Promise<void> {
  const person = await trx
    .selectFrom('people')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('id', '=', personId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!person) throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
  const link = await trx
    .selectFrom('person_account_links')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .where('account_id', '=', context.actor.accountId)
    .where('verified_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!link) throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
}

async function relatedDefinitionIds(
  trx: OrgTransaction,
  orgId: string,
  definitionId: string,
): Promise<string[]> {
  const ids = [definitionId];
  let currentId = definitionId;
  for (let depth = 0; depth < 100; depth += 1) {
    const row = await trx
      .selectFrom('form_definitions')
      .select('supersedes_id')
      .where('org_id', '=', orgId)
      .where('id', '=', currentId)
      .executeTakeFirst();
    const parentId = row?.supersedes_id;
    if (!parentId) return ids;
    ids.push(parentId);
    currentId = parentId;
  }
  throw new FormsError(409, 'CONFLICT', 'Form version history is invalid');
}

export function createFormsService(
  database: Kysely<DB>,
  encryption: EncryptionKeys,
) {
  const withOrg = createWithOrg(database);
  return {
    async list(context: OrgContext) {
      return withOrg(context, async (trx) => {
        await requireFormManager(trx, context);
        const rows = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .orderBy('created_at', 'desc')
          .orderBy('version', 'desc')
          .execute();
        return formDefinitionListSchema.parse({
          items: rows.map(definitionView),
        });
      });
    },

    async listForPerson(context: OrgContext, personId: string) {
      const id = z.uuid().parse(personId);
      return withOrg(context, async (trx) => {
        await requirePersonLink(trx, context, id);
        const rows = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('scope', '=', 'person_profile')
          .where('published_at', 'is not', null)
          .where('retired_at', 'is', null)
          .orderBy('name')
          .orderBy('version', 'desc')
          .execute();
        return formDefinitionListSchema.parse({
          items: rows.map(definitionView),
        });
      });
    },

    async create(context: OrgContext, input: FormDefinitionCreate) {
      const value = formDefinitionCreateSchema.parse(input);
      return withOrg(context, async (trx) => {
        await requireFormManager(trx, context);
        const id = newId();
        await trx
          .insertInto('form_definitions')
          .values({
            id,
            org_id: context.orgId,
            name: value.name,
            scope: value.scope,
            owner_type: 'org',
            owner_id: null,
            schema: value.schema,
          })
          .execute();
        const row = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: 'form.created',
          entityType: 'form_definition',
          entityId: id,
          changes: { name: { tier: 'internal', after: value.name } },
        });
        return definitionView(row);
      });
    },

    async update(
      context: OrgContext,
      definitionId: string,
      input: FormDefinitionUpdate,
    ) {
      const id = z.uuid().parse(definitionId);
      const value = formDefinitionUpdateSchema.parse(input);
      return withOrg(context, async (trx) => {
        await requireFormManager(trx, context);
        const current = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!current)
          throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
        if (current.version !== value.expectedVersion)
          throw new FormsError(409, 'CONFLICT', 'Form version changed');
        let updatedId = id;
        if (current.published_at) {
          updatedId = newId();
          await trx
            .insertInto('form_definitions')
            .values({
              id: updatedId,
              org_id: context.orgId,
              name: value.name,
              scope: value.scope,
              owner_type: current.owner_type,
              owner_id: current.owner_id,
              schema: value.schema,
              version: current.version + 1,
              supersedes_id: id,
            })
            .execute();
        } else {
          await trx
            .updateTable('form_definitions')
            .set({
              name: value.name,
              scope: value.scope,
              schema: value.schema,
              version: sql<number>`version + 1`,
            })
            .where('org_id', '=', context.orgId)
            .where('id', '=', id)
            .execute();
        }
        const row = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', updatedId)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: current.published_at
            ? 'form.version_created'
            : 'form.updated',
          entityType: 'form_definition',
          entityId: updatedId,
          changes: {
            version: {
              tier: 'internal',
              before: current.version,
              after: row.version,
            },
          },
        });
        return definitionView(row);
      });
    },

    async publish(
      context: OrgContext,
      definitionId: string,
      expectedVersion: number,
    ) {
      const id = z.uuid().parse(definitionId);
      return withOrg(context, async (trx) => {
        await requireFormManager(trx, context);
        const current = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!current)
          throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
        if (current.version !== expectedVersion)
          throw new FormsError(409, 'CONFLICT', 'Form version changed');
        formSchema.parse(current.schema);
        if (current.published_at)
          throw new FormsError(
            409,
            'CONFLICT',
            'Published forms are immutable',
          );
        await trx
          .updateTable('form_definitions')
          .set({ published_at: new Date() })
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .execute();
        const ancestors = await relatedDefinitionIds(trx, context.orgId, id);
        for (const previousId of ancestors.slice(1)) {
          await trx
            .updateTable('form_definitions')
            .set({ retired_at: new Date() })
            .where('org_id', '=', context.orgId)
            .where('id', '=', previousId)
            .where('published_at', 'is not', null)
            .where('retired_at', 'is', null)
            .execute();
        }
        const published = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: 'form.published',
          entityType: 'form_definition',
          entityId: id,
          changes: { version: { tier: 'internal', after: current.version } },
        });
        return definitionView(published);
      });
    },

    async submit(context: OrgContext, input: FormResponseSubmit) {
      const value = formResponseSubmitSchema.parse(input);
      return withOrg(context, async (trx) => {
        if (value.subjectType === 'person')
          await requirePersonLink(trx, context, value.subjectId);
        else await requireFormManager(trx, context);
        const form = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', value.formDefinitionId)
          .where('published_at', 'is not', null)
          .where('retired_at', 'is', null)
          .executeTakeFirst();
        if (!form)
          throw new FormsError(
            404,
            'NOT_FOUND',
            'Published form was not found',
          );
        const schema = formSchema.parse(form.schema);
        const answers = validateAnswers(schema, value.answers);
        const id = newId();
        const encoded = Object.keys(answers.protectedAnswers).length
          ? encryptRestricted(
              Buffer.from(JSON.stringify(answers.protectedAnswers)),
              encryption,
            )
          : null;
        await trx
          .insertInto('form_responses')
          .values({
            id,
            org_id: context.orgId,
            form_definition_id: form.id,
            definition_version: form.version,
            subject_type: value.subjectType,
            subject_id: value.subjectId,
            answers: jsonRecordSchema.parse(answers.publicAnswers),
            answers_enc: encoded,
            submitted_by_account_id: context.actor.accountId,
          })
          .execute();
        const response = await trx
          .selectFrom('form_responses')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: 'form.response_submitted',
          entityType: 'form_response',
          entityId: id,
          changes: {
            formId: { tier: 'internal', after: form.id },
            fieldCount: {
              tier: 'internal',
              after: Object.keys(value.answers).length,
            },
          },
        });
        await auditRestrictedResponseRead(
          trx,
          context,
          id,
          restrictedAnswerKeys(schema, answers.protectedAnswers),
        );
        return formResponseSchema.parse({
          id: response.id,
          formDefinitionId: response.form_definition_id,
          definitionVersion: response.definition_version,
          subjectType: response.subject_type,
          subjectId: response.subject_id,
          answers: responseAnswers(response, encryption),
          submittedAt: response.submitted_at.toISOString(),
          form: definitionView(form),
        });
      });
    },

    async renderResponse(context: OrgContext, responseId: string) {
      const id = z.uuid().parse(responseId);
      return withOrg(context, async (trx) => {
        const row = await trx
          .selectFrom('form_responses')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!row)
          throw new FormsError(404, 'NOT_FOUND', 'Form response was not found');
        const form = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', row.form_definition_id)
          .executeTakeFirst();
        if (!form)
          throw new FormsError(404, 'NOT_FOUND', 'Form response was not found');
        const membership = await trx
          .selectFrom('org_memberships')
          .select('status')
          .where('org_id', '=', context.orgId)
          .where('account_id', '=', context.actor.accountId)
          .executeTakeFirst();
        const roles =
          membership?.status === 'active'
            ? await trx
                .selectFrom('role_assignments')
                .select('role')
                .where('org_id', '=', context.orgId)
                .where('account_id', '=', context.actor.accountId)
                .where('scope_type', '=', 'org')
                .where('role', 'in', [
                  'owner',
                  'admin',
                  'registrar',
                  'compliance',
                  'reporter',
                ])
                .where('pending_mfa', '=', false)
                .where('revoked_at', 'is', null)
                .execute()
            : [];
        const roleNames = new Set(roles.map((assignment) => assignment.role));
        const staffCanView = roleNames.size > 0;
        let linkedPerson = false;
        if (row.subject_type === 'person') {
          const link = await trx
            .selectFrom('person_account_links as link')
            .innerJoin('people as person', (join) =>
              join
                .onRef('person.org_id', '=', 'link.org_id')
                .onRef('person.id', '=', 'link.person_id'),
            )
            .select('link.id')
            .where('link.org_id', '=', context.orgId)
            .where('link.person_id', '=', row.subject_id)
            .where('link.account_id', '=', context.actor.accountId)
            .where('link.verified_at', 'is not', null)
            .where('link.revoked_at', 'is', null)
            .where('person.status', '=', 'active')
            .executeTakeFirst();
          linkedPerson = Boolean(link);
        }
        if (!linkedPerson && !staffCanView)
          throw new FormsError(404, 'NOT_FOUND', 'Form response was not found');
        const schema = formSchema.parse(form.schema);
        let canReadRestricted =
          linkedPerson ||
          roleNames.has('owner') ||
          roleNames.has('admin') ||
          roleNames.has('compliance');
        if (
          !canReadRestricted &&
          roleNames.has('registrar') &&
          form.scope === 'person_profile'
        ) {
          const org = await trx
            .selectFrom('organizations')
            .select('settings')
            .where('id', '=', context.orgId)
            .executeTakeFirst();
          const settings = org?.settings;
          canReadRestricted = Boolean(
            settings &&
            typeof settings === 'object' &&
            !Array.isArray(settings) &&
            settings.registrarMedicalAccess === true,
          );
        }
        const allAnswers = responseAnswers(row, encryption);
        const answerFieldKeys = new Set(
          schema.fields.map((field) => field.key),
        );
        const visibleAnswers = Object.fromEntries(
          Object.entries(allAnswers).filter(
            ([key]) =>
              answerFieldKeys.has(key) &&
              (canReadRestricted ||
                schema.fields.find((field) => field.key === key)?.tier !==
                  'restricted'),
          ),
        );
        if (canReadRestricted)
          await auditRestrictedResponseRead(
            trx,
            context,
            row.id,
            restrictedAnswerKeys(schema, allAnswers),
          );
        return formResponseSchema.parse({
          id: row.id,
          formDefinitionId: row.form_definition_id,
          definitionVersion: row.definition_version,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          answers: visibleAnswers,
          submittedAt: row.submitted_at.toISOString(),
          form: definitionView(form),
        });
      });
    },

    async reusableAnswers(
      context: OrgContext,
      definitionId: string,
      personId: string,
    ) {
      const formId = z.uuid().parse(definitionId);
      const subjectId = z.uuid().parse(personId);
      return withOrg(context, async (trx) => {
        await requirePersonLink(trx, context, subjectId);
        const form = await trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', formId)
          .where('published_at', 'is not', null)
          .where('retired_at', 'is', null)
          .executeTakeFirst();
        if (!form)
          throw new FormsError(
            404,
            'NOT_FOUND',
            'Published form was not found',
          );
        const chain = await relatedDefinitionIds(trx, context.orgId, formId);
        const prior = await trx
          .selectFrom('form_responses')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('form_definition_id', 'in', chain)
          .where('subject_type', '=', 'person')
          .where('subject_id', '=', subjectId)
          .where('submitted_by_account_id', '=', context.actor.accountId)
          .orderBy('submitted_at', 'desc')
          .executeTakeFirst();
        if (!prior || prior.definition_version !== form.version)
          return formAnswersSchema.parse({
            answers: {},
            reusedFromResponseId: null,
          });
        const priorDefinition = await trx
          .selectFrom('form_definitions')
          .select('schema')
          .where('org_id', '=', context.orgId)
          .where('id', '=', prior.form_definition_id)
          .executeTakeFirst();
        if (!priorDefinition)
          return formAnswersSchema.parse({
            answers: {},
            reusedFromResponseId: null,
          });
        const previousAnswers = responseAnswers(prior, encryption);
        const reusable = new Set(
          formSchema
            .parse(priorDefinition.schema)
            .fields.filter(
              (field) => field.profileScoped && !field.askEverySeason,
            )
            .map((field) => field.key),
        );
        const answers = Object.fromEntries(
          formSchema
            .parse(form.schema)
            .fields.filter(
              (field) =>
                field.profileScoped &&
                !field.askEverySeason &&
                reusable.has(field.key) &&
                Object.hasOwn(previousAnswers, field.key),
            )
            .map((field) => [field.key, previousAnswers[field.key]]),
        );
        await auditRestrictedResponseRead(
          trx,
          context,
          prior.id,
          restrictedAnswerKeys(formSchema.parse(form.schema), answers),
        );
        return formAnswersSchema.parse({
          answers,
          reusedFromResponseId: prior.id,
        });
      });
    },
  };
}

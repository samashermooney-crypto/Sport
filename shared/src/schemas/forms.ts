import { z } from 'zod';

const formScopeSchema = z.enum([
  'person_profile',
  'registration',
  'team_entry',
  'volunteer',
  'evaluation',
  'incident',
  'custom',
]);

const answerFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'file',
  'signature',
  'phone',
  'email',
  'address',
  'heading',
  'paragraph',
]);

const visibilityConditionSchema = z.strictObject({
  fieldKey: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
  equals: z.union([z.string().max(500), z.number(), z.boolean()]),
});

const formFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
  type: answerFieldTypeSchema,
  label: z.strictObject({
    en: z.string().trim().min(1).max(200),
    es: z.string().trim().min(1).max(200),
  }),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  visibility: visibilityConditionSchema.optional(),
  tier: z.enum(['public', 'sensitive', 'restricted']).default('public'),
  appliesTo: z
    .array(z.enum(['athlete', 'guardian', 'registrant']))
    .min(1)
    .default(['athlete']),
  profileScoped: z.boolean().default(false),
  askEverySeason: z.boolean().default(false),
});

export const formSchema = z
  .strictObject({ fields: z.array(formFieldSchema).max(100) })
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const [index, field] of value.fields.entries()) {
      if (keys.has(field.key)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: 'Field keys must be unique.',
        });
      }
      keys.add(field.key);
      if (
        (field.type === 'select' || field.type === 'multiselect') &&
        field.options.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: 'Choice fields need at least one option.',
        });
      }
    }
    for (const [index, field] of value.fields.entries()) {
      if (field.visibility && !keys.has(field.visibility.fieldKey)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'visibility', 'fieldKey'],
          message: 'Conditional visibility must refer to a field in this form.',
        });
      }
      if (field.visibility?.fieldKey === field.key) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'visibility', 'fieldKey'],
          message: 'A field cannot depend on itself.',
        });
      }
    }
  });

export const formDefinitionCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  scope: formScopeSchema,
  schema: formSchema,
});

export const formDefinitionUpdateSchema = formDefinitionCreateSchema.extend({
  expectedVersion: z.int().positive(),
});

export const formDefinitionSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  scope: formScopeSchema,
  version: z.int().positive(),
  schema: formSchema,
  publishedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  supersedesId: z.uuid().nullable(),
});

export const formDefinitionListSchema = z.strictObject({
  items: z.array(formDefinitionSchema),
});

export const formResponseSubmitSchema = z.strictObject({
  formDefinitionId: z.uuid(),
  subjectType: z.enum([
    'person',
    'registration',
    'team_entry',
    'volunteer_signup',
    'evaluation',
    'incident',
  ]),
  subjectId: z.uuid(),
  answers: z.record(z.string(), z.unknown()),
});

export const formResponseSchema = z.strictObject({
  id: z.uuid(),
  formDefinitionId: z.uuid(),
  definitionVersion: z.int().positive(),
  subjectType: z.string(),
  subjectId: z.uuid(),
  answers: z.record(z.string(), z.unknown()),
  submittedAt: z.iso.datetime(),
  form: formDefinitionSchema,
});

export const formAnswersSchema = z.strictObject({
  answers: z.record(z.string(), z.unknown()),
  reusedFromResponseId: z.uuid().nullable(),
});

export type FormDefinitionCreate = z.output<typeof formDefinitionCreateSchema>;
export type FormDefinitionUpdate = z.output<typeof formDefinitionUpdateSchema>;
export type FormSchema = z.output<typeof formSchema>;
export type FormResponseSubmit = z.output<typeof formResponseSubmitSchema>;

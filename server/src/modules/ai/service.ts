import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';

import type { DB, JsonObject } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import { listHelpArticles } from '../help/content';

import { extractText } from './extract';
import { redactSensitive } from './redact';
import type { AiMessage, AiProvider } from './provider';

export class AiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MONTHLY_EVENT_CAP = 500;
const PER_MINUTE_CAP = 20;
const CONVERSATION_RETENTION_DAYS = 30;

const STAFF_ROLES = ['owner', 'admin', 'registrar', 'treasurer', 'coach', 'staff'];

interface OrgContextRow {
  name: string;
  timezone: string;
  kind: string;
  website_url: string | null;
}

async function loadOrgContext(
  trx: OrgTransaction,
  orgId: string,
): Promise<{ text: string; sources: { title: string; ref: string }[] }> {
  const org = (await trx
    .selectFrom('organizations')
    .select(['name', 'timezone', 'kind', 'website_url'])
    .where('id', '=', orgId)
    .executeTakeFirst()) as OrgContextRow | undefined;
  const programs = await trx
    .selectFrom('programs')
    .select([
      'name',
      'starts_on',
      'ends_on',
      'registration_opens_at',
      'registration_closes_at',
      'visibility',
      'status',
    ])
    .where('org_id', '=', orgId)
    .where('visibility', '=', 'public')
    .orderBy('starts_on', 'asc')
    .limit(25)
    .execute();
  const facilities = await trx
    .selectFrom('facilities')
    .select(['name', 'address'])
    .where('org_id', '=', orgId)
    .where('archived_at', 'is', null)
    .limit(25)
    .execute();
  const sources: { title: string; ref: string }[] = [];
  const chunks: string[] = [];
  if (org) {
    chunks.push(
      `Organization: ${org.name} (kind: ${org.kind}, timezone: ${org.timezone})`,
    );
    sources.push({ title: org.name, ref: 'organization' });
  }
  for (const program of programs) {
    chunks.push(
      `Program: ${program.name} — runs ${program.starts_on} to ${program.ends_on}; ` +
        `registration ${program.registration_opens_at ?? 'not scheduled'} to ${program.registration_closes_at ?? 'open'}; ` +
        `status ${program.status}`,
    );
    sources.push({ title: `Program: ${program.name}`, ref: 'program' });
  }
  for (const facility of facilities) {
    chunks.push(`Facility: ${facility.name} at ${JSON.stringify(facility.address)}`);
    sources.push({ title: `Facility: ${facility.name}`, ref: 'facility' });
  }
  for (const article of listHelpArticles().filter(
    (item) => item.locale === 'en',
  )) {
    chunks.push(
      `Help article "${article.title}" (${article.category}): ${article.summary} ${article.body.slice(0, 1200)}`,
    );
    sources.push({ title: article.title, ref: `help:${article.slug}` });
  }
  return { text: chunks.join('\n'), sources };
}

export function createAiService(
  database: Kysely<DB>,
  provider: AiProvider,
) {
  const withOrg = createWithOrg(database);

  function assertEnabled(): void {
    if (!provider.enabled)
      throw new AiError(404, 'AI_DISABLED', 'AI assistance is not enabled');
  }

  async function recordUsage(
    trx: OrgTransaction,
    orgId: string,
    actorId: string | null,
    feature: 'form_draft' | 'translation' | 'help_assistant',
    usage: {
      promptTokens: number;
      completionTokens: number;
      redactions: number;
      status: 'ok' | 'refused' | 'error' | 'capped';
      detail?: string;
    },
  ): Promise<void> {
    await trx
      .insertInto('ai_usage_events')
      .values({
        id: newId(),
        org_id: orgId,
        feature,
        actor_account_id: actorId,
        model: provider.model,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        redactions: usage.redactions,
        status: usage.status,
        detail: usage.detail ?? null,
      })
      .execute();
  }

  async function checkCaps(
    trx: OrgTransaction,
    orgId: string,
    actorId: string | null,
    feature: 'form_draft' | 'translation' | 'help_assistant',
  ): Promise<void> {
    const month = await trx
      .selectFrom('ai_usage_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('org_id', '=', orgId)
      .where('created_at', '>', new Date(Date.now() - 30 * 86400_000))
      .executeTakeFirst();
    const minute = await trx
      .selectFrom('ai_usage_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('org_id', '=', orgId)
      .where('created_at', '>', new Date(Date.now() - 60_000))
      .executeTakeFirst();
    if (
      Number(month?.count ?? 0) >= MONTHLY_EVENT_CAP ||
      Number(minute?.count ?? 0) >= PER_MINUTE_CAP
    ) {
      await recordUsage(trx, orgId, actorId, feature, {
        promptTokens: 0,
        completionTokens: 0,
        redactions: 0,
        status: 'capped',
      });
      throw new AiError(
        429,
        'AI_CAPPED',
        'AI usage limit reached for this organization. Try again later.',
      );
    }
  }

  async function requireStaff(
    trx: OrgTransaction,
    orgId: string,
    actorId: string,
  ): Promise<void> {
    const staff = await trx
      .selectFrom('org_memberships')
      .innerJoin('role_assignments', (join) =>
        join
          .onRef('role_assignments.org_id', '=', 'org_memberships.org_id')
          .onRef(
            'role_assignments.account_id',
            '=',
            'org_memberships.account_id',
          ),
      )
      .select('org_memberships.id')
      .where('org_memberships.org_id', '=', orgId)
      .where('org_memberships.account_id', '=', actorId)
      .where('org_memberships.status', '=', 'active')
      .where('role_assignments.role', 'in', STAFF_ROLES)
      .where('role_assignments.scope_type', '=', 'org')
      .where('role_assignments.pending_mfa', '=', false)
      .where('role_assignments.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!staff)
      throw new AiError(404, 'NOT_FOUND', 'Organization not found');
  }

  function status(orgId: string) {
    return {
      enabled: provider.enabled,
      provider: provider.enabled ? provider.name : null,
      model: provider.enabled ? provider.model : null,
      orgId,
    };
  }

  async function draftForm(
    orgId: string,
    actorId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ draftId: string; draft: unknown; redactions: number }> {
    assertEnabled();
    return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId);
      await checkCaps(trx, orgId, actorId, 'form_draft');
      let text: string;
      try {
        text = extractText(fileName, bytes);
      } catch (error) {
        throw new AiError(
          400,
          'EXTRACT_FAILED',
          error instanceof Error ? error.message : 'Could not read that file',
        );
      }
      const redacted = redactSensitive(text);
      const messages: AiMessage[] = [
        {
          role: 'system',
          content:
            'You convert a youth-sports organization document into a form definition. ' +
            'Reply with JSON only: {"title": string, "description": string, ' +
            '"fields": [{"key": string, "label": string, "type": one of ' +
            '"text"|"textarea"|"select"|"checkbox"|"date"|"number"|"signature", ' +
            '"required": boolean, "options"?: string[]}]}',
        },
        {
          role: 'user',
          content: `Document "${fileName}":\n${redacted.text}`,
        },
      ];
      let draft: unknown;
      let promptTokens = 0;
      let completionTokens = 0;
      try {
        const completion = await provider.complete(messages);
        promptTokens = completion.promptTokens;
        completionTokens = completion.completionTokens;
        const cleaned = completion.text
          .replace(/^```(?:json)?/m, '')
          .replace(/```$/m, '')
          .trim();
        draft = JSON.parse(cleaned);
      } catch (error) {
        await recordUsage(trx, orgId, actorId, 'form_draft', {
          promptTokens,
          completionTokens,
          redactions: redacted.redactions,
          status: 'error',
          detail: 'provider or parse failure',
        });
        throw new AiError(
          502,
          'AI_FAILED',
          error instanceof Error
            ? error.message
            : 'Could not draft the form',
        );
      }
      const draftId = newId();
      await trx
        .insertInto('ai_drafts')
        .values({
          id: draftId,
          org_id: orgId,
          kind: 'form',
          source_file_name: fileName,
          draft: JSON.parse(JSON.stringify(draft)) as JsonObject,
          redactions: redacted.redactions,
          status: 'pending',
          created_by: actorId,
        })
        .execute();
      await recordUsage(trx, orgId, actorId, 'form_draft', {
        promptTokens,
        completionTokens,
        redactions: redacted.redactions,
        status: 'ok',
      });
      return { draftId, draft, redactions: redacted.redactions };
    });
  }

  async function applyDraft(
    orgId: string,
    actorId: string,
    draftId: string,
  ): Promise<{ formDefinitionId: string }> {
    assertEnabled();
    return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId);
      const draft = await trx
        .selectFrom('ai_drafts')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', draftId)
        .executeTakeFirst();
      if (!draft)
        throw new AiError(404, 'NOT_FOUND', 'Draft not found');
      if (draft.status !== 'pending')
        throw new AiError(409, 'CONFLICT', `Draft is ${draft.status}`);
      const parsed = draft.draft as {
        title?: string;
        fields?: unknown[];
      };
      const formId = newId();
      await trx
        .insertInto('form_definitions')
        .values({
          id: formId,
          org_id: orgId,
          name: String(parsed.title ?? 'Draft form'),
          schema: draft.draft as never,
          scope: 'custom',
          owner_type: 'org',
          owner_id: null,
        })
        .execute();
      await trx
        .updateTable('ai_drafts')
        .set({ status: 'applied', applied_at: new Date() })
        .where('org_id', '=', orgId)
        .where('id', '=', draftId)
        .execute();
      return { formDefinitionId: formId };
    });
  }

  async function discardDraft(
    orgId: string,
    actorId: string,
    draftId: string,
  ): Promise<void> {
    assertEnabled();
    await withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId);
      await trx
        .updateTable('ai_drafts')
        .set({ status: 'discarded' })
        .where('org_id', '=', orgId)
        .where('id', '=', draftId)
        .where('status', '=', 'pending')
        .execute();
    });
  }

  async function translate(
    orgId: string,
    actorId: string,
    input: { text: string; target: 'en' | 'es' },
  ): Promise<{ text: string; redactions: number }> {
    assertEnabled();
    return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId);
      await checkCaps(trx, orgId, actorId, 'translation');
      const redacted = redactSensitive(input.text);
      const messages: AiMessage[] = [
        {
          role: 'system',
          content: `Translate the text to ${input.target === 'es' ? 'Spanish' : 'English'}. Reply with the translation only, preserving formatting.`,
        },
        { role: 'user', content: redacted.text.slice(0, 20_000) },
      ];
      let text = '';
      let promptTokens = 0;
      let completionTokens = 0;
      try {
        const completion = await provider.complete(messages);
        text = completion.text;
        promptTokens = completion.promptTokens;
        completionTokens = completion.completionTokens;
      } catch (error) {
        await recordUsage(trx, orgId, actorId, 'translation', {
          promptTokens,
          completionTokens,
          redactions: redacted.redactions,
          status: 'error',
        });
        throw new AiError(
          502,
          'AI_FAILED',
          error instanceof Error ? error.message : 'Translation failed',
        );
      }
      await recordUsage(trx, orgId, actorId, 'translation', {
        promptTokens,
        completionTokens,
        redactions: redacted.redactions,
        status: 'ok',
      });
      return { text, redactions: redacted.redactions };
    });
  }

  const REFUSAL =
    'I can only answer general questions about this organization, its published ' +
    'programs, and how to use Athlentry. For questions about a specific child, ' +
    'account balance, payments, or medical information, please contact the ' +
    'organization directly.';

  function needsRefusal(message: string): boolean {
    return /\b(my (child|son|daughter|kid)|balance|owe|payment|refund|medical|allergy|medication|injur|password|social security)\b/i.test(
      message,
    );
  }

  async function chat(
    orgId: string,
    actorId: string | null,
    visitorKey: string | null,
    message: string,
    conversationId?: string,
  ): Promise<{
    conversationId: string;
    answer: string;
    refused: boolean;
    citations: { title: string; ref: string }[];
  }> {
    assertEnabled();
    return withOrg(
      { orgId, actor: { accountId: actorId ?? '00000000-0000-0000-0000-000000000000' } },
      async (trx) => {
        await checkCaps(trx, orgId, actorId, 'help_assistant');
        let conversation = conversationId
          ? await trx
              .selectFrom('ai_conversations')
              .selectAll()
              .where('org_id', '=', orgId)
              .where('id', '=', conversationId)
              .executeTakeFirst()
          : undefined;
        if (!conversation) {
          const id = newId();
          await trx
            .insertInto('ai_conversations')
            .values({
              id,
              org_id: orgId,
              account_id: actorId,
              visitor_key: visitorKey,
              expires_at: new Date(
                Date.now() + CONVERSATION_RETENTION_DAYS * 86400_000,
              ),
            })
            .execute();
          conversation = { id } as typeof conversation & { id: string };
        }
        if (actorId && conversation.account_id && conversation.account_id !== actorId)
          throw new AiError(403, 'FORBIDDEN', 'Not your conversation');
        await trx
          .insertInto('ai_conversation_messages')
          .values({
            id: newId(),
            org_id: orgId,
            conversation_id: conversation.id,
            role: 'visitor',
            content: message.slice(0, 4000),
            citations: '[]',
          })
          .execute();
        if (needsRefusal(message)) {
          await recordUsage(trx, orgId, actorId, 'help_assistant', {
            promptTokens: 0,
            completionTokens: 0,
            redactions: 0,
            status: 'refused',
          });
          await trx
            .insertInto('ai_conversation_messages')
            .values({
              id: newId(),
              org_id: orgId,
              conversation_id: conversation.id,
              role: 'assistant',
              content: REFUSAL,
              citations: '[]',
            })
            .execute();
          return {
            conversationId: conversation.id,
            answer: REFUSAL,
            refused: true,
            citations: [],
          };
        }
        const context = await loadOrgContext(trx, orgId);
        const redacted = redactSensitive(message);
        const history = await trx
          .selectFrom('ai_conversation_messages')
          .select(['role', 'content'])
          .where('org_id', '=', orgId)
          .where('conversation_id', '=', conversation.id)
          .orderBy('created_at', 'asc')
          .limit(12)
          .execute();
        const messages: AiMessage[] = [
          {
            role: 'system',
            content:
              'You are a help assistant for a youth-sports organization website. ' +
              'Answer ONLY using the organization facts below and general ' +
              'knowledge of the Athlentry platform described in help articles. ' +
              'Never invent contact details, prices, or schedules. ' +
              'Never answer questions about a specific child, account balance, ' +
              'payment, or medical matter — tell the visitor to contact the ' +
              'organization. Keep answers under 150 words. Reply with JSON: ' +
              '{"answer": string, "sources": [title strings used]}.\n\n' +
              `ORGANIZATION FACTS:\n${context.text}`,
          },
          ...history.map(
            (item): AiMessage => ({
              role: item.role === 'assistant' ? 'assistant' : 'user',
              content: item.content,
            }),
          ),
        ];
        let answer = '';
        let usedSources: { title: string; ref: string }[] = [];
        let promptTokens = 0;
        let completionTokens = 0;
        try {
          const completion = await provider.complete(messages);
          promptTokens = completion.promptTokens;
          completionTokens = completion.completionTokens;
          const cleaned = completion.text
            .replace(/^```(?:json)?/m, '')
            .replace(/```$/m, '')
            .trim();
          const parsed = JSON.parse(cleaned) as {
            answer?: string;
            sources?: string[];
          };
          answer = parsed.answer ?? '';
          const titles = new Set(parsed.sources ?? []);
          usedSources = context.sources.filter((source) =>
            titles.has(source.title),
          );
          if (usedSources.length === 0) usedSources = context.sources.slice(0, 2);
        } catch (error) {
          await recordUsage(trx, orgId, actorId, 'help_assistant', {
            promptTokens,
            completionTokens,
            redactions: redacted.redactions,
            status: 'error',
          });
          throw new AiError(
            502,
            'AI_FAILED',
            error instanceof Error ? error.message : 'Assistant failed',
          );
        }
        await recordUsage(trx, orgId, actorId, 'help_assistant', {
          promptTokens,
          completionTokens,
          redactions: redacted.redactions,
          status: 'ok',
        });
        await trx
          .insertInto('ai_conversation_messages')
          .values({
            id: newId(),
            org_id: orgId,
            conversation_id: conversation.id,
            role: 'assistant',
            content: answer,
            citations: JSON.stringify(usedSources),
          })
          .execute();
        return {
          conversationId: conversation.id,
          answer,
          refused: false,
          citations: usedSources,
        };
      },
    );
  }

  async function listConversations(
    orgId: string,
    actorId: string,
  ): Promise<
    { id: string; createdAt: string; expiresAt: string; messages: number }[]
  > {
    return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      await requireStaff(trx, orgId, actorId);
      const rows = await trx
        .selectFrom('ai_conversations')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        messages: 0,
      }));
    });
  }

  async function expireConversations(database_: Kysely<DB>): Promise<number> {
    const result = await database_
      .deleteFrom('ai_conversations')
      .where('expires_at', '<', new Date())
      .execute();
    return result.reduce((sum, row) => sum + Number(row.numDeletedRows), 0);
  }

  return {
    provider,
    status,
    draftForm,
    applyDraft,
    discardDraft,
    translate,
    chat,
    listConversations,
    expireConversations: () => expireConversations(database),
  };
}

export type AiService = ReturnType<typeof createAiService>;

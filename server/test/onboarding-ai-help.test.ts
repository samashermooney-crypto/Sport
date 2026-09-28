import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DB } from '../src/db/types';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { FakeAiProvider } from '../src/modules/ai/provider';
import { redactSensitive } from '../src/modules/ai/redact';
import { createAiService } from '../src/modules/ai/service';
import { createHelpService } from '../src/modules/help/service';
import { createOnboardingService } from '../src/modules/onboarding/service';

import { createTestFactories } from './factories';
import type { ActorFixture } from './factories';

const { Pool } = pg;

let database: Kysely<DB>;
let factories: ReturnType<typeof createTestFactories>;
let actor: ActorFixture;
let outsider: ActorFixture;

beforeAll(async () => {
  database = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString:
          process.env.TEST_DATABASE_APP_URL ?? process.env.TEST_DATABASE_URL,
      }),
    }),
  });
  factories = createTestFactories(database);
  actor = await factories.actor();
  outsider = await factories.actor();
  await factories.scoped(actor, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .execute();
  });
  await factories.scoped(outsider, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', outsider.orgId)
      .execute();
  });
});

afterAll(async () => {
  await database.destroy();
});

describe('onboarding checklist', () => {
  it('creates all nine items and detects completed work', async () => {
    const onboarding = createOnboardingService(database);
    // users_roles completes when the org has more than one active member.
    const secondAdmin = await factories.scoped(actor, async (trx) => {
      const accountId = crypto.randomUUID();
      await database
        .insertInto('accounts')
        .values({
          id: accountId,
          email: `second-${accountId}@example.invalid`,
          first_name: 'Second',
          last_name: 'Staff',
          date_of_birth: '1988-01-01',
          email_verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('org_memberships')
        .values({
          id: crypto.randomUUID(),
          org_id: actor.orgId,
          account_id: accountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      return accountId;
    });
    expect(secondAdmin).toBeTruthy();
    const first = await onboarding.getChecklist(actor.orgId, actor.accountId);
    expect(first.items).toHaveLength(9);
    expect(
      first.items.find((item) => item.key === 'import_members')?.href,
    ).toBe(`/console/orgs/${actor.orgId}/onboarding/imports`);
    // Fixture org has a membership (users_roles) — already complete.
    const usersRoles = first.items.find((item) => item.key === 'users_roles');
    expect(usersRoles?.state).toBe('complete');
    const payments = first.items.find(
      (item) => item.key === 'connect_payments',
    );
    expect(payments?.state).toBe('pending');
    const second = await onboarding.getChecklist(actor.orgId, actor.accountId);
    expect(second.items).toHaveLength(9);
    const rows = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('org_onboarding_items')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(rows).toHaveLength(9);
  });

  it('dismisses and restores items persistently', async () => {
    const onboarding = createOnboardingService(database);
    await onboarding.dismiss(actor.orgId, actor.accountId, 'connect_payments');
    let list = await onboarding.getChecklist(actor.orgId, actor.accountId);
    expect(
      list.items.find((item) => item.key === 'connect_payments')?.state,
    ).toBe('dismissed');
    await onboarding.restore(actor.orgId, actor.accountId, 'connect_payments');
    list = await onboarding.getChecklist(actor.orgId, actor.accountId);
    expect(
      list.items.find((item) => item.key === 'connect_payments')?.state,
    ).toBe('pending');
    await onboarding.dismissAll(actor.orgId, actor.accountId);
    list = await onboarding.getChecklist(actor.orgId, actor.accountId);
    expect(list.items.every((item) => item.state !== 'pending')).toBe(true);
    expect(list.completeCount).toBe(1);
    await factories.scoped(actor, async (trx) => {
      await trx
        .insertInto('facilities')
        .values({
          id: crypto.randomUUID(),
          org_id: actor.orgId,
          name: 'Fixture Facility',
          ownership: 'owned',
        })
        .execute();
    });
    list = await onboarding.getChecklist(actor.orgId, actor.accountId);
    expect(
      list.items.find((item) => item.key === 'add_facilities')?.state,
    ).toBe('complete');
    expect(list.completeCount).toBe(2);
  });

  it('isolates checklist between tenants', async () => {
    const onboarding = createOnboardingService(database);
    await expect(
      onboarding.getChecklist(actor.orgId, outsider.accountId),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('help center', () => {
  it('lists and serves articles in English and Spanish', () => {
    const help = createHelpService(database, null, null);
    const catalog = help.catalog('en');
    expect(catalog.articles.length).toBeGreaterThanOrEqual(8);
    expect(catalog.categories).toContain('Switch to Athlentry');
    const es = help.catalog('es');
    const switchGuide = es.articles.find(
      (article) => article.slug === 'switch-from-leagueapps',
    );
    expect(switchGuide?.title).toContain('LeagueApps');
    const article = help.getArticle('switch-from-leagueapps', 'es');
    expect(article?.body).toContain('Athlentry');
    expect(help.getArticle('missing-article', 'en')).toBeNull();
  });

  it('searches articles', () => {
    const help = createHelpService(database, null, null);
    const results = help.search('duplicate import', 'en');
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((item) => item.slug)).toContain(
      'imports-troubleshooting',
    );
  });

  it('records a support request and emails the inbox', async () => {
    const email = new FakeEmailSender();
    const help = createHelpService(database, email, 'support@athlentry.test');
    const { id } = await help.createSupportRequest(
      actor.orgId,
      actor.accountId,
      {
        kind: 'concierge_import',
        subject: 'Migrate us from LeagueApps',
        body: 'We have 400 players and three seasons of history.',
      },
    );
    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]?.to).toBe('support@athlentry.test');
    const row = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('support_requests')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe('sent');
    expect(row.kind).toBe('concierge_import');
  });

  it('allows a verified family link to contact support with safe context only', async () => {
    const familyAccountId = crypto.randomUUID();
    const personId = await factories.person(actor, {
      firstName: 'Family',
      lastName: 'Contact',
    });
    await database
      .insertInto('accounts')
      .values({
        id: familyAccountId,
        email: `family-${familyAccountId}@example.invalid`,
        first_name: 'Family',
        last_name: 'Contact',
        date_of_birth: '1988-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await factories.scoped(actor, (trx) =>
      trx
        .insertInto('person_account_links')
        .values({
          id: crypto.randomUUID(),
          org_id: actor.orgId,
          account_id: familyAccountId,
          person_id: personId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute()
        .then(() => undefined),
    );
    const email = new FakeEmailSender();
    const help = createHelpService(database, email, 'support@athlentry.test');
    const { id } = await help.createSupportRequest(
      actor.orgId,
      familyAccountId,
      {
        kind: 'support',
        subject: 'Portal help',
        body: 'I need help signing in.',
        context: {
          surface: 'portal',
          path: `/portal/orgs/${actor.orgId}/help?childEmail=private@example.test`,
          childId: personId,
          email: 'private@example.test',
        },
      },
    );
    const row = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('support_requests')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.context).toEqual({
      surface: 'portal',
      path: '/portal/orgs/:id/help',
    });
    expect(email.messages[0]?.text).not.toContain('private@example.test');
    await expect(
      help.createSupportRequest(actor.orgId, familyAccountId, {
        kind: 'concierge_import',
        subject: 'Import',
        body: 'Please help',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('redaction', () => {
  it('strips emails and phone numbers', () => {
    const result = redactSensitive(
      'Call Dana at 555-867-5309 or dana@example.org for the 2026 waiver.',
    );
    expect(result.text).not.toContain('dana@example.org');
    expect(result.text).not.toContain('555-867-5309');
    expect(result.redactions).toBe(2);
  });
});

describe('ai service', () => {
  it('stays disabled without a provider', async () => {
    const service = createAiService(
      database,
      new (await import('../src/modules/ai/provider')).AiDisabledProvider(),
    );
    expect(service.status(actor.orgId).enabled).toBe(false);
    await expect(
      service.translate(actor.orgId, actor.accountId, {
        text: 'Hello',
        target: 'es',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'AI_DISABLED' });
  });

  it('translates via the fake provider and audits usage', async () => {
    const provider = new FakeAiProvider();
    provider.handler = () => 'Hola, familia.';
    const service = createAiService(database, provider);
    const result = await service.translate(actor.orgId, actor.accountId, {
      text: 'Hello, family. Email me at coach@example.org',
      target: 'es',
    });
    expect(result.text).toBe('Hola, familia.');
    expect(result.redactions).toBe(1);
    const prompt = provider.calls.at(-1)?.at(-1)?.content ?? '';
    expect(prompt).not.toContain('coach@example.org');
    const usage = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('ai_usage_events')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('feature', '=', 'translation')
        .execute(),
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.at(-1)?.status).toBe('ok');
  });

  it('drafts a form from a text document without auto-saving', async () => {
    const provider = new FakeAiProvider();
    provider.handler = () =>
      JSON.stringify({
        title: 'Player Waiver',
        description: 'Standard waiver',
        fields: [
          {
            key: 'signature',
            label: 'Signature',
            type: 'signature',
            required: true,
          },
        ],
      });
    const service = createAiService(database, provider);
    const formsBeforeDraft = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('form_definitions')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    const { draftId, draft } = await service.draftForm(
      actor.orgId,
      actor.accountId,
      'waiver.txt',
      new TextEncoder().encode('I agree to the terms for my child'),
    );
    expect((draft as { title: string }).title).toBe('Player Waiver');
    const [formsAfterDraft, savedDraft] = await Promise.all([
      factories.scoped(actor, (trx) =>
        trx
          .selectFrom('form_definitions')
          .selectAll()
          .where('org_id', '=', actor.orgId)
          .execute(),
      ),
      factories.scoped(actor, (trx) =>
        trx
          .selectFrom('ai_drafts')
          .select(['id', 'status'])
          .where('org_id', '=', actor.orgId)
          .where('id', '=', draftId)
          .executeTakeFirstOrThrow(),
      ),
    ]);
    expect(formsAfterDraft).toHaveLength(formsBeforeDraft.length);
    expect(savedDraft.status).toBe('pending');

    const applied = await service.applyDraft(
      actor.orgId,
      actor.accountId,
      draftId,
    );
    const formsAfterApply = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('form_definitions')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .execute(),
    );
    expect(formsAfterApply.length).toBe(formsBeforeDraft.length + 1);
    expect(applied.formDefinitionId).toBeTruthy();
  });

  it('refuses child-specific and balance questions without calling the provider', async () => {
    const provider = new FakeAiProvider();
    const service = createAiService(database, provider);
    const before = provider.calls.length;
    const answer = await service.chat(
      actor.orgId,
      null,
      'visitor-1',
      'What is my son account balance?',
    );
    expect(answer.refused).toBe(true);
    expect(provider.calls.length).toBe(before);
    const namedChildAnswer = await service.chat(
      actor.orgId,
      null,
      'visitor-2',
      "What time does Maya's team practice?",
    );
    expect(namedChildAnswer.refused).toBe(true);
    expect(provider.calls.length).toBe(before);
    const usage = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('ai_usage_events')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('feature', '=', 'help_assistant')
        .execute(),
    );
    expect(usage.at(-1)?.status).toBe('refused');
  });

  it('answers grounded questions with citations and retains the conversation', async () => {
    const provider = new FakeAiProvider();
    provider.handler = () =>
      JSON.stringify({
        answer: 'Fixture League runs March through November.',
        sources: ['Fixture Organization'],
      });
    const service = createAiService(database, provider);
    const answer = await service.chat(
      actor.orgId,
      actor.accountId,
      null,
      'When does the season run? Email coach@example.test or call 555-010-1234.',
    );
    expect(answer.refused).toBe(false);
    expect(answer.answer).toContain('March');
    const conversation = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('ai_conversations')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('id', '=', answer.conversationId)
        .executeTakeFirstOrThrow(),
    );
    expect(conversation.expires_at.getTime()).toBeGreaterThan(Date.now());
    const messages = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('ai_conversation_messages')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('conversation_id', '=', answer.conversationId)
        .execute(),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).not.toContain('coach@example.test');
    expect(messages[0]?.content).not.toContain('555-010-1234');
    expect(provider.calls[0]?.at(-1)?.content).not.toContain(
      'coach@example.test',
    );
  });
});

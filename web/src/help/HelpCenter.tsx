import {
  aiChatResponseSchema,
  aiStatusSchema,
  helpArticleSchema,
  helpCatalogSchema,
  helpSearchResultsSchema,
  supportRequestResponseSchema,
} from '@shared/schemas/growth';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { apiGet, apiPost, orgHeaders } from '../api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../ui/primitives';
import { OrgShell } from '../ui/OrgShell';

export function HelpCenter({
  orgId,
  audience,
}: {
  orgId: string;
  audience: 'admin' | 'family';
}): React.JSX.Element {
  const [locale, setLocale] = useState('en');
  const [slug, setSlug] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const catalog = useQuery({
    queryKey: ['help', 'catalog', locale, audience],
    queryFn: () =>
      apiGet(
        `/help/articles?locale=${locale}&audience=${audience}`,
        helpCatalogSchema,
        orgHeaders(orgId),
      ),
  });
  const search = useQuery({
    queryKey: ['help', 'search', locale, query],
    queryFn: () =>
      apiGet(
        `/help/search?q=${encodeURIComponent(query)}&locale=${locale}`,
        helpSearchResultsSchema,
        orgHeaders(orgId),
      ),
    enabled: query.trim().length >= 2,
  });
  const aiStatus = useQuery({
    queryKey: ['ai', orgId, 'status'],
    queryFn: () =>
      apiGet('/ai/status', aiStatusSchema, orgHeaders(orgId)),
  });
  if (slug) {
    return (
      <HelpArticleView
        orgId={orgId}
        slug={slug}
        locale={locale}
        onBack={() => setSlug(null)}
      />
    );
  }
  const results = query.trim().length >= 2 ? search.data?.results : undefined;
  return (
    <OrgShell orgId={orgId}>
      <main className="help-center">
        <PageHeader
          title={locale === 'es' ? 'Centro de ayuda' : 'Help center'}
          kicker={audience === 'admin' ? 'ADMIN HELP' : 'FAMILY HELP'}
          description={
            locale === 'es'
              ? 'Guías, migración desde otras plataformas y soporte.'
              : 'Guides, switching from other platforms, and support.'
          }
        />
        <Card>
          <div className="help-category-list">
            <Field label="Language / Idioma">
              <Select
                value={locale}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'es', label: 'Español' },
                ]}
                onChange={(event) => setLocale(event.target.value)}
              />
            </Field>
            <Field label={locale === 'es' ? 'Buscar' : 'Search'}>
              <Input
                value={query}
                placeholder={
                  locale === 'es' ? 'Buscar en la ayuda…' : 'Search help…'
                }
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
          </div>
        </Card>
        {results ? (
          <Card>
            <h2>{locale === 'es' ? 'Resultados' : 'Results'}</h2>
            <ul>
              {results.map((article) => (
                <li key={article.slug}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setSlug(article.slug)}
                  >
                    {article.title}
                  </button>{' '}
                  — {article.summary}
                </li>
              ))}
              {results.length === 0 && (
                <li>
                  {locale === 'es'
                    ? 'Sin resultados. Contacte soporte abajo.'
                    : 'No results. Contact support below.'}
                </li>
              )}
            </ul>
          </Card>
        ) : (
          (catalog.data?.categories ?? []).map((category) => (
            <Card key={category}>
              <h2>{category}</h2>
              <ul>
                {(catalog.data?.articles ?? [])
                  .filter((article) => article.category === category)
                  .map((article) => (
                    <li key={article.slug}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setSlug(article.slug)}
                      >
                        {article.title}
                      </button>{' '}
                      — {article.summary}
                    </li>
                  ))}
              </ul>
            </Card>
          ))
        )}
        {aiStatus.data?.enabled && (
          <AiHelpChat orgId={orgId} locale={locale} />
        )}
        {audience === 'admin' && <SupportCard orgId={orgId} locale={locale} />}
      </main>
    </OrgShell>
  );
}

function HelpArticleView({
  orgId,
  slug,
  locale,
  onBack,
}: {
  orgId: string;
  slug: string;
  locale: string;
  onBack: () => void;
}): React.JSX.Element {
  const article = useQuery({
    queryKey: ['help', 'article', slug, locale],
    queryFn: () =>
      apiGet(
        `/help/articles/${slug}?locale=${locale}`,
        helpArticleSchema,
        orgHeaders(orgId),
      ),
  });
  return (
    <OrgShell orgId={orgId}>
      <main className="help-center">
        <Button secondary onClick={onBack}>
          ← {locale === 'es' ? 'Ayuda' : 'Help'}
        </Button>
        {article.data ? (
          <Card>
            <Badge>{article.data.category}</Badge>
            <h1>{article.data.title}</h1>
            <div className="help-article-body">{article.data.body}</div>
          </Card>
        ) : (
          <Card>
            <p role="status">Loading article…</p>
          </Card>
        )}
      </main>
    </OrgShell>
  );
}

function SupportCard({
  orgId,
  locale,
}: {
  orgId: string;
  locale: string;
}): React.JSX.Element {
  const [kind, setKind] = useState<'support' | 'concierge_import'>('support');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState('');
  const [sentId, setSentId] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () =>
      apiPost(
        '/help/support-requests',
        {
          kind,
          subject,
          body,
          ...(email ? { contactEmail: email } : {}),
        },
        supportRequestResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: (result) => setSentId(result.id),
  });
  return (
    <Card>
      <h2>
        {locale === 'es' ? 'Contactar soporte' : 'Contact support'}
      </h2>
      {sentId ? (
        <p role="status">
          {locale === 'es'
            ? 'Solicitud enviada. Le responderemos pronto.'
            : 'Request sent. We will reply by email shortly.'}
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send.mutate();
          }}
        >
          <Field label={locale === 'es' ? 'Tipo' : 'Request type'}>
            <Select
              value={kind}
              options={[
                {
                  value: 'support',
                  label: locale === 'es' ? 'Soporte general' : 'General support',
                },
                {
                  value: 'concierge_import',
                  label:
                    locale === 'es'
                      ? 'Importación con asistencia'
                      : 'Concierge import',
                },
              ]}
              onChange={(event) =>
                setKind(event.target.value as 'support' | 'concierge_import')
              }
            />
          </Field>
          <Field label={locale === 'es' ? 'Asunto' : 'Subject'}>
            <Input
              value={subject}
              required
              maxLength={200}
              onChange={(event) => setSubject(event.target.value)}
            />
          </Field>
          <Field label={locale === 'es' ? 'Mensaje' : 'Message'}>
            <Textarea
              value={body}
              required
              rows={4}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
          <Field
            label={
              locale === 'es'
                ? 'Correo de contacto (opcional)'
                : 'Contact email (optional)'
            }
          >
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={send.isPending}>
            {send.isPending
              ? locale === 'es'
                ? 'Enviando…'
                : 'Sending…'
              : locale === 'es'
                ? 'Enviar'
                : 'Send'}
          </Button>
        </form>
      )}
    </Card>
  );
}

export function AiHelpChat({
  orgId,
  locale,
}: {
  orgId: string;
  locale: string;
}): React.JSX.Element {
  const [message, setMessage] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [log, setLog] = useState<
    { role: 'visitor' | 'assistant'; text: string; citations?: string[] }[]
  >([]);
  const visitorKey = useMemo(
    () =>
      globalThis.crypto?.randomUUID?.() ??
      `visitor-${String(Math.random()).slice(2)}`,
    [],
  );
  const send = useMutation({
    mutationFn: (text: string) =>
      apiPost(
        '/ai/chat',
        {
          message: text,
          visitorKey,
          ...(conversationId ? { conversationId } : {}),
        },
        aiChatResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: (result) => {
      setConversationId(result.conversationId);
      setLog((current) => [
        ...current,
        {
          role: 'assistant',
          text: result.answer,
          citations: result.citations.map((citation) => citation.title),
        },
      ]);
    },
  });
  return (
    <Card>
      <h2>{locale === 'es' ? 'Asistente de ayuda' : 'Help assistant'}</h2>
      <div className="ai-chat-log" aria-live="polite">
        {log.map((entry, index) => (
          <div key={index} className={`ai-chat-message ${entry.role}`}>
            {entry.text}
            {entry.citations && entry.citations.length > 0 && (
              <small>
                {' '}
                ({locale === 'es' ? 'Fuentes' : 'Sources'}:{' '}
                {entry.citations.join(', ')})
              </small>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = message.trim();
          if (!text) return;
          setLog((current) => [...current, { role: 'visitor', text }]);
          setMessage('');
          send.mutate(text);
        }}
      >
        <Field label={locale === 'es' ? 'Pregunta' : 'Ask a question'}>
          <Input
            value={message}
            maxLength={4000}
            placeholder={
              locale === 'es'
                ? 'Pregunte sobre programas o la plataforma…'
                : 'Ask about programs or the platform…'
            }
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={send.isPending || !message.trim()}>
          {send.isPending ? '…' : locale === 'es' ? 'Enviar' : 'Send'}
        </Button>
      </form>
      {send.isError && (
        <p role="alert" className="imports-error">
          {send.error instanceof Error ? send.error.message : 'Chat failed'}
        </p>
      )}
    </Card>
  );
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link as RouterLink, useLocation } from 'react-router';

import { apiPost } from '../../api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../../ui/primitives';

import { aiFeaturesEnabled } from './ai-enabled';
import { apiGetOrg, orgHeaders } from './api';
import {
  aiChatResponseSchema,
  helpArticleSchema,
  helpCatalogSchema,
  helpSearchResultsSchema,
  supportRequestResponseSchema,
} from './schemas';

import './help.css';

export function HelpCenter({
  orgId,
  audience,
}: {
  orgId: string;
  audience: 'admin' | 'family';
}): React.JSX.Element {
  const location = useLocation();
  const [locale, setLocale] = useState('en');
  const [slug, setSlug] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const catalog = useQuery({
    queryKey: ['help', 'catalog', locale, audience],
    queryFn: () =>
      apiGetOrg(
        `/help/articles?locale=${locale}&audience=${audience}`,
        helpCatalogSchema,
        orgId,
      ),
  });
  const search = useQuery({
    queryKey: ['help', 'search', locale, query],
    queryFn: () =>
      apiGetOrg(
        `/help/search?q=${encodeURIComponent(query)}&locale=${locale}`,
        helpSearchResultsSchema,
        orgId,
      ),
    enabled: query.trim().length >= 2,
  });
  if (slug) {
    return (
      <HelpArticleView
        orgId={orgId}
        slug={slug}
        locale={locale}
        onBack={() => {
          setSlug(null);
        }}
      />
    );
  }
  const searching = query.trim().length >= 2;
  return (
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
              onChange={(event) => {
                setLocale(event.target.value);
              }}
            />
          </Field>
          <Field label={locale === 'es' ? 'Buscar' : 'Search'}>
            <Input
              value={query}
              placeholder={
                locale === 'es' ? 'Buscar en la ayuda…' : 'Search help…'
              }
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </Field>
        </div>
      </Card>
      {searching ? (
        <Card>
          <h2>{locale === 'es' ? 'Resultados' : 'Results'}</h2>
          {search.isPending ? (
            <p role="status">{locale === 'es' ? 'Buscando…' : 'Searching…'}</p>
          ) : search.isError ? (
            <>
              <p role="alert" className="help-error">
                {locale === 'es'
                  ? 'No se pudo buscar en la ayuda.'
                  : 'Help search is unavailable right now.'}
              </p>
              <Button
                secondary
                onClick={() => {
                  void search.refetch();
                }}
              >
                {locale === 'es' ? 'Reintentar búsqueda' : 'Retry search'}
              </Button>
            </>
          ) : (
            <ul>
              {search.data.results.map((article) => (
                <li key={article.slug}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setSlug(article.slug);
                    }}
                  >
                    {article.title}
                  </button>{' '}
                  — {article.summary}
                </li>
              ))}
              {search.data.results.length === 0 && (
                <li>
                  {locale === 'es'
                    ? 'Sin resultados. Contacte soporte abajo.'
                    : 'No results. Contact support below.'}
                </li>
              )}
            </ul>
          )}
        </Card>
      ) : catalog.isPending ? (
        <Card>
          <p role="status">
            {locale === 'es' ? 'Cargando artículos…' : 'Loading help articles…'}
          </p>
        </Card>
      ) : catalog.isError ? (
        <Card>
          <p role="alert" className="help-error">
            {locale === 'es'
              ? 'No se pudieron cargar los artículos.'
              : 'Help articles are unavailable right now.'}
          </p>
          <Button
            secondary
            onClick={() => {
              void catalog.refetch();
            }}
          >
            {locale === 'es' ? 'Reintentar' : 'Retry'}
          </Button>
        </Card>
      ) : catalog.data.categories.length === 0 ? (
        <Card>
          <p role="status">
            {locale === 'es'
              ? 'Todavía no hay artículos de ayuda.'
              : 'No help articles are available yet.'}
          </p>
        </Card>
      ) : (
        catalog.data.categories.map((category) => (
          <Card key={category}>
            <h2>{category}</h2>
            <ul>
              {catalog.data.articles
                .filter((article) => article.category === category)
                .map((article) => (
                  <li key={article.slug}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        setSlug(article.slug);
                      }}
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
      {aiFeaturesEnabled && <AiHelpChat orgId={orgId} locale={locale} />}
      <SupportCard
        orgId={orgId}
        locale={locale}
        audience={audience}
        path={location.pathname}
      />
    </main>
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
      apiGetOrg(
        `/help/articles/${slug}?locale=${locale}`,
        helpArticleSchema,
        orgId,
      ),
  });
  return (
    <main className="help-center">
      <Button secondary onClick={onBack}>
        ← {locale === 'es' ? 'Ayuda' : 'Help'}
      </Button>
      {article.data ? (
        <Card>
          <Badge>{article.data.category}</Badge>
          <h1>{article.data.title}</h1>
          <div className="help-article-body">
            {renderMarkdown(
              stripArticleTitleHeading(article.data.body, article.data.title),
              orgId,
            )}
          </div>
        </Card>
      ) : article.isError ? (
        <Card>
          <p role="alert">
            {locale === 'es'
              ? 'No se pudo cargar el artículo. Inténtelo de nuevo.'
              : 'The article could not be loaded. Please try again.'}
          </p>
          <Button
            secondary
            onClick={() => {
              void article.refetch();
            }}
          >
            {locale === 'es' ? 'Reintentar' : 'Retry'}
          </Button>
        </Card>
      ) : (
        <Card>
          <p role="status">
            {locale === 'es' ? 'Cargando artículo…' : 'Loading article…'}
          </p>
        </Card>
      )}
    </main>
  );
}

function SupportCard({
  orgId,
  locale,
  audience,
  path,
}: {
  orgId: string;
  locale: string;
  audience: 'admin' | 'family';
  path: string;
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
          context: {
            surface: audience === 'family' ? 'portal' : 'console',
            path,
          },
        },
        supportRequestResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: (result) => {
      setSentId(result.id);
    },
  });
  return (
    <Card>
      <h2>{locale === 'es' ? 'Contactar soporte' : 'Contact support'}</h2>
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
                  label:
                    locale === 'es' ? 'Soporte general' : 'General support',
                },
                ...(audience === 'admin'
                  ? [
                      {
                        value: 'concierge_import',
                        label:
                          locale === 'es'
                            ? 'Importación con asistencia'
                            : 'Concierge import',
                      },
                    ]
                  : []),
              ]}
              onChange={(event) => {
                setKind(event.target.value as 'support' | 'concierge_import');
              }}
            />
          </Field>
          <Field label={locale === 'es' ? 'Asunto' : 'Subject'}>
            <Input
              value={subject}
              required
              maxLength={200}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
            />
          </Field>
          <Field label={locale === 'es' ? 'Mensaje' : 'Message'}>
            <Textarea
              value={body}
              required
              rows={4}
              onChange={(event) => {
                setBody(event.target.value);
              }}
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
              onChange={(event) => {
                setEmail(event.target.value);
              }}
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
          {send.isError && (
            <p role="alert" className="help-error">
              {send.error instanceof Error
                ? send.error.message
                : locale === 'es'
                  ? 'No se pudo enviar la solicitud.'
                  : 'The request could not be sent.'}
            </p>
          )}
        </form>
      )}
    </Card>
  );
}

function inlineMarkdown(text: string, orgId: string): React.ReactNode[] {
  const token = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  return text
    .split(token)
    .filter(Boolean)
    .map((part, index) => {
      const key = `${String(index)}-${part}`;
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        const label = link[1] ?? '';
        const href = (link[2] ?? '').replaceAll(':orgId', orgId);
        if (href.startsWith('/console/') || href.startsWith('/portal/'))
          return (
            <RouterLink key={key} to={href}>
              {label}
            </RouterLink>
          );
        if (/^https:\/\//i.test(href))
          return (
            <a key={key} href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          );
        return label;
      }
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={key}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('*') && part.endsWith('*'))
        return <em key={key}>{part.slice(1, -1)}</em>;
      if (part.startsWith('`') && part.endsWith('`'))
        return <code key={key}>{part.slice(1, -1)}</code>;
      return part;
    });
}

function renderMarkdown(body: string, orgId: string): React.ReactNode[] {
  const lines = body.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([a-z0-9_-]*)\s*$/i);
    if (fence) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={`code-${String(index)}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const depth = heading[1]?.length ?? 2;
      const content = inlineMarkdown(heading[2] ?? '', orgId);
      const props = { key: `heading-${String(index)}` };
      blocks.push(
        depth === 1 ? (
          <h1 {...props}>{content}</h1>
        ) : depth === 2 ? (
          <h2 {...props}>{content}</h2>
        ) : depth === 3 ? (
          <h3 {...props}>{content}</h3>
        ) : (
          <h4 {...props}>{content}</h4>
        ),
      );
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? '').trimStart().startsWith('|')
      ) {
        tableLines.push(lines[index] ?? '');
        index += 1;
      }
      const rows = tableLines
        .map((row) =>
          row
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim()),
        )
        .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
      const header = rows[0] ?? [];
      blocks.push(
        <table key={`table-${String(index)}`}>
          <thead>
            <tr>
              {header.map((cell, cellIndex) => (
                <th key={cellIndex}>{inlineMarkdown(cell, orgId)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{inlineMarkdown(cell, orgId)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push(
          <li key={index}>
            {inlineMarkdown(
              (lines[index] ?? '').replace(/^\s*[-*]\s+/, ''),
              orgId,
            )}
          </li>,
        );
        index += 1;
      }
      blocks.push(<ul key={`list-${String(index)}`}>{items}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push(
          <li key={index}>
            {inlineMarkdown(
              (lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''),
              orgId,
            )}
          </li>,
        );
        index += 1;
      }
      blocks.push(<ol key={`ordered-${String(index)}`}>{items}</ol>);
      continue;
    }
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('> ')) {
        quote.push((lines[index] ?? '').slice(2));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${String(index)}`}>
          {quote.map((item) => inlineMarkdown(item, orgId))}
        </blockquote>,
      );
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !/^(#{1,6}\s|\s*[-*]\s+|\s*\d+\.\s+|> |\|)/.test(lines[index] ?? '') &&
      !/^```/.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${String(index)}`}>
        {inlineMarkdown(paragraph.join(' '), orgId)}
      </p>,
    );
  }
  return blocks;
}

function stripArticleTitleHeading(body: string, title: string): string {
  const lines = body.split(/\r?\n/);
  const heading = lines[0]?.match(/^#\s+(.+?)\s*$/)?.[1];
  return heading === title ? lines.slice(1).join('\n').trimStart() : body;
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
  const visitorKey = useMemo(() => globalThis.crypto.randomUUID(), []);
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
            onChange={(event) => {
              setMessage(event.target.value);
            }}
          />
        </Field>
        <Button type="submit" disabled={send.isPending || !message.trim()}>
          {send.isPending ? '…' : locale === 'es' ? 'Enviar' : 'Send'}
        </Button>
      </form>
      {send.isError && (
        <p role="alert" className="help-error">
          {send.error instanceof Error ? send.error.message : 'Chat failed'}
        </p>
      )}
    </Card>
  );
}

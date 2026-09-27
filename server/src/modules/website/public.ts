import { orgSlugSchema } from '@shared/schemas/orgs';
import { websitePageSlugSchema } from '@shared/schemas/website';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AuthDependencies } from '../auth/routes';

import { getPublicWebsitePage } from './service';

function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function renderDocument(
  site: NonNullable<Awaited<ReturnType<typeof getPublicWebsitePage>>>,
) {
  const { organization, page } = site;
  const copy =
    organization.locale === 'es'
      ? {
          navigation: 'Navegación del sitio web',
          footerNavigation: 'Navegación del pie de página',
          signIn: 'Iniciar sesión como administrador',
          accessibility: 'Declaración de accesibilidad',
        }
      : {
          navigation: 'Website navigation',
          footerNavigation: 'Website footer navigation',
          signIn: 'Administrator sign in',
          accessibility: 'Accessibility statement',
        };
  const title = page.seo.title || `${page.title} · ${organization.name}`;
  const description = page.seo.description;
  const canonical = page.seo.canonicalPath
    ? `https://${organization.slug}.athlentry.com${page.seo.canonicalPath}`
    : undefined;
  const blocks = page.blocks.map((block, index) => {
    if (block.type === 'heading')
      return createElement(
        block.level === 2 ? 'h2' : 'h3',
        { key: index },
        block.text,
      );
    if (block.type === 'link')
      return createElement(
        'p',
        { key: index },
        createElement('a', { href: block.href }, block.label),
      );
    return createElement('p', { key: index }, block.text);
  });
  const jsonLd = safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'SportsOrganization',
    name: organization.name,
    url: `https://${organization.slug}.athlentry.com`,
  });
  const document = createElement(
    'html',
    { lang: organization.locale },
    createElement(
      'head',
      null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      }),
      createElement('link', { rel: 'stylesheet', href: '/site.css' }),
      createElement('title', null, title),
      description
        ? createElement('meta', { name: 'description', content: description })
        : null,
      site.robotsPolicy === 'noindex'
        ? createElement('meta', { name: 'robots', content: 'noindex,nofollow' })
        : null,
      createElement('meta', { property: 'og:title', content: title }),
      description
        ? createElement('meta', {
            property: 'og:description',
            content: description,
          })
        : null,
      canonical
        ? createElement('link', { rel: 'canonical', href: canonical })
        : null,
      page.seo.openGraphImageUrl
        ? createElement('meta', {
            property: 'og:image',
            content: page.seo.openGraphImageUrl,
          })
        : null,
      createElement('script', {
        type: 'application/ld+json',
        dangerouslySetInnerHTML: { __html: jsonLd },
      }),
    ),
    createElement(
      'body',
      null,
      createElement(
        'div',
        {
          className: 'public-site',
          style: {
            '--site-primary': site.theme.primary,
            '--site-secondary': site.theme.secondary,
          },
        },
        createElement(
          'header',
          { className: 'public-site-header' },
          createElement(
            'a',
            {
              className: 'public-site-brand',
              href: `/site/${organization.slug}`,
            },
            createElement(
              'span',
              { className: 'public-site-mark', 'aria-hidden': true },
              'A',
            ),
            organization.name,
          ),
          createElement('a', { href: '/' }, copy.signIn),
        ),
        createElement(
          'nav',
          { className: 'public-site-nav', 'aria-label': copy.navigation },
          createElement(
            'ul',
            null,
            ...site.navigation.map((item) =>
              createElement(
                'li',
                { key: `${item.href}:${item.label}` },
                createElement('a', { href: item.href }, item.label),
              ),
            ),
          ),
        ),
        createElement(
          'main',
          { id: 'main-content', className: 'public-site-main' },
          createElement('h1', null, page.title),
          ...blocks,
        ),
        createElement(
          'footer',
          { className: 'public-site-footer' },
          createElement('strong', null, organization.name),
          createElement(
            'nav',
            { 'aria-label': copy.footerNavigation },
            ...site.footerNavigation.map((item) =>
              createElement(
                'a',
                { key: `${item.href}:${item.label}`, href: item.href },
                item.label,
              ),
            ),
          ),
          createElement(
            'a',
            { href: '/legal/accessibility' },
            copy.accessibility,
          ),
        ),
      ),
    ),
  );
  return `<!doctype html>${renderToStaticMarkup(document)}`;
}

export function createSiteSsrRouter(
  dependencies: Pick<AuthDependencies, 'database'>,
): express.Router {
  const router = express.Router();
  const render =
    (pageSlug: (request: express.Request) => string) =>
    (request: express.Request, response: express.Response) => {
      const orgSlug = orgSlugSchema.safeParse(request.params.orgSlug);
      const slug = websitePageSlugSchema.safeParse(pageSlug(request));
      if (!orgSlug.success || !slug.success) {
        response.sendStatus(404);
        return;
      }
      void getPublicWebsitePage(dependencies.database, orgSlug.data, slug.data)
        .then((site) => {
          if (!site) {
            response.sendStatus(404);
            return;
          }
          response
            .setHeader(
              'Cache-Control',
              'public, max-age=60, stale-while-revalidate=300',
            )
            .type('html')
            .send(renderDocument(site));
        })
        .catch(() => response.sendStatus(500));
    };
  router.get(
    '/:orgSlug',
    render(() => 'home'),
  );
  router.get(
    '/:orgSlug/*pageSlug',
    render((request) => {
      const value = request.params.pageSlug;
      return Array.isArray(value)
        ? value.join('/')
        : typeof value === 'string'
          ? value
          : '';
    }),
  );
  return router;
}

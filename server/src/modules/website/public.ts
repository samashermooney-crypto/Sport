import { orgSlugSchema } from '@shared/schemas/orgs';
import { websitePageSlugSchema } from '@shared/schemas/website';
import express from 'express';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { createWithOrg } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';

import {
  getPublicWebsiteContactPage,
  getPublicWebsiteProgram,
  getPublicWebsitePrograms,
  getPublicWebsiteSchedule,
  getPublicWebsitePage,
  listPublicWebsiteNews,
} from './service';

function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function siteFontPreloads(): ReactNode[] {
  return [
    createElement('link', {
      key: 'fonts-preconnect',
      rel: 'preconnect',
      href: 'https://fonts.googleapis.com',
    }),
    createElement('link', {
      key: 'font-files-preconnect',
      rel: 'preconnect',
      href: 'https://fonts.gstatic.com',
      crossOrigin: 'anonymous',
    }),
    createElement('link', {
      key: 'open-sans-latin-preload',
      rel: 'preload',
      href: 'https://fonts.gstatic.com/s/opensans/v44/memvYaGs126MiZpBA-UvWbX2vVnXBbObj2OVTS-mu0SC55I.woff2',
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    }),
    createElement('link', {
      key: 'open-sans-latin-ext-preload',
      rel: 'preload',
      href: 'https://fonts.gstatic.com/l/font?kit=memFYaGs126MiZpBA-UvWbX2vVnXBbObj2OVZyOOSr4dVJWUgsjZ0EwsQaPuWBIXazFHt1kuGajuKbEhWw&skey=62c1cbfccc78b4b2&v=v44',
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    }),
  ];
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
      ...siteFontPreloads(),
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

function renderNewsDocument(
  site: NonNullable<Awaited<ReturnType<typeof listPublicWebsiteNews>>>,
) {
  const { organization } = site;
  const copy =
    organization.locale === 'es'
      ? {
          title: 'Noticias',
          description: `Actualizaciones y anuncios de ${organization.name}.`,
          navigation: 'Navegación del sitio web',
          footerNavigation: 'Navegación del pie de página',
          signIn: 'Iniciar sesión como administrador',
          accessibility: 'Declaración de accesibilidad',
          empty: 'Todavía no hay noticias publicadas.',
        }
      : {
          title: 'News',
          description: `Updates and announcements from ${organization.name}.`,
          navigation: 'Website navigation',
          footerNavigation: 'Website footer navigation',
          signIn: 'Administrator sign in',
          accessibility: 'Accessibility statement',
          empty: 'There are no published news posts yet.',
        };
  const title = `${copy.title} · ${organization.name}`;
  const jsonLd = safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `https://${organization.slug}.athlentry.com/site/${organization.slug}/news`,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: site.posts.map((post, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'NewsArticle',
          headline: post.title,
          datePublished: post.publishedAt,
        },
      })),
    },
  });
  const articles = site.posts.map((post) =>
    createElement(
      'article',
      { key: post.slug },
      createElement('h2', null, post.title),
      post.publishedAt
        ? createElement(
            'time',
            { dateTime: post.publishedAt },
            new Intl.DateTimeFormat(organization.locale, {
              dateStyle: 'long',
              timeZone: 'UTC',
            }).format(new Date(post.publishedAt)),
          )
        : null,
      post.excerpt ? createElement('p', null, post.excerpt) : null,
      createElement('p', null, post.bodyText),
    ),
  );
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
      ...siteFontPreloads(),
      createElement('link', { rel: 'stylesheet', href: '/site.css' }),
      createElement('title', null, title),
      createElement('meta', { name: 'description', content: copy.description }),
      site.robotsPolicy === 'noindex'
        ? createElement('meta', { name: 'robots', content: 'noindex,nofollow' })
        : null,
      createElement('meta', { property: 'og:title', content: title }),
      createElement('meta', {
        property: 'og:description',
        content: copy.description,
      }),
      createElement('link', {
        rel: 'canonical',
        href: `https://${organization.slug}.athlentry.com/site/${organization.slug}/news`,
      }),
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
          createElement('h1', null, copy.title),
          site.posts.length === 0
            ? createElement('p', null, copy.empty)
            : createElement(
                'div',
                { className: 'public-site-news-list' },
                ...articles,
              ),
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

type GeneratedSiteChrome = {
  organization: { id: string; name: string; slug: string; locale: string };
  theme: { primary: string; secondary: string };
  robotsPolicy: string;
  contactEnabled?: boolean;
  navigation: { label: string; href: string }[];
  footerNavigation: { label: string; href: string }[];
};

function renderGeneratedSitePage(
  site: GeneratedSiteChrome,
  options: {
    title: string;
    description: string;
    canonicalPath: string;
    jsonLd: unknown;
    main: ReactNode;
  },
) {
  const spanish = site.organization.locale === 'es';
  const document = createElement(
    'html',
    { lang: site.organization.locale },
    createElement(
      'head',
      null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      }),
      ...siteFontPreloads(),
      createElement('link', { rel: 'stylesheet', href: '/site.css' }),
      createElement('title', null, options.title),
      createElement('meta', {
        name: 'description',
        content: options.description,
      }),
      site.robotsPolicy === 'noindex'
        ? createElement('meta', { name: 'robots', content: 'noindex,nofollow' })
        : null,
      createElement('meta', { property: 'og:title', content: options.title }),
      createElement('meta', {
        property: 'og:description',
        content: options.description,
      }),
      createElement('link', {
        rel: 'canonical',
        href: `https://${site.organization.slug}.athlentry.com${options.canonicalPath}`,
      }),
      createElement('script', {
        type: 'application/ld+json',
        dangerouslySetInnerHTML: { __html: safeJsonLd(options.jsonLd) },
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
              href: `/site/${site.organization.slug}`,
            },
            createElement(
              'span',
              { className: 'public-site-mark', 'aria-hidden': true },
              'A',
            ),
            site.organization.name,
          ),
          createElement(
            'a',
            { href: '/' },
            spanish ? 'Acceso del club' : 'Club sign in',
          ),
        ),
        createElement(
          'nav',
          {
            className: 'public-site-nav',
            'aria-label': spanish
              ? 'Navegación del sitio web'
              : 'Website navigation',
          },
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
        options.main,
        createElement(
          'footer',
          { className: 'public-site-footer' },
          createElement('strong', null, site.organization.name),
          createElement(
            'nav',
            {
              'aria-label': spanish
                ? 'Navegación del pie de página'
                : 'Website footer navigation',
            },
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
            spanish
              ? 'Declaración de accesibilidad'
              : 'Accessibility statement',
          ),
        ),
      ),
    ),
  );
  return `<!doctype html>${renderToStaticMarkup(document)}`;
}

function formatSiteDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00.000Z`));
}

function programStatusLabel(status: string, locale: string) {
  const labels: Record<string, { en: string; es: string }> = {
    published: { en: 'Published', es: 'Publicado' },
    registration_open: {
      en: 'Registration open',
      es: 'Inscripciones abiertas',
    },
    registration_closed: {
      en: 'Registration closed',
      es: 'Inscripciones cerradas',
    },
    in_progress: { en: 'In progress', es: 'En curso' },
    completed: { en: 'Completed', es: 'Finalizado' },
  };
  return labels[status]?.[locale === 'es' ? 'es' : 'en'] ?? status;
}

function renderProgramsDocument(
  site: NonNullable<Awaited<ReturnType<typeof getPublicWebsitePrograms>>>,
) {
  const spanish = site.organization.locale === 'es';
  const title = `${spanish ? 'Programas' : 'Programs'} · ${site.organization.name}`;
  const description = spanish
    ? `Programas deportivos y oportunidades para participar con ${site.organization.name}.`
    : `Sports programs and ways to participate with ${site.organization.name}.`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: `https://${site.organization.slug}.athlentry.com/site/${site.organization.slug}/programs`,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: site.programs.map((program, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'SportsActivityLocation',
          name: program.name,
          url: `https://${site.organization.slug}.athlentry.com/site/${site.organization.slug}/programs/${program.slug}`,
        },
      })),
    },
  };
  const rows = site.programs.map((program) =>
    createElement(
      'article',
      { key: program.slug },
      createElement(
        'h2',
        null,
        createElement(
          'a',
          { href: `/site/${site.organization.slug}/programs/${program.slug}` },
          program.name,
        ),
      ),
      createElement('p', null, program.seasonName),
      createElement(
        'p',
        null,
        `${formatSiteDate(program.startsOn, site.organization.locale)} – ${formatSiteDate(program.endsOn, site.organization.locale)}`,
      ),
      createElement(
        'p',
        null,
        programStatusLabel(program.status, site.organization.locale),
      ),
    ),
  );
  return renderGeneratedSitePage(site, {
    title,
    description,
    canonicalPath: `/site/${site.organization.slug}/programs`,
    jsonLd,
    main: createElement(
      'main',
      { id: 'main-content', className: 'public-site-main' },
      createElement('h1', null, spanish ? 'Programas' : 'Programs'),
      site.programs.length
        ? createElement('div', { className: 'public-site-news-list' }, ...rows)
        : createElement(
            'p',
            null,
            spanish
              ? 'Aún no hay programas públicos disponibles.'
              : 'There are no public programs available yet.',
          ),
    ),
  });
}

function renderProgramDocument(
  site: NonNullable<Awaited<ReturnType<typeof getPublicWebsiteProgram>>>,
) {
  const spanish = site.organization.locale === 'es';
  const { program } = site;
  const title = `${program.name} · ${site.organization.name}`;
  const description = spanish
    ? `${program.name}: ${formatSiteDate(program.startsOn, site.organization.locale)} – ${formatSiteDate(program.endsOn, site.organization.locale)}.`
    : `${program.name}: ${formatSiteDate(program.startsOn, site.organization.locale)} – ${formatSiteDate(program.endsOn, site.organization.locale)}.`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name: program.name,
    url: `https://${site.organization.slug}.athlentry.com/site/${site.organization.slug}/programs/${program.slug}`,
    sport: program.mode,
    provider: {
      '@type': 'SportsOrganization',
      name: site.organization.name,
      url: `https://${site.organization.slug}.athlentry.com`,
    },
  };
  return renderGeneratedSitePage(site, {
    title,
    description,
    canonicalPath: `/site/${site.organization.slug}/programs/${program.slug}`,
    jsonLd,
    main: createElement(
      'main',
      { id: 'main-content', className: 'public-site-main' },
      createElement('h1', null, program.name),
      createElement('p', null, program.seasonName),
      createElement(
        'p',
        null,
        `${formatSiteDate(program.startsOn, site.organization.locale)} – ${formatSiteDate(program.endsOn, site.organization.locale)}`,
      ),
      createElement(
        'p',
        null,
        programStatusLabel(program.status, site.organization.locale),
      ),
      program.registrationAvailable
        ? createElement(
            'p',
            null,
            createElement(
              'a',
              { href: `/portal/orgs/${site.organization.id}/register` },
              spanish
                ? 'Ver opciones de inscripción'
                : 'View registration options',
            ),
          )
        : null,
      createElement(
        'p',
        null,
        createElement(
          'a',
          { href: `/site/${site.organization.slug}/programs` },
          spanish ? 'Todos los programas' : 'All programs',
        ),
      ),
    ),
  });
}

function formatEventDateTime(value: string, timezone: string, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(value));
  }
}

function renderScheduleDocument(
  site: NonNullable<Awaited<ReturnType<typeof getPublicWebsiteSchedule>>>,
) {
  const spanish = site.organization.locale === 'es';
  const title = `${spanish ? 'Calendario' : 'Schedule'} · ${site.organization.name}`;
  const description = spanish
    ? `Próximos eventos publicados por ${site.organization.name}.`
    : `Upcoming published events from ${site.organization.name}.`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: `https://${site.organization.slug}.athlentry.com/site/${site.organization.slug}/schedule`,
    mainEntity: site.events.map((event) => ({
      '@type': 'SportsEvent',
      name: event.title,
      startDate: event.startsAt,
      endDate: event.endsAt,
      eventStatus:
        event.status === 'postponed'
          ? 'https://schema.org/EventPostponed'
          : 'https://schema.org/EventScheduled',
      location: event.location
        ? { '@type': 'Place', name: event.location }
        : undefined,
      url: `https://${site.organization.slug}.athlentry.com/site/${site.organization.slug}/schedule#${event.id}`,
      organizer: {
        '@type': 'SportsOrganization',
        name: site.organization.name,
      },
    })),
  };
  const rows = site.events.map((event) =>
    createElement(
      'article',
      { key: event.id, id: event.id },
      createElement('h2', null, event.title),
      createElement('p', null, event.programName),
      createElement(
        'p',
        null,
        createElement(
          'time',
          { dateTime: event.startsAt },
          formatEventDateTime(
            event.startsAt,
            event.timezone,
            site.organization.locale,
          ),
        ),
      ),
      event.location ? createElement('p', null, event.location) : null,
      event.status === 'postponed'
        ? createElement('p', null, spanish ? 'Pospuesto' : 'Postponed')
        : null,
    ),
  );
  return renderGeneratedSitePage(site, {
    title,
    description,
    canonicalPath: `/site/${site.organization.slug}/schedule`,
    jsonLd,
    main: createElement(
      'main',
      { id: 'main-content', className: 'public-site-main' },
      createElement('h1', null, spanish ? 'Calendario' : 'Schedule'),
      site.events.length
        ? createElement('div', { className: 'public-site-news-list' }, ...rows)
        : createElement(
            'p',
            null,
            spanish
              ? 'Aún no hay eventos públicos próximos.'
              : 'There are no upcoming public events yet.',
          ),
    ),
  });
}

function renderContactDocument(
  site: NonNullable<Awaited<ReturnType<typeof getPublicWebsiteContactPage>>>,
  options: { siteKey?: string; sent: boolean },
) {
  const spanish = site.organization.locale === 'es';
  const title = `${spanish ? 'Contacto' : 'Contact'} · ${site.organization.name}`;
  const description = spanish
    ? `Contacta con ${site.organization.name}.`
    : `Contact ${site.organization.name}.`;
  const form = createElement(
    'form',
    {
      className: 'public-site-contact-form',
      action: `/api/v1/website/public/${site.organization.slug}/contact`,
      method: 'post',
    },
    createElement(
      'label',
      null,
      spanish ? 'Nombre' : 'Name',
      createElement('input', {
        name: 'name',
        type: 'text',
        autoComplete: 'name',
        maxLength: 120,
        required: true,
      }),
    ),
    createElement(
      'label',
      null,
      spanish ? 'Correo electrónico' : 'Email address',
      createElement('input', {
        name: 'email',
        type: 'email',
        autoComplete: 'email',
        maxLength: 254,
        required: true,
      }),
    ),
    createElement(
      'label',
      null,
      spanish ? 'Asunto (opcional)' : 'Subject (optional)',
      createElement('input', {
        name: 'subject',
        type: 'text',
        maxLength: 160,
      }),
    ),
    createElement(
      'label',
      null,
      spanish ? 'Mensaje' : 'Message',
      createElement('textarea', {
        name: 'body',
        rows: 6,
        maxLength: 5000,
        required: true,
      }),
    ),
    options.siteKey
      ? createElement(
          'div',
          { className: 'public-site-contact-challenge' },
          createElement('div', {
            className: 'cf-turnstile',
            'data-sitekey': options.siteKey,
            'data-action': 'sign-up',
          }),
          createElement('script', {
            src: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
            async: true,
            defer: true,
          }),
        )
      : createElement('input', {
          type: 'hidden',
          name: 'captchaToken',
          value: 'preview-contact-token',
        }),
    createElement(
      'button',
      { type: 'submit' },
      spanish ? 'Enviar mensaje' : 'Send message',
    ),
  );
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: title,
    url: `https://${site.organization.slug}.athlentry.com/site/${site.organization.slug}/contact`,
    mainEntity: {
      '@type': 'SportsOrganization',
      name: site.organization.name,
    },
  };
  return renderGeneratedSitePage(site, {
    title,
    description,
    canonicalPath: `/site/${site.organization.slug}/contact`,
    jsonLd,
    main: createElement(
      'main',
      { id: 'main-content', className: 'public-site-main' },
      createElement('h1', null, spanish ? 'Contacto' : 'Contact'),
      options.sent
        ? createElement(
            'p',
            { role: 'status', 'aria-live': 'polite' },
            spanish
              ? 'Gracias. Hemos recibido tu mensaje.'
              : 'Thank you. Your message has been received.',
          )
        : null,
      form,
    ),
  });
}

export function createSiteSsrRouter(
  dependencies: Pick<AuthDependencies, 'database'> &
    Partial<Pick<AuthDependencies, 'captchaWidget'>>,
): express.Router {
  const router = express.Router();
  const withOrg = createWithOrg(dependencies.database);
  router.get('/:orgSlug/programs/:programSlug', (request, response) => {
    const orgSlug = orgSlugSchema.safeParse(request.params.orgSlug);
    const programSlug = websitePageSlugSchema.safeParse(
      request.params.programSlug,
    );
    if (!orgSlug.success || !programSlug.success) {
      response.sendStatus(404);
      return;
    }
    void getPublicWebsiteProgram(
      dependencies.database,
      orgSlug.data,
      programSlug.data,
      withOrg,
    )
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
          .send(renderProgramDocument(site));
      })
      .catch(() => response.sendStatus(500));
  });
  router.get('/:orgSlug/programs', (request, response) => {
    const orgSlug = orgSlugSchema.safeParse(request.params.orgSlug);
    if (!orgSlug.success) {
      response.sendStatus(404);
      return;
    }
    void getPublicWebsitePrograms(dependencies.database, orgSlug.data, withOrg)
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
          .send(renderProgramsDocument(site));
      })
      .catch(() => response.sendStatus(500));
  });
  router.get('/:orgSlug/schedule', (request, response) => {
    const orgSlug = orgSlugSchema.safeParse(request.params.orgSlug);
    if (!orgSlug.success) {
      response.sendStatus(404);
      return;
    }
    void getPublicWebsiteSchedule(
      dependencies.database,
      orgSlug.data,
      withOrg,
      new Date(),
    )
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
          .send(renderScheduleDocument(site));
      })
      .catch(() => response.sendStatus(500));
  });
  router.get('/:orgSlug/contact', (request, response) => {
    const orgSlug = orgSlugSchema.safeParse(request.params.orgSlug);
    if (!orgSlug.success) {
      response.sendStatus(404);
      return;
    }
    void getPublicWebsiteContactPage(
      dependencies.database,
      orgSlug.data,
      withOrg,
    )
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
          .send(
            renderContactDocument(site, {
              ...(dependencies.captchaWidget?.mode === 'turnstile'
                ? { siteKey: dependencies.captchaWidget.siteKey }
                : {}),
              sent: request.query.sent === '1',
            }),
          );
      })
      .catch(() => response.sendStatus(500));
  });
  router.get('/:orgSlug/news', (request, response) => {
    const orgSlug = orgSlugSchema.safeParse(request.params.orgSlug);
    if (!orgSlug.success) {
      response.sendStatus(404);
      return;
    }
    void listPublicWebsiteNews(dependencies.database, orgSlug.data, withOrg)
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
          .send(renderNewsDocument(site));
      })
      .catch(() => response.sendStatus(500));
  });
  const render =
    (pageSlug: (request: express.Request) => string) =>
    (request: express.Request, response: express.Response) => {
      const orgSlug = orgSlugSchema.safeParse(request.params.orgSlug);
      const slug = websitePageSlugSchema.safeParse(pageSlug(request));
      if (!orgSlug.success || !slug.success) {
        response.sendStatus(404);
        return;
      }
      void getPublicWebsitePage(
        dependencies.database,
        orgSlug.data,
        slug.data,
        withOrg,
      )
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

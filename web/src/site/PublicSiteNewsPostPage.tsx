import { websitePublicNewsPostSchema } from '@shared/schemas/website';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { apiGet } from '../api/client';

export function PublicSiteNewsPostPage(): React.JSX.Element {
  const { t } = useTranslation('site');
  const { orgSlug, newsSlug } = useParams<{
    orgSlug: string;
    newsSlug: string;
  }>();
  const result = useQuery({
    queryKey: ['public-site-news-post', orgSlug, newsSlug],
    queryFn: () =>
      apiGet(
        `/website/public/${encodeURIComponent(String(orgSlug))}/news/${encodeURIComponent(String(newsSlug))}`,
        websitePublicNewsPostSchema,
      ),
    enabled: Boolean(orgSlug && newsSlug),
  });

  useEffect(() => {
    if (!result.data) return;
    const ownedStylesheet = document.querySelector<HTMLLinkElement>(
      'link[data-athlentry-site-style="true"]',
    );
    if (!ownedStylesheet) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = '/site.css';
      stylesheet.dataset.athlentrySiteStyle = 'true';
      document.head.append(stylesheet);
    }
    const { organization, post, robotsPolicy } = result.data;
    const title = `${post.title} · ${organization.name}`;
    const description = (post.excerpt || post.bodyText)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    document.title = title;
    let descriptionMeta = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (!descriptionMeta) {
      descriptionMeta = document.createElement('meta');
      descriptionMeta.name = 'description';
      document.head.append(descriptionMeta);
    }
    descriptionMeta.content = description;
    let canonical = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = `${window.location.origin}/site/${organization.slug}/news/${encodeURIComponent(post.slug)}`;
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robotsPolicy === 'noindex') {
      if (!robots) {
        robots = document.createElement('meta');
        robots.name = 'robots';
        document.head.append(robots);
      }
      robots.content = 'noindex,nofollow';
    } else if (robots) {
      robots.remove();
    }
  }, [result.data]);

  if (result.isPending)
    return (
      <main className="public-site-main" role="status" aria-busy="true">
        <p>{t('loadingWebsite')}</p>
      </main>
    );
  if (result.isError)
    return (
      <main className="public-site-main">
        <h1>{t('newsPostUnavailable')}</h1>
        <p role="alert">{t('newsPostUnavailableDescription')}</p>
      </main>
    );

  const { organization, post, theme } = result.data;
  const publishedDate = post.publishedAt
    ? new Intl.DateTimeFormat(organization.locale, {
        dateStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(post.publishedAt))
    : null;
  return (
    <div
      className="public-site"
      style={
        {
          '--site-primary': theme.primary,
          '--site-secondary': theme.secondary,
        } as React.CSSProperties
      }
    >
      <a className="public-site-skip-link" href="#main-content">
        {t('skipToContent')}
      </a>
      <header className="public-site-header">
        <Link className="public-site-brand" to={`/site/${organization.slug}`}>
          <span className="public-site-mark" aria-hidden="true">
            A
          </span>
          {organization.name}
        </Link>
        <Link to="/">{t('administratorSignIn')}</Link>
      </header>
      <nav className="public-site-nav" aria-label={t('websiteNavigation')}>
        <ul>
          {result.data.navigation.map((item) => (
            <li key={`${item.href}:${item.label}`}>
              <a href={item.href}>{item.label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="public-site-main" id="main-content" tabIndex={-1}>
        <p>{t('newsTitle')}</p>
        <h1>{post.title}</h1>
        {publishedDate ? (
          <time dateTime={post.publishedAt ?? undefined}>{publishedDate}</time>
        ) : null}
        {post.excerpt ? <p>{post.excerpt}</p> : null}
        <p>{post.bodyText}</p>
        <p>
          <Link to={`/site/${organization.slug}/news`}>
            {t('newsBackToList')}
          </Link>
        </p>
      </main>
      <footer className="public-site-footer">
        <strong>{organization.name}</strong>
        <nav aria-label={t('websiteFooterNavigation')}>
          {result.data.footerNavigation.map((item) => (
            <a href={item.href} key={`${item.href}:${item.label}`}>
              {item.label}
            </a>
          ))}
        </nav>
        <Link to="/legal/accessibility">{t('accessibilityStatement')}</Link>
      </footer>
    </div>
  );
}

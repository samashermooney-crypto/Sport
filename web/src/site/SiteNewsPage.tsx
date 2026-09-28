import { websitePublicNewsSchema } from '@shared/schemas/website';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { apiGet } from '../api/client';

export function SiteNewsPage(): React.JSX.Element {
  const { t } = useTranslation('site');
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const result = useQuery({
    queryKey: ['public-site-news', orgSlug],
    queryFn: () =>
      apiGet(
        `/website/public/${String(orgSlug)}/news`,
        websitePublicNewsSchema,
      ),
    enabled: Boolean(orgSlug),
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
    const title = `${t('newsTitle')} · ${result.data.organization.name}`;
    const descriptionText = t('newsDescription', {
      organizationName: result.data.organization.name,
    });
    document.title = title;
    let description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (!description) {
      description = document.createElement('meta');
      description.name = 'description';
      document.head.append(description);
    }
    description.content = descriptionText;
    let ogTitle = document.querySelector<HTMLMetaElement>(
      'meta[property="og:title"]',
    );
    if (!ogTitle) {
      ogTitle = document.createElement('meta');
      ogTitle.setAttribute('property', 'og:title');
      document.head.append(ogTitle);
    }
    ogTitle.content = title;
    let ogDescription = document.querySelector<HTMLMetaElement>(
      'meta[property="og:description"]',
    );
    if (!ogDescription) {
      ogDescription = document.createElement('meta');
      ogDescription.setAttribute('property', 'og:description');
      document.head.append(ogDescription);
    }
    ogDescription.content = descriptionText;
    let canonical = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = `${window.location.origin}/site/${result.data.organization.slug}/news`;
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (result.data.robotsPolicy === 'noindex') {
      if (!robots) {
        robots = document.createElement('meta');
        robots.name = 'robots';
        document.head.append(robots);
      }
      robots.content = 'noindex,nofollow';
    } else if (robots) {
      robots.remove();
    }
  }, [result.data, t]);

  if (result.isPending)
    return (
      <main className="public-site-main" role="status">
        {t('loadingWebsite')}
      </main>
    );
  if (result.isError)
    return (
      <main className="public-site-main" role="alert">
        <h1>{t('websitePageUnavailable')}</h1>
        <p>{t('websitePageUnavailableDescription')}</p>
      </main>
    );

  const site = result.data;
  return (
    <div
      className="public-site"
      style={
        {
          '--site-primary': site.theme.primary,
          '--site-secondary': site.theme.secondary,
        } as React.CSSProperties
      }
    >
      <header className="public-site-header">
        <Link
          className="public-site-brand"
          to={`/site/${site.organization.slug}`}
        >
          <span className="public-site-mark" aria-hidden="true">
            A
          </span>
          {site.organization.name}
        </Link>
        <Link to="/">{t('administratorSignIn')}</Link>
      </header>
      <nav className="public-site-nav" aria-label={t('websiteNavigation')}>
        <ul>
          {site.navigation.map((item) => (
            <li key={`${item.href}:${item.label}`}>
              <a href={item.href}>{item.label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="public-site-main">
        <h1>{t('newsTitle')}</h1>
        {site.posts.length === 0 ? (
          <p>{t('noNewsPosts')}</p>
        ) : (
          <div className="public-site-news-list">
            {site.posts.map((post) => (
              <article key={post.slug}>
                <h2>{post.title}</h2>
                {post.publishedAt ? (
                  <time dateTime={post.publishedAt}>
                    {new Intl.DateTimeFormat(site.organization.locale, {
                      dateStyle: 'long',
                      timeZone: 'UTC',
                    }).format(new Date(post.publishedAt))}
                  </time>
                ) : null}
                {post.excerpt ? <p>{post.excerpt}</p> : null}
                <p>{post.bodyText}</p>
              </article>
            ))}
          </div>
        )}
      </main>
      <footer className="public-site-footer">
        <strong>{site.organization.name}</strong>
        <nav aria-label={t('websiteFooterNavigation')}>
          {site.footerNavigation.map((item) => (
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

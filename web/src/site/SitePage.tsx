import { websitePublicPageSchema } from '@shared/schemas/website';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';

import { apiGet } from '../api/client';

export function SitePage(): React.JSX.Element {
  const params = useParams();
  const orgSlug = params.orgSlug;
  const pageSlug = params['*'];
  const slug = pageSlug ?? 'home';
  const result = useQuery({
    queryKey: ['public-site', orgSlug, slug],
    queryFn: () =>
      apiGet(
        `/website/public/${String(orgSlug)}/pages/${slug}`,
        websitePublicPageSchema,
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
    document.title =
      result.data.page.seo.title ||
      `${result.data.page.title} · ${result.data.organization.name}`;
    let description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (!description) {
      description = document.createElement('meta');
      description.name = 'description';
      document.head.append(description);
    }
    description.content = result.data.page.seo.description;
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
  }, [result.data]);

  if (result.isPending)
    return (
      <main className="public-site-main" role="status">
        Loading website…
      </main>
    );
  if (result.isError)
    return (
      <main className="public-site-main" role="alert">
        <h1>Website page unavailable</h1>
        <p>This page is not published or could not be loaded.</p>
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
        <Link to="/">Administrator sign in</Link>
      </header>
      <nav className="public-site-nav" aria-label="Website navigation">
        <ul>
          {site.navigation.map((item) => (
            <li key={item.slug}>
              <Link
                to={
                  item.slug === 'home'
                    ? `/site/${site.organization.slug}`
                    : `/site/${site.organization.slug}/${item.slug}`
                }
              >
                {item.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="public-site-main">
        <h1>{site.page.title}</h1>
        {site.page.blocks.map((block, index) => {
          if (block.type === 'heading') {
            return block.level === 2 ? (
              <h2 key={index}>{block.text}</h2>
            ) : (
              <h3 key={index}>{block.text}</h3>
            );
          }
          if (block.type === 'link')
            return (
              <p key={index}>
                <a href={block.href}>{block.label}</a>
              </p>
            );
          return <p key={index}>{block.text}</p>;
        })}
      </main>
      <footer className="public-site-footer">
        <strong>{site.organization.name}</strong>
      </footer>
    </div>
  );
}

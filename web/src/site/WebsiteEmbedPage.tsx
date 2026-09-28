import { websitePublicEmbedSchema } from '@shared/schemas/website';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';

import { apiGet } from '../api/client';
import { Card } from '../ui/primitives';

export function WebsiteEmbedPage(): React.JSX.Element {
  const { orgSlug = '', publicKey = '' } = useParams();
  const embed = useQuery({
    queryKey: ['public-website-embed', orgSlug, publicKey],
    queryFn: () =>
      apiGet(
        `/website/public/${encodeURIComponent(orgSlug)}/embeds/${encodeURIComponent(publicKey)}`,
        websitePublicEmbedSchema,
      ),
    enabled: Boolean(orgSlug && publicKey),
  });

  useEffect(() => {
    const ownedStylesheet = document.querySelector<HTMLLinkElement>(
      'link[data-athlentry-site-style="true"]',
    );
    if (ownedStylesheet) return;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/site.css';
    stylesheet.dataset.athlentrySiteStyle = 'true';
    document.head.append(stylesheet);
  }, []);

  if (embed.isPending)
    return (
      <main className="website-embed" role="status">
        Loading organization widget…
      </main>
    );
  if (embed.isError)
    return (
      <main className="website-embed" role="alert">
        This organization widget is unavailable.
      </main>
    );

  const data = embed.data;
  const title = 'title' in data.config ? data.config.title : data.config.label;
  return (
    <main className="public-site-main public-site-embed website-embed">
      <Card>
        <header className="website-embed-heading">
          <p>{data.organization.name}</p>
          <h1>{title}</h1>
        </header>
        {data.items.length ? (
          <ul className="website-embed-items">
            {data.items.map((item) => (
              <li key={`${item.href}:${item.label}`}>
                <a href={item.href}>{item.label}</a>
                {item.detail && <p>{item.detail}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            {data.config.kind === 'standings'
              ? 'Standings have not been published yet.'
              : 'There is nothing to show right now.'}
          </p>
        )}
        {data.config.kind === 'registration_button' && data.program && (
          <p className="website-embed-registration">
            <Link to={data.items[0]?.href ?? `/site/${data.organization.slug}`}>
              {data.config.label}
            </Link>
          </p>
        )}
      </Card>
    </main>
  );
}

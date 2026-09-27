import { useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet } from '../../api/client';

import './public-sponsors.css';

const uuid = z.uuid();
const sponsorsSchema = z.strictObject({
  sponsors: z.array(
    z.strictObject({
      id: uuid,
      name: z.string(),
      tier: z.string(),
      websiteUrl: z.url().nullable(),
      logoFileId: uuid.nullable(),
    }),
  ),
});
type Sponsor = z.output<typeof sponsorsSchema>['sponsors'][number];

export function PublicSponsors({
  orgSlug,
  surface,
  targetId,
}: {
  orgSlug: string;
  surface: 'website_home' | 'program_page' | 'team_page' | 'email_footer';
  targetId?: string;
}): React.JSX.Element | null {
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      surface,
      ...(targetId ? { targetId } : {}),
    });
    void apiGet(
      `/sponsors/public/orgs/${encodeURIComponent(orgSlug)}/sponsors?${query.toString()}`,
      sponsorsSchema,
    )
      .then((result) => {
        if (active) setSponsors(result.sponsors);
      })
      .catch(() => {
        if (active) setSponsors([]);
      });
    return () => {
      active = false;
    };
  }, [orgSlug, surface, targetId]);
  if (!sponsors.length) return null;
  return (
    <section aria-label="Our sponsors" className="public-sponsors">
      <h2>Our sponsors</h2>
      <ul>
        {sponsors.map((sponsor) => (
          <li key={sponsor.id}>
            {sponsor.websiteUrl ? (
              <a href={sponsor.websiteUrl} rel="noopener noreferrer">
                {sponsor.name}
              </a>
            ) : (
              <span>{sponsor.name}</span>
            )}
            <small>{sponsor.tier}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

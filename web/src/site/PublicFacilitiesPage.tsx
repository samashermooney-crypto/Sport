import { websitePublicFacilitiesSchema } from '@shared/schemas/website';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { apiGet } from '../api/client';

import '../console/schedule/schedule.css';

export function PublicSiteFacilitiesPage(): React.JSX.Element {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const facilities = useQuery({
    queryKey: ['public-site-facilities', orgSlug],
    queryFn: () =>
      apiGet(
        `/website/public/${encodeURIComponent(String(orgSlug))}/facilities`,
        websitePublicFacilitiesSchema,
      ),
    enabled: Boolean(orgSlug),
  });

  if (facilities.isPending)
    return (
      <main className="schedule-page" role="status" aria-busy="true">
        <p>Loading public facilities…</p>
      </main>
    );
  if (facilities.isError)
    return (
      <main className="schedule-page">
        <p role="alert">Public facilities could not be loaded.</p>
      </main>
    );

  const locale = facilities.data.organization.locale;
  const isSpanish = locale === 'es';
  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">
            {isSpanish ? 'Ubicaciones' : 'Locations'}
          </p>
          <h1>{isSpanish ? 'Instalaciones' : 'Facilities'}</h1>
          <p>{facilities.data.organization.name}</p>
        </div>
      </header>
      <section className="schedule-card" aria-labelledby="public-facilities">
        <h2 id="public-facilities">
          {isSpanish ? 'Instalaciones públicas' : 'Public facilities'}
        </h2>
        {facilities.data.facilities.length ? (
          <ul className="schedule-run-list">
            {facilities.data.facilities.map((facility) => {
              const address = Object.values(facility.address ?? {})
                .filter((value) => value.trim().length > 0)
                .join(', ');
              return (
                <li className="schedule-run" key={facility.id}>
                  <div>
                    <Link
                      to={`/site/${facilities.data.organization.slug}/facilities/${encodeURIComponent(facility.id)}`}
                    >
                      <strong>{facility.name}</strong>
                    </Link>
                    {address ? <p>{address}</p> : null}
                  </div>
                  {facility.mapUrl ? (
                    <a
                      href={facility.mapUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {isSpanish ? 'Cómo llegar' : 'Directions'}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>
            {isSpanish
              ? 'No hay instalaciones públicas disponibles.'
              : 'There are no public facilities listed.'}
          </p>
        )}
      </section>
    </main>
  );
}

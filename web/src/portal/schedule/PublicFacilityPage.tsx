import { useEffect, useState } from 'react';

import { Badge } from '../../ui';

import '../../console/schedule/schedule.css';

type FacilityPageData = {
  facility: {
    name: string;
    address: Record<string, unknown> | null;
    timezone: string | null;
    parking_notes: string | null;
    map_url: string | null;
    layout_image_file_id: string | null;
  };
  spaces: Array<{ id: string; name: string; kind: string }>;
  events: Array<{
    id: string;
    title: string;
    kind: string;
    starts_at: string;
    ends_at: string;
    timezone: string;
    space_id: string | null;
    status: string;
  }>;
  closures: Array<{
    reason: string;
    message: string | null;
    starts_at: string;
    ends_at: string;
  }>;
  organizationTimezone: string;
};

export function PublicFacilityPage({
  slug,
  facilityId,
}: {
  slug: string;
  facilityId: string;
}): React.JSX.Element {
  const [data, setData] = useState<FacilityPageData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void fetch(
      `/api/v1/scheduling/public/orgs/${encodeURIComponent(slug)}/facilities/${encodeURIComponent(facilityId)}`,
    )
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as
          FacilityPageData | { message?: unknown } | null;
        if (!response.ok)
          throw new Error(
            result && 'message' in result && typeof result.message === 'string'
              ? result.message
              : `Facility page unavailable (${String(response.status)}).`,
          );
        if (active) setData(result as FacilityPageData);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Facility page could not be loaded.',
          );
      });
    return () => {
      active = false;
    };
  }, [facilityId, slug]);

  if (error)
    return (
      <main className="schedule-page">
        <p role="alert">{error}</p>
      </main>
    );
  if (!data)
    return (
      <main className="schedule-page" aria-busy="true">
        <p>Loading facility information…</p>
      </main>
    );

  const address = Object.values(data.facility.address ?? {}).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Facility</p>
          <h1>{data.facility.name}</h1>
          <p>{address.join(', ') || 'Address details are not available.'}</p>
        </div>
        {data.facility.map_url && (
          <a href={data.facility.map_url} target="_blank" rel="noreferrer">
            Directions
          </a>
        )}
      </header>
      {!!data.closures.length && (
        <section className="schedule-card" aria-label="Facility closures">
          <h2>Closure notices</h2>
          {data.closures.map((closure, index) => (
            <p
              className="schedule-notice schedule-notice--error"
              key={`${closure.starts_at}-${String(index)}`}
            >
              <strong>{closure.reason}</strong>
              {closure.message ? ` · ${closure.message}` : ''} ·{' '}
              {new Date(closure.starts_at).toLocaleString()} –{' '}
              {new Date(closure.ends_at).toLocaleString()}
            </p>
          ))}
        </section>
      )}
      <section className="schedule-card" aria-labelledby="facility-spaces">
        <h2 id="facility-spaces">Spaces</h2>
        {data.spaces.length ? (
          <ul className="schedule-run-list">
            {data.spaces.map((space) => (
              <li className="schedule-run" key={space.id}>
                <strong>{space.name}</strong> · {space.kind}
              </li>
            ))}
          </ul>
        ) : (
          <p>No public spaces are listed.</p>
        )}
        {data.facility.parking_notes && (
          <p>
            <strong>Parking:</strong> {data.facility.parking_notes}
          </p>
        )}
      </section>
      <section className="schedule-card" aria-labelledby="facility-events">
        <h2 id="facility-events">Upcoming public events</h2>
        {data.events.length ? (
          <div className="table-scroll">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>When</th>
                  <th>Space</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <strong>{event.title}</strong>
                      <small>{event.kind}</small>
                    </td>
                    <td>
                      <time dateTime={event.starts_at}>
                        {new Date(event.starts_at).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                      <small>
                        {event.timezone || data.organizationTimezone}
                      </small>
                    </td>
                    <td>
                      {data.spaces.find((space) => space.id === event.space_id)
                        ?.name ?? 'Facility'}
                    </td>
                    <td>
                      <Badge
                        tone={event.status === 'scheduled' ? 'ok' : 'warn'}
                      >
                        {event.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No upcoming public events.</p>
        )}
      </section>
    </main>
  );
}

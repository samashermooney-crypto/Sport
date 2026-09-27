import { useCallback, useEffect, useState } from 'react';

import { Badge, Button } from '../../ui';

import '../../console/schedule/schedule.css';

type FamilyEvent = {
  id: string;
  title: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  locationText: string | null;
  spaceId: string | null;
};
type Rsvp = 'yes' | 'no' | 'maybe' | 'none';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const value =
    response.status === 204
      ? null
      : ((await response.json().catch(() => null)) as unknown);
  if (!response.ok) {
    const message =
      value && typeof value === 'object' && 'message' in value
        ? String(value.message)
        : `Request failed (${String(response.status)}).`;
    throw new Error(message);
  }
  return value as T;
}

export function FamilySchedule({
  orgId,
  teamSeasonId,
  personId,
}: {
  orgId: string;
  teamSeasonId: string;
  personId: string;
}): React.JSX.Element {
  const [items, setItems] = useState<FamilyEvent[]>([]);
  const [rsvps, setRsvps] = useState<Record<string, Rsvp>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 120 * 86_400_000).toISOString();
    const query = new URLSearchParams({ from, to, teamSeasonId });
    try {
      setItems(
        (
          await request<{ items: FamilyEvent[] }>(
            `/api/v1/scheduling/orgs/${encodeURIComponent(orgId)}/events?${query}`,
          )
        ).items,
      );
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The family schedule could not be loaded.',
      );
    }
  }, [orgId, teamSeasonId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function updateRsvp(eventId: string, rsvp: Rsvp): Promise<void> {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      await request(
        `/api/v1/attendance/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/people/${encodeURIComponent(personId)}/rsvp`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rsvp }),
        },
      );
      setRsvps({ ...rsvps, [eventId]: rsvp });
      setMessage('Your RSVP is saved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Your RSVP could not be saved.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Family portal</p>
          <h1>Team schedule</h1>
          <p>Upcoming games, practices, and event updates.</p>
        </div>
        <Button secondary onClick={() => void load()}>
          Refresh schedule
        </Button>
      </header>
      {(error || message) && (
        <div
          className={`schedule-notice${error ? ' schedule-notice--error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error || message}
        </div>
      )}
      <section
        className="schedule-card"
        aria-labelledby="family-schedule-events"
      >
        <h2 id="family-schedule-events">Upcoming events</h2>
        {items.length ? (
          <div className="table-scroll">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>When</th>
                  <th>Location</th>
                  <th>RSVP</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.title}</strong>
                      <small>{item.kind}</small>
                      {item.status !== 'scheduled' && (
                        <Badge tone="warn">{item.status}</Badge>
                      )}
                    </td>
                    <td>
                      <time dateTime={item.startsAt}>
                        {new Date(item.startsAt).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                      <small>{item.timezone}</small>
                    </td>
                    <td>
                      {item.locationText ??
                        (item.spaceId ? 'Facility space' : 'Details to come')}
                    </td>
                    <td>
                      <div className="schedule-actions">
                        {(['yes', 'no', 'maybe'] as const).map((choice) => (
                          <Button
                            key={choice}
                            secondary={rsvps[item.id] !== choice}
                            disabled={loading}
                            aria-pressed={rsvps[item.id] === choice}
                            onClick={() => void updateRsvp(item.id, choice)}
                          >
                            {choice === 'yes'
                              ? 'Going'
                              : choice === 'no'
                                ? 'Can’t go'
                                : 'Maybe'}
                          </Button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !error && <p>No published events are scheduled for this team.</p>
        )}
      </section>
      <FamilySeasonSurveys orgId={orgId} />
    </main>
  );
}

type FamilySurvey = {
  id: string;
  title: string;
  program_id: string;
  locale: 'en' | 'es';
};

function FamilySeasonSurveys({ orgId }: { orgId: string }): React.JSX.Element {
  const [surveys, setSurveys] = useState<FamilySurvey[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await request<{ items: FamilySurvey[] }>(
        `/api/v1/standings/orgs/${encodeURIComponent(orgId)}/season-surveys`,
      );
      setSurveys(result.items);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Family surveys could not be loaded.',
      );
    }
  }, [orgId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(
    event: React.SubmitEvent<HTMLFormElement>,
    surveyId: string,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const responseText = form.get('responseText');
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request(
        `/api/v1/standings/orgs/${encodeURIComponent(orgId)}/season-surveys/${encodeURIComponent(surveyId)}/responses`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nps: Number(form.get('nps')),
            responseText:
              typeof responseText === 'string' ? responseText.trim() : '',
          }),
        },
      );
      setMessage('Thank you. Your response is saved.');
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Response could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="schedule-card" aria-labelledby="family-surveys-heading">
      <h2 id="family-surveys-heading">Season feedback</h2>
      {(error || message) && (
        <p role={error ? 'alert' : 'status'}>{error || message}</p>
      )}
      {surveys.map((survey) => (
        <form
          className="schedule-form"
          key={survey.id}
          onSubmit={(event) => void submit(event, survey.id)}
        >
          <h3>{survey.title}</h3>
          <label>
            {survey.locale === 'es'
              ? '¿Qué probabilidad hay de que recomiende este programa? (0–10)'
              : 'How likely are you to recommend this program? (0–10)'}
            <select name="nps" required defaultValue="10">
              {Array.from({ length: 11 }, (_, value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            {survey.locale === 'es' ? 'Comentarios' : 'Comments'}
            <textarea name="responseText" rows={4} maxLength={4000} />
          </label>
          <Button type="submit" disabled={busy}>
            {survey.locale === 'es' ? 'Enviar comentarios' : 'Submit feedback'}
          </Button>
        </form>
      ))}
      {!surveys.length && !error && <p>No open season surveys right now.</p>}
    </section>
  );
}

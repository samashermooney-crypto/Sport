import { useEffect, useState } from 'react';

import { Badge, Button } from '../../ui';

import '../../console/schedule/schedule.css';

type StandingRow = {
  teamId: string;
  rank: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  scored: number;
  allowed: number;
  differential: number;
  points: number;
};

type StandingsResponse = {
  rows: StandingRow[];
  teamNames: Record<string, string>;
  computed_at?: string | null;
  computedAt?: string;
};

export function PublicStandingsPage({
  slug,
  scopeType,
  scopeId,
}: {
  slug: string;
  scopeType: 'program' | 'division';
  scopeId: string;
}): React.JSX.Element {
  const [data, setData] = useState<StandingsResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const routeScope = scopeType === 'program' ? 'programs' : 'divisions';
    void fetch(
      `/api/v1/standings/public/orgs/${encodeURIComponent(slug)}/${routeScope}/${encodeURIComponent(scopeId)}`,
    )
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as
          StandingsResponse | { message?: unknown } | null;
        if (!response.ok)
          throw new Error(
            result && 'message' in result && typeof result.message === 'string'
              ? result.message
              : `Standings unavailable (${String(response.status)}).`,
          );
        if (active) setData(result as StandingsResponse);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Standings could not be loaded.',
          );
      });
    return () => {
      active = false;
    };
  }, [scopeId, scopeType, slug]);

  if (error)
    return (
      <main className="schedule-page">
        <h1>Standings unavailable</h1>
        <p role="alert">{error}</p>
      </main>
    );
  if (!data)
    return (
      <main className="schedule-page" aria-busy="true">
        <h1>Loading standings…</h1>
      </main>
    );

  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Standings</p>
          <h1>
            {scopeType === 'program'
              ? 'Program standings'
              : 'Division standings'}
          </h1>
          <p>
            {(data.computedAt ?? data.computed_at)
              ? `Updated ${new Date(data.computedAt ?? data.computed_at ?? '').toLocaleString()}`
              : 'Current results'}
          </p>
        </div>
        <div className="schedule-print-controls">
          <Badge tone="ok">Public</Badge>
          <Button
            secondary
            onClick={() => {
              window.print();
            }}
          >
            Print standings / Save PDF
          </Button>
        </div>
      </header>
      <section className="schedule-card" aria-label="Standings table">
        <div className="table-scroll">
          <table className="ui-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Team</th>
                <th scope="col">Played</th>
                <th scope="col">W</th>
                <th scope="col">L</th>
                <th scope="col">T</th>
                <th scope="col">Points</th>
                <th scope="col">Scored</th>
                <th scope="col">Allowed</th>
                <th scope="col">Diff</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.teamId}>
                  <td>{row.rank}</td>
                  <th scope="row">
                    {data.teamNames[row.teamId] ?? row.teamId}
                  </th>
                  <td>{row.played}</td>
                  <td>{row.wins}</td>
                  <td>{row.losses}</td>
                  <td>{row.ties}</td>
                  <td>{row.points}</td>
                  <td>{row.scored}</td>
                  <td>{row.allowed}</td>
                  <td>{row.differential}</td>
                </tr>
              ))}
              {!data.rows.length && (
                <tr>
                  <td colSpan={10}>No standings entries yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

import { Temporal } from '@js-temporal/polyfill';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { Badge, Button } from '../../ui';

import '../../console/schedule/schedule.css';

const slotSchema = z.looseObject({
  entrantId: z.string().nullable().optional(),
  sourceMatchId: z.string().nullable().optional(),
  sourceOutcome: z.enum(['winner', 'loser']).nullable().optional(),
  winnerId: z.string().nullable().optional(),
  finalized: z.boolean().optional(),
  poolName: z.string().nullable().optional(),
});
type Slot = z.infer<typeof slotSchema>;
type Entry = {
  seed: number | null;
  team_season_id: string | null;
  external_team_id: string | null;
  team_display_name: string | null;
  team_name: string | null;
  external_team_name: string | null;
};
type Match = {
  id: string;
  round: number;
  position: number;
  contest_id: string | null;
  participant_a: unknown;
  participant_b: unknown;
};
type PublicReservation = {
  slot_type: 'pool' | 'bracket';
  round_index: number;
  position: number;
  title: string;
  starts_at: string;
  timezone: string;
};
type TournamentData = {
  bracket: { name: string; type: string; status: string; size: number };
  entries: Entry[];
  matches: Match[];
  reservations: PublicReservation[];
};

function slot(value: unknown): Slot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const parsed = slotSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function PublicTournamentPage({
  slug,
  bracketId,
}: {
  slug: string;
  bracketId: string;
}): React.JSX.Element {
  const [data, setData] = useState<TournamentData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void fetch(
      `/api/v1/tournaments/public/orgs/${encodeURIComponent(slug)}/brackets/${encodeURIComponent(bracketId)}`,
    )
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as
          TournamentData | { message?: unknown } | null;
        if (!response.ok)
          throw new Error(
            result && 'message' in result && typeof result.message === 'string'
              ? result.message
              : `Tournament page unavailable (${String(response.status)}).`,
          );
        if (active) setData(result as TournamentData);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Tournament information could not be loaded.',
          );
      });
    return () => {
      active = false;
    };
  }, [bracketId, slug]);

  const teamNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of data?.entries ?? []) {
      const id = entry.team_season_id ?? entry.external_team_id;
      if (id)
        names.set(
          id,
          entry.team_display_name ||
            entry.team_name ||
            entry.external_team_name ||
            shortId(id),
        );
    }
    return names;
  }, [data]);

  if (error)
    return (
      <main className="schedule-page">
        <p role="alert">{error}</p>
      </main>
    );
  if (!data)
    return (
      <main className="schedule-page" aria-busy="true">
        <p>Loading tournament…</p>
      </main>
    );

  const rounds = [...new Set(data.matches.map((match) => match.round))].sort(
    (a, b) => a - b,
  );
  const labelFor = (value: unknown, matchById: Map<string, Match>): string => {
    const participant = slot(value);
    if (participant.entrantId)
      return (
        teamNames.get(participant.entrantId) ?? shortId(participant.entrantId)
      );
    if (participant.sourceMatchId) {
      const source = matchById.get(participant.sourceMatchId);
      const side = participant.sourceOutcome === 'loser' ? 'Loser' : 'Winner';
      return `${side} of match ${String(source?.position ?? shortId(participant.sourceMatchId))}`;
    }
    return 'TBD';
  };
  const matchById = new Map(data.matches.map((match) => [match.id, match]));

  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Tournament</p>
          <h1>{data.bracket.name}</h1>
          <p>{data.bracket.type.replaceAll('_', ' ')}</p>
        </div>
        <div className="schedule-print-controls">
          <Badge tone={data.bracket.status === 'completed' ? 'ok' : 'pending'}>
            {data.bracket.status}
          </Badge>
          <Button
            secondary
            onClick={() => {
              window.print();
            }}
          >
            Print bracket / Save PDF
          </Button>
        </div>
      </header>
      {rounds.length ? (
        rounds.map((round) => (
          <section
            className="schedule-card"
            aria-labelledby={`tournament-round-${String(round)}`}
            key={round}
          >
            <h2 id={`tournament-round-${String(round)}`}>Round {round}</h2>
            <div className="table-scroll">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th scope="col">Match</th>
                    <th scope="col">Home</th>
                    <th scope="col">Away</th>
                    <th scope="col">Winner</th>
                  </tr>
                </thead>
                <tbody>
                  {data.matches
                    .filter((match) => match.round === round)
                    .sort((a, b) => a.position - b.position)
                    .map((match) => {
                      const home = slot(match.participant_a);
                      const away = slot(match.participant_b);
                      const winnerId = home.winnerId ?? away.winnerId;
                      const pool = home.poolName ?? away.poolName;
                      return (
                        <tr key={match.id}>
                          <th scope="row">
                            {match.position}
                            {pool && <small>{pool}</small>}
                          </th>
                          <td>{labelFor(match.participant_a, matchById)}</td>
                          <td>{labelFor(match.participant_b, matchById)}</td>
                          <td>
                            {winnerId
                              ? (teamNames.get(winnerId) ?? shortId(winnerId))
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      ) : (
        <section className="schedule-card">
          <h2>Matches</h2>
          <p>Matchups have not been generated yet.</p>
        </section>
      )}
      {data.reservations.length > 0 && (
        <section className="schedule-card" aria-labelledby="tournament-slots">
          <h2 id="tournament-slots">Scheduled games</h2>
          <div className="table-scroll">
            <table className="ui-table">
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Round</th>
                  <th scope="col">Game</th>
                  <th scope="col">Matchup</th>
                  <th scope="col">Start</th>
                </tr>
              </thead>
              <tbody>
                {data.reservations.map((reservation, index) => (
                  <tr
                    key={`${reservation.slot_type}-${String(reservation.round_index)}-${String(reservation.position)}-${String(index)}`}
                  >
                    <td>{reservation.slot_type}</td>
                    <td>{reservation.round_index}</td>
                    <td>{reservation.position}</td>
                    <td>{reservation.title}</td>
                    <td>
                      {Temporal.Instant.from(reservation.starts_at)
                        .toZonedDateTimeISO(reservation.timezone)
                        .toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

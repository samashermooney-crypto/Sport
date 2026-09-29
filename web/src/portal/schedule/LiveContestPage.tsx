import { useEffect, useState } from 'react';

import { Badge } from '../../ui';

import '../../console/schedule/schedule.css';

type PublicContestSnapshot = {
  contest: {
    id: string;
    status: string;
    finalizedAt: string | null;
    version: number;
  };
  participants: Array<{
    id: string;
    side: 'home' | 'away' | 'none';
    teamSeasonId: string | null;
  }>;
  results: Array<{
    side: 'home' | 'away' | 'none';
    score: number | string | null;
    place: number | null;
    outcome: string | null;
    status: string | null;
    scoreDetail: unknown;
  }>;
};

export function LiveContestPage({
  slug,
  contestId,
}: {
  slug: string;
  contestId: string;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<PublicContestSnapshot | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    let stream: EventSource | undefined;
    const base = `/api/v1/contests/public/orgs/${encodeURIComponent(slug)}/contests/${encodeURIComponent(contestId)}/live`;

    void fetch(base)
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as
          PublicContestSnapshot | { message?: unknown } | null;
        if (!response.ok)
          throw new Error(
            result && 'message' in result && typeof result.message === 'string'
              ? result.message
              : `Live contest unavailable (${String(response.status)}).`,
          );
        if (!active) return;
        setSnapshot(result as PublicContestSnapshot);
        stream = new EventSource(`${base}/events`);
        stream.onopen = () => {
          if (active) setConnected(true);
        };
        stream.onerror = () => {
          if (active) setConnected(false);
        };
        stream.addEventListener('score', (event) => {
          if (!active) return;
          const update = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as PublicContestSnapshot;
          setSnapshot(update);
          setConnected(true);
          if (update.contest.status === 'final') stream?.close();
        });
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Live contest could not be loaded.',
          );
      });

    return () => {
      active = false;
      stream?.close();
    };
  }, [contestId, slug]);

  if (error)
    return (
      <main className="schedule-page">
        <h1>Live score unavailable</h1>
        <p role="alert">{error}</p>
      </main>
    );
  if (!snapshot)
    return (
      <main className="schedule-page" aria-busy="true">
        <h1>Loading live score…</h1>
      </main>
    );

  const scores = new Map<'home' | 'away', number>();
  for (const result of snapshot.results) {
    if (result.side === 'home' || result.side === 'away') {
      const score = result.score === null ? Number.NaN : Number(result.score);
      if (Number.isFinite(score)) scores.set(result.side, score);
    }
  }

  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Public contest</p>
          <h1>Live score</h1>
          <p>Score updates appear here as the official result is entered.</p>
        </div>
        <Badge tone={snapshot.contest.status === 'final' ? 'ok' : 'pending'}>
          {snapshot.contest.status}
        </Badge>
      </header>
      <p role="status" aria-live="polite">
        {connected
          ? 'Live score updates connected.'
          : 'Reconnecting to live score updates…'}
      </p>
      <section
        className="schedule-card"
        aria-label="Live scoreboard"
        aria-live="polite"
      >
        <h2>Scoreboard</h2>
        <div className="table-scroll">
          <table className="ui-table">
            <thead>
              <tr>
                <th scope="col">Side</th>
                <th scope="col">Score</th>
              </tr>
            </thead>
            <tbody>
              {(['home', 'away'] as const).map((side) => (
                <tr key={side}>
                  <th scope="row">
                    {side === 'home' ? 'Home' : 'Away'}
                    {!snapshot.participants.some(
                      (participant) => participant.side === side,
                    )
                      ? ' · no entrant'
                      : ''}
                  </th>
                  <td>{scores.get(side)?.toString() ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

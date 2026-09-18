import type { Activity } from "./types";

export type GameResult = Pick<
  Activity,
  | "type"
  | "state"
  | "home_score"
  | "away_score"
  | "overtime"
  | "forfeit"
  | "match_scores"
>;

export function EventResult({ event }: { event: GameResult }) {
  if (event.type !== "Game" || event.state !== "Completed") return <>—</>;
  const games = event.match_scores || [];
  const score = games.length
    ? `${games.filter((g) => g.home > g.away).length} – ${games.filter((g) => g.away > g.home).length} games`
    : event.home_score !== null && event.away_score !== null
      ? `${event.home_score} – ${event.away_score}`
      : "";
  const forfeit =
    event.forfeit && event.forfeit !== "None"
      ? event.forfeit === "Both"
        ? "Both teams forfeited"
        : `${event.forfeit} team forfeited`
      : "";
  return (
    <>
      <span>
        {score || (forfeit ? "Forfeit" : "—")}
        {event.overtime && !forfeit ? " (OT)" : ""}
      </span>
      {forfeit && <small className="cell-sub">{forfeit}</small>}
      {!!games.length && (
        <>
          <small className="cell-sub">
            {games.map((g) => `${g.home}–${g.away}`).join(", ")}
          </small>
          <small className="cell-sub">
            {games.reduce((n, g) => n + g.home, 0)} –{" "}
            {games.reduce((n, g) => n + g.away, 0)} points
          </small>
        </>
      )}
    </>
  );
}

import type { Activity } from "./types";

export type ScheduleFilters = {
  teams: string[];
  staff: string[];
  types: string[];
  states: string[];
  from: string;
  to: string;
};
export const emptyScheduleFilters = (): ScheduleFilters => ({
  teams: [],
  staff: [],
  types: [],
  states: [],
  from: "",
  to: "",
});
export const scheduleStates = [
  "Canceled",
  "Forfeit away",
  "Forfeit both",
  "Forfeit home",
  "Played regular time",
  "Played overtime",
  "Rescheduled",
  "Scheduled",
  "Postponed",
];
export function activityState(event: Activity): string {
  if (event.state !== "Completed") return event.state;
  if (event.forfeit && event.forfeit !== "None")
    return `Forfeit ${event.forfeit.toLowerCase()}`;
  return event.overtime ? "Played overtime" : "Played regular time";
}
export function matchesScheduleFilters(
  event: Activity,
  filters: ScheduleFilters,
  staff: ScheduleStaff[] = [],
) {
  if (
    filters.teams.length &&
    !filters.teams.some(
      (id) => id === event.home_team_id || id === event.away_team_id,
    )
  )
    return false;
  if (
    filters.staff.length &&
    !staff.some(
      (person) =>
        filters.staff.includes(person.id) &&
        person.team_ids.some(
          (id) => id === event.home_team_id || id === event.away_team_id,
        ),
    )
  )
    return false;
  if (filters.types.length && !filters.types.includes(event.type)) return false;
  if (filters.states.length && !filters.states.includes(activityState(event)))
    return false;
  if (filters.from || filters.to) {
    const start = new Date(event.start_at);
    if (!Number.isFinite(start.getTime())) return false;
    const time = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
    if (filters.from && time < filters.from) return false;
    if (filters.to && time > filters.to) return false;
  }
  return true;
}
export type ScheduleStaff = { id: string; name: string; team_ids: string[] };

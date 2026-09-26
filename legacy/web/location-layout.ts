import type { Activity } from "./types";
/** Clip to the visible local day and keep minimum-height event cards in separate lanes. */
export function layoutLocationDay(
  events: Activity[],
  locationId: string,
  day: Date,
) {
  const endOfDay = new Date(day);
  endOfDay.setDate(endOfDay.getDate() + 1);
  const intervals = events
    .filter((event) => {
      const start = new Date(event.start_at),
        end = new Date(event.end_at);
      return (
        event.location_id === locationId &&
        start < endOfDay &&
        (event.end_at ? end > day && end > start : start >= day)
      );
    })
    .map((event) => {
      const start = new Date(event.start_at),
        end = new Date(event.end_at);
      const top = start < day ? 0 : start.getHours() * 60 + start.getMinutes();
      const bottom = !event.end_at
        ? top + 24
        : end >= endOfDay
          ? 1440
          : end.getHours() * 60 + end.getMinutes();
      // During a repeated DST hour, retain a visible, positive duration.
      const duration =
        bottom > top
          ? bottom - top
          : (end.getTime() - Math.max(start.getTime(), day.getTime())) / 60000;
      const height = Math.min(1440 - top, Math.max(24, duration));
      return { event, start: top, height, lane: 0 };
    })
    .sort(
      (a, b) =>
        a.start - b.start ||
        b.height - a.height ||
        a.event.id.localeCompare(b.event.id),
    );
  const lanes: number[] = [];
  for (const interval of intervals) {
    let lane = lanes.findIndex((end) => end <= interval.start);
    if (lane < 0) lane = lanes.length;
    interval.lane = lane;
    lanes[lane] = interval.start + interval.height;
  }
  return { intervals, laneCount: lanes.length };
}

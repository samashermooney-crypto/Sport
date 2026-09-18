export const scheduleDatePresets = [
  "Today",
  "Today & Tomorrow",
  "This Week",
  "Next Week",
  "This Month",
  "Next 6 Months",
  "Next 12 Months",
  "Unscheduled",
  "Custom Date Range",
] as const;
export type ScheduleDatePreset = (typeof scheduleDatePresets)[number];
export type ScheduleGrouping = "None" | "Week" | "Two Weeks" | "Month";
export const localDateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const day = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, count: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
const week = (date: Date, first: number) =>
  addDays(day(date), -((date.getDay() - first + 7) % 7));
function addMonths(date: Date, count: number) {
  const last = new Date(
    date.getFullYear(),
    date.getMonth() + count + 1,
    0,
  ).getDate();
  return new Date(
    date.getFullYear(),
    date.getMonth() + count,
    Math.min(date.getDate(), last),
  );
}
function parseDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T00:00:00");
  return Number.isFinite(date.getTime()) && localDateKey(date) === value
    ? date
    : null;
}
export function scheduleDateBounds(
  preset: ScheduleDatePreset,
  now: Date,
  weekStart: number,
  from: string,
  to: string,
): { start: Date; end: Date } | null {
  const today = day(now);
  switch (preset) {
    case "Today":
      return { start: today, end: addDays(today, 1) };
    case "Today & Tomorrow":
      return { start: today, end: addDays(today, 2) };
    case "This Week": {
      const start = week(today, weekStart);
      return { start, end: addDays(start, 7) };
    }
    case "Next Week": {
      const start = addDays(week(today, weekStart), 7);
      return { start, end: addDays(start, 7) };
    }
    case "This Month":
      return {
        start: new Date(today.getFullYear(), today.getMonth(), 1),
        end: new Date(today.getFullYear(), today.getMonth() + 1, 1),
      };
    case "Next 6 Months":
      return { start: today, end: addMonths(today, 6) };
    case "Next 12 Months":
      return { start: today, end: addMonths(today, 12) };
    case "Custom Date Range": {
      const start = parseDay(from),
        last = parseDay(to);
      return start && last && start <= last
        ? { start, end: addDays(last, 1) }
        : null;
    }
    case "Unscheduled":
      return null;
  }
}
export function matchesScheduleDate(
  startAt: string,
  preset: ScheduleDatePreset,
  bounds: { start: Date; end: Date } | null,
) {
  if (preset === "Unscheduled") return !startAt;
  const date = new Date(startAt);
  return !!bounds && date >= bounds.start && date < bounds.end;
}
export function scheduleDateGroup(
  startAt: string,
  grouping: Exclude<ScheduleGrouping, "None">,
  weekStart: number,
  anchor: Date,
) {
  const date = new Date(startAt);
  if (!Number.isFinite(date.getTime()))
    return { key: "unscheduled", label: "Unscheduled" };
  if (grouping === "Month") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    return {
      key: localDateKey(start),
      label: start.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }),
    };
  }
  let start = week(date, weekStart);
  const length = grouping === "Two Weeks" ? 14 : 7;
  if (length === 14) {
    const base = week(anchor, weekStart);
    const ordinal = (d: Date) =>
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
    start = addDays(
      base,
      Math.floor((ordinal(start) - ordinal(base)) / 14) * 14,
    );
  }
  const format = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  return {
    key: localDateKey(start),
    label: `${format(start)} – ${format(addDays(start, length - 1))}`,
  };
}

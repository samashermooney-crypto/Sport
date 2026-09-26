import { DomainError } from "./domain.mjs";

// CSV timestamps are wall-clock times in the organization's timezone, never
// the server's timezone. Return every matching instant so DST ambiguity is explicit.
export function scheduleImportInstant(date, time, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw new DomainError("Invalid schedule date or time.");
  const wall = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== `${date}T${time}`)
    throw new DomainError("Invalid schedule date or time.");
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  } catch {
    throw new DomainError("The organization timezone is invalid.");
  }
  const localEpoch = (instant) => {
    const p = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  // Sample both sides of nearby timezone transitions, including non-hour shifts.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = wall + hours * 3600000;
    offsets.add(localEpoch(probe) - probe);
  }
  const matches = [...offsets].map((offset) => wall - offset)
    .filter((instant) => localEpoch(instant) === wall).sort((a, b) => a - b);
  if (!matches.length)
    throw new DomainError(`${date} ${time} does not exist in ${timezone} because of a clock change. Choose a valid time.`);
  if (matches.length > 1)
    throw new DomainError(`${date} ${time} occurs twice in ${timezone} because of a clock change. Resolve this ambiguous activity time before importing.`);
  return new Date(matches[0]).toISOString();
}

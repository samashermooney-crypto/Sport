// An unknown end reserves its known start instant, without fabricating duration.
export function eventTimesOverlap(a, b) {
  const startA = Date.parse(a.start_at),
    startB = Date.parse(b.start_at);
  if (!a.end_at && !b.end_at) return startA === startB;
  if (!a.end_at) return startA >= startB && startA < Date.parse(b.end_at);
  if (!b.end_at) return startB >= startA && startB < Date.parse(a.end_at);
  return startA < Date.parse(b.end_at) && startB < Date.parse(a.end_at);
}

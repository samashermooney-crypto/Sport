import { z } from "zod";

export const tryoutScaleSchema = z.enum(["1-3", "1-5", "yes-no", "measurement"]);

// Null clears a score; missing scores must never become zeroes in results.
export function parseTryoutScore(scale, value) {
  tryoutScaleSchema.parse(scale);
  if (value === null) return null;
  if (scale === "yes-no") return z.boolean().parse(value);
  if (scale === "measurement") return z.number().finite().parse(value);
  return z.number().int().min(1).max(scale === "1-3" ? 3 : 5).parse(value);
}

// Attribute means are independent of the still-unverified overall rating formula.
// Callers provide one current value per evaluator, never historical revisions.
export function tryoutAttributeAverage(scale, values) {
  const scored = values.map(value => parseTryoutScore(scale, value))
    .filter(value => value !== null);
  if (!scored.length) return null;
  return scored.reduce((sum, value) => sum + Number(value), 0) / scored.length;
}

export function tryoutAttributeCanAffectRating(scale) {
  return tryoutScaleSchema.parse(scale) !== "measurement";
}

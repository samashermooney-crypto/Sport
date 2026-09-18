import { z } from "zod";
import { tryoutScaleSchema } from "./tryout-scoring.mjs";

const roundSchema = z.object({
  id: z.uuid(),
  start_at: z.iso.datetime({ offset: true }),
  end_at: z.iso.datetime({ offset: true }).nullable().default(null),
  location_id: z.uuid().nullable().default(null),
}).superRefine((round, context) => {
  if (round.end_at && Date.parse(round.end_at) <= Date.parse(round.start_at))
    context.addIssue({ code: "custom", path: ["end_at"], message: "End time must be after start time." });
});

const attributeSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1),
  scale: tryoutScaleSchema,
});

export const tryoutConfigSchema = z.object({
  program_id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  rounds: z.array(roundSchema).min(1).max(3),
  attributes: z.array(attributeSchema).min(1).max(10),
}).superRefine((config, context) => {
  for (const key of ["rounds", "attributes"]) {
    const ids = new Set();
    config[key].forEach((item, index) => {
      if (ids.has(item.id)) context.addIssue({ code: "custom", path: [key, index, "id"], message: "Each item must have a distinct ID." });
      ids.add(item.id);
    });
  }
});

export function parseTryoutConfig(input) {
  const config = tryoutConfigSchema.parse(input);
  config.rounds.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.id.localeCompare(b.id));
  return config;
}

// Describes affected data, but never deletes anything. Persistence must require
// confirmation against a current revision before applying destructive changes.
export function tryoutConfigImpact(previous, next) {
  const before = parseTryoutConfig(previous);
  const after = parseTryoutConfig(next);
  const programChanged = before.program_id !== after.program_id;
  const scorecardChanged = JSON.stringify(before.attributes) !== JSON.stringify(after.attributes);
  const remaining = new Set(after.rounds.map(round => round.id));
  return {
    reset_all_scores_and_checkins: programChanged || scorecardChanged,
    program_changed: programChanged,
    scorecard_changed: scorecardChanged,
    removed_round_ids: before.rounds.filter(round => !remaining.has(round.id)).map(round => round.id),
  };
}

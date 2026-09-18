import { z } from "zod";
const minimum = z.number().int().min(0).max(100000).default(0);
export const teamCompletionSchema = z.object({
  min_players: minimum,
  min_male: minimum,
  min_female: minimum,
  payment: z.enum(["None", "Half", "Full"]).default("None"),
});
export function evaluateTeamCompletion(input, facts) {
  const rules = teamCompletionSchema.parse(input || {});
  const reasons = [];
  for (const [key, label] of [
    ["players", "players"],
    ["male", "male players"],
    ["female", "female players"],
  ]) {
    const required = rules[`min_${key}`];
    if (facts[key] < required)
      reasons.push(`Requires ${required} ${label}; currently ${facts[key]}`);
  }
  const required_cents =
    rules.payment === "Full"
      ? facts.total_cents
      : rules.payment === "Half"
        ? Math.ceil(facts.total_cents / 2)
        : 0;
  if (facts.paid_cents < required_cents)
    reasons.push(
      `Team payments must reach ${rules.payment.toLowerCase()} of invoiced fees`,
    );
  return {
    status: reasons.length ? "Incomplete" : "Complete",
    reasons,
    required_cents,
    ...facts,
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseTryoutConfig, tryoutConfigImpact } from "./tryout-config.mjs";

const round = (start_at = "2026-10-20T14:00:00Z") => ({ id: randomUUID(), start_at });
const fixture = () => ({ program_id: randomUUID(), name: "Fall tryout", rounds: [round()], attributes: [{ id: randomUUID(), name: "Passing", scale: "1-5" }] });

test("tryout config enforces round/attribute limits, distinct identities and valid times", () => {
  const config = fixture();
  for (const change of [
    { rounds: [] }, { rounds: Array.from({length: 4}, () => round()) },
    { rounds: [config.rounds[0], config.rounds[0]] },
    { rounds: [{ ...round(), end_at: "2026-10-20T13:00:00Z" }] },
    { attributes: [] }, { attributes: [config.attributes[0], config.attributes[0]] },
    { attributes: Array.from({length: 11}, () => ({ ...config.attributes[0], id: randomUUID() })) },
    { name: " ".repeat(10) }, { name: "x".repeat(101) },
  ]) assert.throws(() => parseTryoutConfig({ ...config, ...change }));
  const early = round("2026-10-19T14:00:00Z");
  config.rounds.push(early);
  assert.equal(parseTryoutConfig(config).rounds[0].id, early.id);
  assert.notEqual(config.rounds[0].id, early.id, "input order is unchanged");
});

test("tryout edit impact preserves data for schedule edits and distinguishes round removal from scorecard resets", () => {
  const before = fixture();
  before.rounds.push(round("2026-10-21T14:00:00Z"));
  const after = structuredClone(before);
  after.name = "Renamed";
  after.rounds[0].start_at = "2026-10-22T14:00:00Z";
  after.rounds[0].location_id = randomUUID();
  assert.equal(tryoutConfigImpact(before, after).reset_all_scores_and_checkins, false);
  after.rounds.pop();
  assert.deepEqual(tryoutConfigImpact(before, after).removed_round_ids, [before.rounds[1].id]);
  assert.equal(tryoutConfigImpact(before, after).reset_all_scores_and_checkins, false);
  after.attributes[0].scale = "1-3";
  assert.equal(tryoutConfigImpact(before, after).reset_all_scores_and_checkins, true);
  after.attributes = before.attributes;
  after.program_id = randomUUID();
  assert.equal(tryoutConfigImpact(before, after).program_changed, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTeamCompletion } from "./team-completion.mjs";
import { teamRegistrationState } from "./team-registration-state.mjs";
import { openDb } from "./db.mjs";
import { saveProgram, createTeam, register, recordPayment } from "./domain.mjs";
import { savePerson } from "./directory.mjs";
import { getRules, saveRules } from "./program-rules.mjs";

test("team completion combines roster and integer payment thresholds", () => {
  const facts = {
    players: 2,
    male: 1,
    female: 1,
    total_cents: 101,
    paid_cents: 50,
  };
  assert.equal(
    evaluateTeamCompletion({}, { ...facts, players: 0 }).status,
    "Complete",
  );
  assert.equal(
    evaluateTeamCompletion(
      { min_players: 2, min_male: 1, min_female: 1, payment: "Half" },
      facts,
    ).status,
    "Incomplete",
  );
  assert.equal(
    evaluateTeamCompletion({ payment: "Half" }, { ...facts, paid_cents: 51 })
      .status,
    "Complete",
  );
  assert.equal(
    evaluateTeamCompletion({ payment: "Full" }, facts).required_cents,
    101,
  );
  assert.equal(
    evaluateTeamCompletion(
      { min_players: 3, payment: "Half" },
      { ...facts, paid_cents: 101 },
    ).status,
    "Incomplete",
  );
});
test("derived team status follows saved rules, active roster, and invoice balance", () => {
  const db = openDb(":memory:");
  try {
    db.prepare("INSERT INTO organizations(id,name) VALUES('org','Org')").run();
    const actor = { id: "admin", org_id: "org" };
    const program = saveProgram(db, actor, {
      name: "League",
      type: "League",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "All",
      season: "Fall",
      start_date: "2026-10-01",
      fee_cents: 100,
    });
    const team = createTeam(db, actor, {
      program_id: program.id,
      name: "Team",
    });
    const player = savePerson(db, actor, {
      first_name: "Player",
      last_name: "Example",
      gender: "Female",
    });
    const registration = register(db, actor, {
      program_id: program.id,
      person_id: player.id,
      team_id: team.id,
    });
    const change = (values) =>
      saveRules(
        db,
        actor,
        { ...getRules(db, "org", program), ...values },
        program.id,
      );
    change({
      team_completion: { min_players: 1, min_female: 1, payment: "Half" },
    });
    assert.equal(
      teamRegistrationState(db, "org", team.id).status,
      "Incomplete",
    );
    db.prepare("UPDATE invoices SET paid_cents=50 WHERE id=?").run(
      registration.invoice_id,
    );
    assert.equal(teamRegistrationState(db, "org", team.id).status, "Complete");
    change({ capacity_includes_pending: false });
    assert.equal(
      teamRegistrationState(db, "org", team.id).status,
      "Incomplete",
    );
    db.prepare("UPDATE registrations SET status='Confirmed' WHERE id=?").run(
      registration.id,
    );
    assert.equal(teamRegistrationState(db, "org", team.id).status, "Complete");
    db.prepare("UPDATE invoices SET paid_cents=0 WHERE id=?").run(
      registration.invoice_id,
    );
    assert.equal(
      teamRegistrationState(db, "org", team.id).status,
      "Incomplete",
    );
    db.prepare("UPDATE invoices SET voided=1 WHERE id=?").run(
      registration.invoice_id,
    );
    assert.equal(teamRegistrationState(db, "org", team.id).status, "Complete");
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(
      registration.id,
    );
    assert.equal(
      teamRegistrationState(db, "org", team.id).status,
      "Incomplete",
    );
  } finally {
    db.close();
  }
});

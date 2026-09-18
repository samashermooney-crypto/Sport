import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { saveProgram, createTeam } from "./domain.mjs";
import { scheduleOptions } from "./schedule-options.mjs";
const actor = { id: "admin", org_id: "org" };
function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
  ).run();
  const program = (name, org = "org") =>
    saveProgram(
      db,
      { ...actor, org_id: org },
      {
        name,
        type: "League",
        sport: "Soccer",
        gender: "Co-Ed",
        level: "All",
        season: "Fall",
        start_date: "2026-09-12",
        fee_cents: 0,
        capacity: 100,
      },
    );
  const p = program("Current"),
    historical = program("Historical"),
    foreign = program("Foreign", "other");
  db.prepare("UPDATE programs SET status='Completed' WHERE id=?").run(
    historical.id,
  );
  const team = (name, p, org = "org") =>
    createTeam(db, { ...actor, org_id: org }, { name, program_id: p.id });
  const a = team("Current team", p),
    b = team("Historical team", historical),
    c = team("Foreign team", foreign, "other");
  const person = (id, org = "org") =>
    db
      .prepare(
        "INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES(?,?,?,'Coach','2026-09-01')",
      )
      .run(id, org, id);
  const staff = (id, person, team, role = "Coach", org = "org") =>
    db
      .prepare(
        "INSERT INTO team_staff(id,org_id,person_id,team_id,role,created_at) VALUES(?,?,?,?,?,'2026-09-01')",
      )
      .run(id, org, person, team.id, role);
  const reg = (id, person, team, status = "Confirmed", role = "Coach") =>
    db
      .prepare(
        "INSERT INTO registrations(id,org_id,person_id,program_id,team_id,status,role,created_at) VALUES(?,'org',?,?,?,?,?,'2026-09-01')",
      )
      .run(id, person, team.program_id, team.id, status, role);
  return { db, p, historical, foreign, a, b, c, person, staff, reg };
}
test("schedule options combine direct and confirmed staff once, including historical teams", () => {
  const { db, p, a, b, person, staff, reg } = fixture();
  try {
    person("Morgan");
    person("Pending");
    person("Canceled");
    person("Player");
    person("Captain");
    staff("direct", "Morgan", a);
    reg("registered", "Morgan", a);
    staff("historical", "Morgan", b);
    reg("pending", "Pending", a, "Pending");
    reg("canceled", "Canceled", a, "Canceled");
    reg("player", "Player", a, "Confirmed", "Team Player");
    staff("captain", "Captain", a, "Captain");
    const all = scheduleOptions(db, actor);
    assert.deepEqual(all.teams.map((t) => t.id).sort(), [a.id, b.id].sort());
    assert.deepEqual(all.staff, [
      { id: "Morgan", name: "Morgan Coach", team_ids: [a.id, b.id].sort() },
    ]);
    const scoped = scheduleOptions(db, actor, p.id);
    assert.deepEqual(
      scoped.teams.map((t) => t.id),
      [a.id],
    );
    assert.deepEqual(scoped.staff[0].team_ids, [a.id]);
  } finally {
    db.close();
  }
});
test("schedule options exclude foreign and archived assignments and reject foreign program scopes", () => {
  const { db, p, historical, foreign, a, b, c, person, staff } = fixture();
  try {
    person("Valid");
    person("Archived");
    person("Foreign", "other");
    staff("valid", "Valid", a);
    staff("archived", "Archived", a);
    staff("foreign", "Foreign", c, "Coach", "other");
    staff("forged-person", "Foreign", b);
    staff("forged-team", "Valid", c);
    db.prepare(
      "UPDATE people SET data='{" +
        '"archived_at":"2026-09-01"' +
        "}' WHERE id='Archived'",
    ).run();
    assert.deepEqual(
      scheduleOptions(db, actor).staff.map((p) => p.id),
      ["Valid"],
    );
    assert.throws(() => scheduleOptions(db, actor, foreign.id), /not found/);
    db.prepare(
      "UPDATE teams SET data='{" +
        '"archived_at":"2026-09-01"' +
        "}' WHERE id=?",
    ).run(a.id);
    assert.deepEqual(scheduleOptions(db, actor, p.id), {
      teams: [],
      staff: [],
    });
    db.prepare("UPDATE programs SET archived_at='2026-09-01' WHERE id=?").run(
      historical.id,
    );
    assert.deepEqual(scheduleOptions(db, actor), { teams: [], staff: [] });
  } finally {
    db.close();
  }
});

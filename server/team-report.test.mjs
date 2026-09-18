import {
  savedTeamReports,
  saveTeamReport,
  deleteTeamReport,
} from "./team-report.mjs";
import { teamReportRange } from "./team-report.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProgram, createTeam, register } from "./domain.mjs";
import { savePerson } from "./directory.mjs";
import { saveForm } from "./forms.mjs";
import {
  teamPropertyReport,
  teamReportCsv,
  teamReportFields,
} from "./team-report.mjs";
test("team properties tally assigned players, preserve historical options, and scope status/dates/organization", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO organizations(id,name,timezone) VALUES('org','Club','America/Chicago'),('other','Other','UTC')",
    ).run();
    makeApp(db);
    const actor = { id: "admin", org_id: "org" },
      program = saveProgram(db, actor, {
        name: "League",
        type: "League",
        sport: "Soccer",
        gender: "Co-Ed",
        level: "All",
        season: "Fall",
        start_date: "2026-10-01",
        fee_cents: 0,
        capacity: 50,
      });
    const team = createTeam(db, actor, {
      name: "=Formula Team",
      program_id: program.id,
    });
    const empty = createTeam(db, actor, {
      name: "Empty",
      program_id: program.id,
    });
    const field = id();
    saveForm(db, actor, `program:${program.id}`, {
      version: 1,
      fields: [
        {
          id: field,
          name: "Size",
          type: "Dropdown",
          options: ["Small", "Large", "__proto__"],
        },
      ],
    });
    for (const [i, role, answer, assigned] of [
      [0, "Team Player", "Small", true],
      [1, "Team Player", "Large", true],
      [2, "Coach", "Small", true],
      [3, "Free Agent", "Small", false],
      [4, "Team Player", "__proto__", true],
    ]) {
      const person = savePerson(db, actor, {
        first_name: "Person" + i,
        last_name: "Example",
        birthdate: "1990-01-01",
      });
      const r = register(db, actor, {
        program_id: program.id,
        person_id: person.id,
        team_id: assigned ? team.id : undefined,
        role,
        form_version: 2,
        answers: { [field]: answer },
      });
      db.prepare(
        "UPDATE registrations SET status=?,created_at='2026-09-07T01:00:00Z' WHERE id=?",
      ).run(i === 1 ? "Canceled" : "Confirmed", r.id);
    }
    const input = { program_id: program.id, field_id: field };
    const report = teamPropertyReport(db, "org", input);
    const saved = saveTeamReport(db, actor, {
      name: "Uniform sizes",
      filters: input,
    });
    assert.equal(savedTeamReports(db, actor)[0].filters.field_id, field);
    assert.equal(
      savedTeamReports(db, { ...actor, id: "another-admin" }).length,
      0,
    );
    assert.equal(savedTeamReports(db, { ...actor, org_id: "other" }).length, 0);
    assert.throws(
      () =>
        saveTeamReport(db, actor, { name: "uniform sizes", filters: input }),
      /already/,
    );
    assert.throws(
      () => deleteTeamReport(db, { ...actor, id: "another-admin" }, saved.id),
      /not found/,
    );
    assert.equal(teamPropertyReport(db, "org", saved.filters).answered, 3);
    deleteTeamReport(db, actor, saved.id);
    assert.equal(savedTeamReports(db, actor).length, 0);

    assert.equal(report.answered, 3);
    assert.equal(report.rows.find((r) => r.id === empty.id).answered, 0);
    assert.equal(report.totals.Small, 1);
    assert.equal(report.totals.Large, 1);
    assert.equal(report.totals.__proto__, 1);
    assert.equal(
      teamPropertyReport(db, "org", { ...input, status: "Confirmed" }).answered,
      2,
    );
    assert.equal(
      teamPropertyReport(db, "org", { ...input, from: "2026-09-07" }).answered,
      0,
    );
    assert.equal(
      teamPropertyReport(db, "org", { ...input, to: "2026-09-06" }).answered,
      3,
    );
    assert.throws(() => teamPropertyReport(db, "other", input));
    assert.throws(() =>
      teamPropertyReport(db, "org", { ...input, field_id: "foreign" }),
    );
    saveForm(db, actor, `program:${program.id}`, { version: 2, fields: [] });
    assert.equal(teamReportFields(db, "org", program.id)[0].id, field);
    assert.equal(teamPropertyReport(db, "org", input).answered, 3);
    assert.match(teamReportCsv(report), /"'=Formula Team"/);
  } finally {
    db.close();
  }
});

test("team report ranges enforce lookback and one-year limits with leap-day clamping", () => {
  const limits = { min: "2023-09-07", max: "2026-09-07" };
  assert.deepEqual(teamReportRange({}, limits), {
    from: "2025-09-07",
    to: "2026-09-07",
  });
  assert.deepEqual(teamReportRange({ from: "2024-02-29" }, limits), {
    from: "2024-02-29",
    to: "2025-02-28",
  });
  assert.throws(
    () => teamReportRange({ from: "2023-09-06", to: "2024-01-01" }, limits),
    /three years/,
  );
  assert.throws(
    () => teamReportRange({ from: "2025-01-01", to: "2026-01-02" }, limits),
    /one year/,
  );
  assert.throws(
    () => teamReportRange({ from: "2026-09-08", to: "2026-09-09" }, limits),
    /three years/,
  );
  assert.throws(
    () => teamReportRange({ from: "2026-09-07", to: "2026-09-06" }, limits),
    /start date/,
  );
});

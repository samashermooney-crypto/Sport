import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { saveProgram, createTeam, saveEvent } from "./domain.mjs";
import { previewScheduleImport, acceptScheduleImport } from "./schedule-import-mapping.mjs";
test("preview maps names, permits explicit aliases, rejects foreign IDs and never saves activities", () => {
  const db = openDb(":memory:"), actor = { id: "admin", org_id: "org" };
  try {
    db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')").run();
    const make = (org, name) => saveProgram(db, { ...actor, org_id: org }, { name, type: "League", sport: "Soccer", gender: "Co-Ed", level: "All", season: "Fall", start_date: "2026-09-12", fee_cents: 0, capacity: 100 });
    const p = make("org", "League"), foreign = make("other", "League");
    const home = createTeam(db, actor, { name: "Blue", program_id: p.id });
    createTeam(db, actor, { name: "Red", program_id: p.id });
    const outsider = createTeam(db, { ...actor, org_id: "other" }, { name: "Blue", program_id: foreign.id });
    for (const [id, parent, name] of [["park-a", null, "Park A"], ["park-b", null, "Park B"], ["field-a", "park-a", "Field 1"], ["field-b", "park-b", "Field 1"]])
      db.prepare("INSERT INTO locations(id,org_id,parent_id,name) VALUES(?,'org',?,?)").run(id, parent, name);
    const input = { program_id: p.id, csv: "HOME_TEAM,AWAY_TEAM,DATE,START_TIME,TYPE\nBlue,Red,09/12/2026,09:00,REGULAR_SEASON" };
    let preview = previewScheduleImport(db, actor, input);
    assert.equal(preview.ready, true);
    assert.equal(preview.rows[0].start_at, "2026-09-12T14:00:00.000Z");
    assert.equal(preview.rows[0].end_at, "");
    const alias = { ...input, csv: input.csv.replace("Blue,Red", "Visitors,Red") };
    preview = previewScheduleImport(db, actor, alias);
    assert.equal(preview.ready, false);
    const key = preview.mappings.find((m) => m.name === "Visitors").key;
    const mapped = previewScheduleImport(db, actor, { ...alias, mappings: { [key]: home.id } });
    assert.equal(mapped.ready, true);
    assert.equal(mapped.rows[0].home_team, "Visitors");
    assert.equal(mapped.rows[0].home_team_name, "Blue");
    assert.equal(mapped.rows[0].title, "Blue vs Red");
    assert.equal(mapped.rows[0].program_name, "League");
    const otherProgram = make("org", "Neighbor League");
    const visiting = createTeam(db, actor, { name: "Visitors", program_id: otherProgram.id });
    const crossInput = { ...input, csv: input.csv.replace("Blue,Red", "Blue,Visitors") };
    assert.equal(previewScheduleImport(db, actor, crossInput).ready, false);
    const crossPreview = previewScheduleImport(db, actor, { ...crossInput, cross_program: true });
    assert.equal(crossPreview.ready, true);
    assert.equal(crossPreview.rows[0].away_team_id, visiting.id);
    assert.equal(previewScheduleImport(db, actor, { ...crossInput, csv: crossInput.csv.replace("Blue,Visitors", "Visitors,Visitors"), cross_program: true }).ready, false);
    const locationInput = { program_id: p.id, csv: "NAME,TYPE,START_DATE,START_TIME,LOCATION,SUB_LOCATION\nPractice,PRACTICE,09/12/2026,09:00,Park A,Field 1" };
    const locationPreview = previewScheduleImport(db, actor, locationInput);
    assert.equal(locationPreview.ready, true);
    assert.equal(locationPreview.rows[0].location_id, "field-a");
    const fieldChoice = locationPreview.mappings.find((m) => m.kind === "sub-location");
    assert.deepEqual(fieldChoice.options.map((o) => o.id), ["field-a"]);
    assert.equal(previewScheduleImport(db, actor, { ...locationInput, mappings: { [fieldChoice.key]: "field-b" } }).ready, false);
    assert.equal(previewScheduleImport(db, actor, { ...alias, mappings: { [key]: outsider.id } }).ready, false);
    assert.throws(() => previewScheduleImport(db, actor, { ...input, program_id: foreign.id }), /available program/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 0);
    const fields = { program_id: p.id, type: "Event", title: "Practice", start_at: "2026-09-12T14:00:00Z", end_at: "" };
    const saved = saveEvent(db, actor, { ...fields, activity_type: "PRACTICE", description: "Bring water", location_note: "Gate B" });
    const edited = saveEvent(db, actor, { ...fields, title: "Updated practice" }, saved.id);
    assert.equal(edited.activity_type, "PRACTICE");
    assert.equal(edited.description, "Bring water");
    assert.equal(edited.location_note, "Gate B");
    const cleared = saveEvent(db, actor, { ...fields, description: "", location_note: "" }, saved.id);
    assert.equal(cleared.description, "");
    assert.equal(cleared.location_note, "");
  } finally { db.close(); }
});

test("accept rolls back conflicting batches and retries successful imports without duplicates", () => {
  const db = openDb(":memory:"), actor = { id: "admin", org_id: "org" };
  try {
    db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club')").run();
    const p = saveProgram(db, actor, { name: "League", type: "League", sport: "Soccer", gender: "Co-Ed", level: "All", season: "Fall", start_date: "2026-09-12", fee_cents: 0, capacity: 100 });
    createTeam(db, actor, { name: "Blue", program_id: p.id });
    createTeam(db, actor, { name: "Red", program_id: p.id });
    const header = "HOME_TEAM,AWAY_TEAM,DATE,START_TIME,END_TIME,TYPE\n";
    const request = { program_id: p.id, request_key: "import-test-key-0001", csv: header + "Blue,Red,09/12/2026,09:00,10:00,REGULAR_SEASON\nBlue,Red,09/12/2026,09:30,10:30,REGULAR_SEASON" };
    const auditBefore = db.prepare("SELECT count(*) n FROM audit_log").get().n;
    const rejectedPreview = previewScheduleImport(db, actor, request);
    assert.equal(rejectedPreview.ready, false);
    assert.equal(rejectedPreview.issues[0].line, 3);
    assert.match(rejectedPreview.issues[0].message, /Schedule conflict/);
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log").get().n, auditBefore);
    assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 0);
    assert.throws(() => acceptScheduleImport(db, actor, request), (error) => {
      assert.match(error.message, /CSV line 3: Schedule conflict/);
      assert.equal(error.import_not_saved, true);
      return true;
    });
    assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM schedule_imports").get().n, 0);
    request.csv = header + "Blue,Red,09/12/2026,09:00,10:00,REGULAR_SEASON\nBlue,Red,09/12/2026,10:00,11:00,PLAYOFF";
    const result = acceptScheduleImport(db, actor, request);
    assert.equal(result.count, 2);
    assert.equal(result.published, false);
    assert.deepEqual(acceptScheduleImport(db, actor, request), result);
    assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 2);
    assert.throws(() => acceptScheduleImport(db, actor, { ...request, published: true }), (error) => {
      assert.match(error.message, /different content/);
      assert.equal(error.import_not_saved, undefined);
      return true;
    });
    const row = db.prepare("SELECT data FROM events WHERE id=?").get(result.event_ids[1]);
    assert.equal(JSON.parse(row.data).game_type, "Playoff");
    assert.equal(JSON.parse(row.data).activity_type, "PLAYOFF");
  } finally { db.close(); }
});

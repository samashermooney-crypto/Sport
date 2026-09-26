import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { saveProgram } from "./domain.mjs";
import { searchRecords } from "./global-search.mjs";
test("record search scopes organizations, excludes archived profiles, and treats wildcard characters literally", () => {
  const db = openDb(":memory:"), actor = { id: "admin", org_id: "org" };
  try {
    db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')").run();
    for (const org of ["org", "other"]) {
      saveProgram(db, { ...actor, org_id: org }, { name: "Soccer 100%", type: "League", sport: "Soccer", gender: "Co-Ed", level: "All", season: "Fall", start_date: "2026-09-12", fee_cents: 0, capacity: 100 });
      db.prepare("INSERT INTO people(id,org_id,first_name,last_name,email,created_at) VALUES(?,?,'Casey','Player','casey@example.com','2026-09-01')").run(org, org);
      db.prepare("INSERT INTO invoices(id,number,org_id,person_id,description,total_cents,created_at) VALUES(?,?,?,?,?,1000,'2026-09-01')").run(org, org === "org" ? 1024 : 1025, org, org, "Soccer signup");
    }
    assert.equal(searchRecords(db, actor, "Soccer").results.length, 2);
    assert.equal(searchRecords(db, actor, "100%").results.length, 1);
    assert.equal(searchRecords(db, actor, "%%").results.length, 0);
    assert.equal(searchRecords(db, actor, "Casey").results.length, 1);
    assert.equal(searchRecords(db, actor, "#1024").results[0].path, "/invoices/org");
    assert.equal(searchRecords(db, actor, "#1025").results.length, 0);
    db.prepare("UPDATE people SET data=? WHERE id='org'").run(JSON.stringify({ archived_at: "2026-09-09" }));
    assert.equal(searchRecords(db, actor, "Casey").results.length, 0);
    assert.equal(searchRecords(db, actor, "c").results.length, 0);
  } finally { db.close(); }
});

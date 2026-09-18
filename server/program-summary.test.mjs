import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { summaryView, saveSummaryView } from "./program-summary.mjs";
test("summary columns persist per user and organization, reject stale saves and unknown columns", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
    ).run();
    const actor = { id: "admin", org_id: "org" };
    const initial = summaryView(db, actor);
    assert.deepEqual(initial.columns, [
      "paid",
      "outstanding",
      "players",
      "free_agents",
      "staff",
      "teams",
    ]);
    const saved = saveSummaryView(db, actor, {
      version: initial.version,
      columns: ["code", "sport", "sport"],
    });
    assert.deepEqual(saved, { version: 2, columns: ["code", "sport"] });
    assert.deepEqual(summaryView(db, actor), saved);
    assert.deepEqual(summaryView(db, { ...actor, id: "second" }), initial);
    assert.deepEqual(summaryView(db, { ...actor, org_id: "other" }), initial);
    assert.throws(
      () => saveSummaryView(db, actor, { version: 1, columns: [] }),
      (e) => e.status === 409,
    );
    assert.throws(() =>
      saveSummaryView(db, actor, { version: 2, columns: ["unknown"] }),
    );
    assert.deepEqual(summaryView(db, actor), saved);
    assert.deepEqual(
      saveSummaryView(db, actor, { version: 2, columns: [] }).columns,
      [],
    );
  } finally {
    db.close();
  }
});

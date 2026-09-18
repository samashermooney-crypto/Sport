import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDb } from "./db.mjs";
import { saveProgram } from "./domain.mjs";
import { createTryout, getTryout, listTryouts } from "./tryouts.mjs";

test("tryout creation persists, retries once, and rejects foreign or archived dependencies", () => {
  const db = openDb(":memory:"), actor = { id: "admin", org_id: "org" }, other = { ...actor, org_id: "other" };
  try {
    db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')").run();
    const makeProgram = a => saveProgram(db, a, { name: "Fall", type: "League", sport: "Soccer", gender: "Co-Ed", level: "All", season: "Fall", start_date: "2026-09-12", fee_cents: 0, capacity: 100 });
    const program = makeProgram(actor), foreign = makeProgram(other);
    const input = { request_key: randomUUID(), name: "Fall tryout", program_id: program.id, rounds: [{ id: randomUUID(), start_at: "2026-10-20T14:00:00Z" }], attributes: [{ id: randomUUID(), name: "Passing", scale: "1-5" }] };
    const saved = createTryout(db, actor, input);
    assert.equal(getTryout(db, actor, saved.id).name, "Fall tryout");
    assert.equal(createTryout(db, actor, input).id, saved.id);
    assert.equal(listTryouts(db, actor).length, 1);
    assert.equal(listTryouts(db, other).length, 0);
    assert.throws(() => getTryout(db, other, saved.id), /not found/);
    assert.throws(() => createTryout(db, actor, { ...input, name: "Changed" }), error => error.status === 409);
    assert.throws(() => createTryout(db, actor, { ...input, request_key: randomUUID(), program_id: foreign.id }), /available registration/);
    const location = randomUUID();
    db.prepare("INSERT INTO locations(id,org_id,name) VALUES(?,'other','Field')").run(location);
    assert.throws(() => createTryout(db, actor, { ...input, request_key: randomUUID(), rounds: [{ ...input.rounds[0], location_id: location }] }), /location is unavailable/);
    db.prepare("UPDATE programs SET archived_at='2026-09-09' WHERE id=?").run(program.id);
    assert.throws(() => createTryout(db, actor, { ...input, request_key: randomUUID() }), /available registration/);
    assert.equal(createTryout(db, actor, input).id, saved.id, "retry remains valid after archival");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_log WHERE entity_type='tryout'").get().count, 1);
  } finally { db.close(); }
});

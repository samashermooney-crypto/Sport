import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now } from "./db.mjs";
import {
  saveProgram,
  createTeam,
  register,
  recordPayment,
  saveEvent,
  programStats,
} from "./domain.mjs";
function fixture() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "org",
    "Test club",
  );
  const actor = { id: "admin", org_id: "org" };
  const p = saveProgram(db, actor, {
    name: "Test League",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "Recreational",
    season: "Fall",
    start_date: "2026-09-12",
    fee_cents: 9500,
    capacity: 1,
  });
  function person() {
    const pid = id();
    db.prepare(
      "INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES(?,?,?,?,?)",
    ).run(pid, "org", "Test", "Player", now());
    return pid;
  }
  return { db, actor, p, person };
}
test("registration, capacity, invoice and payment stay consistent; retries do not double-charge", () => {
  const { db, actor, p, person } = fixture();
  try {
    const a = register(db, actor, { program_id: p.id, person_id: person() });
    assert.equal(a.status, "Pending");
    const b = register(db, actor, { program_id: p.id, person_id: person() });
    assert.equal(b.status, "Wait List");
    assert.equal(b.invoice_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices").get().n, 1);
    const pay = {
      amount_cents: 9500,
      method: "Cash",
      idempotency_key: "payment-one",
    };
    const tx = recordPayment(db, actor, a.invoice_id, pay);
    assert.equal(recordPayment(db, actor, a.invoice_id, pay).id, tx.id);
    assert.equal(
      db.prepare("SELECT status FROM registrations WHERE id=?").get(a.id)
        .status,
      "Confirmed",
    );
    const stats = programStats(db, "org")[0];
    assert.equal(stats.paid, 9500);
    assert.equal(stats.outstanding, 0);
    assert.equal(stats.registrations, 2);
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(
      b.id,
    );
    assert.equal(programStats(db, "org")[0].registrations, 1);
    assert.throws(
      () =>
        recordPayment(db, actor, a.invoice_id, {
          ...pay,
          idempotency_key: "payment-two",
        }),
      /exceeds/,
    );
  } finally {
    db.close();
  }
});
test("duplicate registration rolls back and cross-organization records cannot be read", () => {
  const { db, actor, p, person } = fixture();
  try {
    const pid = person();
    register(db, actor, { program_id: p.id, person_id: pid });
    assert.throws(
      () => register(db, actor, { program_id: p.id, person_id: pid }),
      /already registered/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices").get().n, 1);
    assert.throws(
      () =>
        register(db, { org_id: "other" }, { program_id: p.id, person_id: pid }),
      /not found/,
    );
  } finally {
    db.close();
  }
});
test("team and location collisions reject atomically while adjacent activities are allowed", () => {
  const { db, actor, p } = fixture();
  try {
    const a = createTeam(db, actor, { program_id: p.id, name: "A" }),
      b = createTeam(db, actor, { program_id: p.id, name: "B" });
    const e = {
      program_id: p.id,
      type: "Game",
      title: "A vs B",
      home_team_id: a.id,
      away_team_id: b.id,
      start_at: "2026-09-12T14:00:00Z",
      end_at: "2026-09-12T15:00:00Z",
    };
    saveEvent(db, actor, e);
    assert.throws(
      () =>
        saveEvent(db, actor, {
          ...e,
          start_at: "2026-09-12T14:30:00Z",
          end_at: "2026-09-12T15:30:00Z",
        }),
      /conflict/,
    );
    saveEvent(db, actor, {
      ...e,
      start_at: "2026-09-12T15:00:00Z",
      end_at: "2026-09-12T16:00:00Z",
    });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 2);
    assert.throws(
      () => saveEvent(db, actor, { ...e, away_team_id: a.id }),
      /different teams/,
    );
  } finally {
    db.close();
  }
});

test("summary invoice counts exclude voids and overdue respects organization date and remaining balance", () => {
  const { db, p, person } = fixture();
  try {
    db.prepare(
      "UPDATE organizations SET timezone='America/Chicago' WHERE id='org'",
    ).run();
    const pid = person();
    const insert = db.prepare(
      "INSERT INTO invoices(id,number,org_id,program_id,person_id,description,total_cents,paid_cents,due_date,voided,created_at) VALUES(?,?,'org',?,?,'Test',?,?,?,?,?)",
    );
    [
      [100, 100, "2026-09-05", 0],
      [100, 25, "2026-09-05", 0],
      [100, 0, "2026-09-06", 0],
      [200, 0, "", 0],
      [900, 0, "2026-09-01", 1],
      [0, 0, "2026-09-01", 0],
    ].forEach((v, n) => insert.run(id(), n + 1, p.id, pid, ...v, now()));
    const stats = programStats(db, "org", new Date("2026-09-07T02:00:00Z"))[0];
    assert.equal(stats.paid_invoices, 2);
    assert.equal(stats.partial_invoices, 1);
    assert.equal(stats.unpaid_invoices, 2);
    assert.equal(stats.overdue, 75);
    assert.equal(stats.outstanding, 375);
    assert.equal(
      programStats(db, "org", new Date("2026-09-07T06:00:00Z"))[0].overdue,
      175,
    );
    db.prepare(
      "INSERT INTO organizations(id,name) VALUES('other','Other')",
    ).run();
    assert.deepEqual(programStats(db, "other"), []);
  } finally {
    db.close();
  }
});

test("rescheduled activities persist and continue to reserve their team times", () => {
  const { db, actor, p } = fixture();
  try {
    const team = createTeam(db, actor, { program_id: p.id, name: "Rescheduled team" });
    const input = { program_id: p.id, type: "Event", title: "Moved practice", home_team_id: team.id,
      start_at: "2026-09-12T14:00:00Z", end_at: "2026-09-12T15:00:00Z", state: "Rescheduled" };
    const event = saveEvent(db, actor, input);
    assert.equal(db.prepare("SELECT state FROM events WHERE id=?").get(event.id).state, "Rescheduled");
    assert.throws(() => saveEvent(db, actor, { ...input, title: "Conflicting practice", state: "Scheduled" }), /conflict/);
    const restored = saveEvent(db, actor, { ...input, state: "Scheduled" }, event.id);
    assert.equal(restored.state, "Scheduled");
  } finally { db.close(); }
});

test('unknown end times persist without fabricated duration and check known start conflicts',()=>{
 const {db,actor,p}=fixture();
 try {
  const team=createTeam(db,actor,{program_id:p.id,name:'TBD team'});
  const base={program_id:p.id,type:'Event',title:'TBD practice',home_team_id:team.id,start_at:'2026-09-12T14:00:00Z',end_at:''};
  const event=saveEvent(db,actor,base);
  assert.equal(event.end_at,'');
  assert.equal(db.prepare('SELECT end_at FROM events WHERE id=?').get(event.id).end_at,'');
  assert.throws(()=>saveEvent(db,actor,base),/conflict/);
  assert.throws(()=>saveEvent(db,actor,{...base,start_at:'2026-09-12T13:00:00Z',end_at:'2026-09-12T15:00:00Z'}),/conflict/);
  saveEvent(db,actor,{...base,title:'Before',start_at:'2026-09-12T13:00:00Z',end_at:'2026-09-12T14:00:00Z'});
  assert.throws(()=>saveEvent(db,actor,{...base,start_at:'2026-09-12T13:30:00Z'}),/conflict/);
  const known=saveEvent(db,actor,{...base,end_at:'2026-09-12T15:00:00Z'},event.id);
  assert.equal(known.end_at,'2026-09-12T15:00:00.000Z');
  assert.throws(()=>saveEvent(db,actor,{...base,start_at:'2026-09-12T14:30:00Z'}),/conflict/);
  saveEvent(db,actor,{...base,start_at:'2026-09-12T15:00:00Z'});
 }finally{db.close();}
});

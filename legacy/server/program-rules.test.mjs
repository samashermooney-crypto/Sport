import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { savePerson } from "./directory.mjs";
import { saveProgram, register } from "./domain.mjs";
import { saveRules, getRules, registrationFee } from "./program-rules.mjs";
function fixture() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "org",
    "Club",
  );
  const actor = { id: "admin", org_id: "org" };
  const program = saveProgram(db, actor, {
    name: "League",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "All",
    season: "Fall",
    start_date: "2026-10-01",
    fee_cents: 9500,
    capacity: 3,
  });
  const person = (name, birthdate = "2015-05-14", gender = "Female") =>
    savePerson(db, actor, {
      first_name: name,
      last_name: "Example",
      birthdate,
      gender,
    });
  return { db, actor, program, person };
}
test("age, waiver and role rules reject registration before any invoice or registration is written", () => {
  const { db, actor, program, person } = fixture();
  try {
    saveRules(
      db,
      actor,
      {
        ...getRules(db, actor.org_id, program),
        use_site_defaults: false,
        min_age: 10,
        max_age: 12,
        age_as_of: "2026-10-01",
        require_waiver: true,
        allow_free_agents: false,
      },
      program.id,
    );
    const p = person("Young", "2020-01-01");
    assert.throws(
      () => register(db, actor, { program_id: program.id, person_id: p.id }),
      /Free-agent/,
    );
    saveRules(
      db,
      actor,
      { ...getRules(db, actor.org_id, program), allow_free_agents: true },
      program.id,
    );
    assert.throws(
      () => register(db, actor, { program_id: program.id, person_id: p.id }),
      /age requirements/,
    );
    const allowed = person("Eligible");
    assert.throws(
      () =>
        register(db, actor, { program_id: program.id, person_id: allowed.id }),
      /waiver/,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM invoices").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM registrations").get().n, 0);
    assert.equal(
      register(db, actor, {
        program_id: program.id,
        person_id: allowed.id,
        waiver_accepted: true,
      }).status,
      "Pending",
    );
  } finally {
    db.close();
  }
});
test("programs retain captured defaults and enforce reserved-only capacity", () => {
  const { db, actor, program, person } = fixture();
  try {
    saveRules(db, actor, { male_capacity: 1 });
    assert.equal(getRules(db, actor.org_id, program).male_capacity, null);
    const next = saveProgram(db, actor, {
      ...program,
      name: "Later League",
      grouped: !!program.grouped,
      public: !!program.public,
      waitlist: !!program.waitlist,
    });
    assert.equal(getRules(db, actor.org_id, next).male_capacity, 1);
    saveRules(db, actor, { male_capacity: 5 });
    assert.equal(getRules(db, actor.org_id, next).male_capacity, 1);
    saveRules(
      db,
      actor,
      { ...getRules(db, actor.org_id, program), male_capacity: 1 },
      program.id,
    );
    const a = register(db, actor, {
      program_id: program.id,
      person_id: person("First", "2015-04-01", "Male").id,
    });
    assert.equal(a.status, "Pending");
    const b = register(db, actor, {
      program_id: program.id,
      person_id: person("Second", "2015-04-01", "Male").id,
    });
    assert.equal(b.status, "Wait List");
    saveRules(
      db,
      actor,
      {
        ...getRules(db, actor.org_id, program),
        use_site_defaults: false,
        capacity_includes_pending: false,
      },
      program.id,
    );
    const c = register(db, actor, {
      program_id: program.id,
      person_id: person("Third", "2015-04-01", "Male").id,
    });
    assert.equal(c.status, "Pending");
  } finally {
    db.close();
  }
});
test("dated prices and deadlines affect new invoices while retaining earlier invoice amounts", () => {
  const { db, actor, program, person } = fixture();
  try {
    const rules = {
      ...getRules(db, actor.org_id, program),
      use_site_defaults: false,
      early_fee_cents: 7500,
      early_ends: "2099-01-01",
      late_fee_cents: 11000,
      late_starts: "2099-02-01",
      deadline_mode: "Date",
      deadline_date: "2099-03-01",
    };
    assert.equal(registrationFee(program, rules, "2099-01-01", false), 7500);
    assert.equal(registrationFee(program, rules, "2099-01-02", false), 9500);
    assert.equal(registrationFee(program, rules, "2099-02-01", false), 11000);
    assert.equal(registrationFee(program, rules, "2099-02-01", true), 0);
    saveRules(db, actor, rules, program.id);
    const registration = register(db, actor, {
      person_id: person("First").id,
      program_id: program.id,
    });
    let invoice = db
      .prepare("SELECT * FROM invoices WHERE id=?")
      .get(registration.invoice_id);
    assert.equal(invoice.total_cents, 7500);
    assert.equal(invoice.due_date, "2099-03-01");
    saveRules(
      db,
      actor,
      {
        ...rules,
        fee_cents: 12000,
        early_fee_cents: null,
        early_ends: "",
        late_fee_cents: null,
        late_starts: "",
        deadline_mode: "None",
      },
      program.id,
    );
    invoice = db
      .prepare("SELECT * FROM invoices WHERE id=?")
      .get(registration.invoice_id);
    assert.equal(invoice.total_cents, 7500);
    const next = register(db, actor, {
      person_id: person("Second").id,
      program_id: program.id,
    });
    assert.equal(
      db
        .prepare("SELECT total_cents FROM invoices WHERE id=?")
        .get(next.invoice_id).total_cents,
      12000,
    );
  } finally {
    db.close();
  }
});

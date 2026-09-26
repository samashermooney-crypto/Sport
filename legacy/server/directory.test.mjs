import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { saveProgram, register, saveEvent } from "./domain.mjs";
import {
  listPeople,
  savePerson,
  saveHousehold,
  linkHouseholdMember,
  saveDiscount,
  issueCredit,
  applyCredit,
  listCredits,
  saveLocation,
} from "./directory.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "org",
    "Test club",
  );
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "other",
    "Other club",
  );
  const actor = { id: "admin", org_id: "org" },
    other = { id: "otheradmin", org_id: "other" };
  const person = (name = "Member") =>
    savePerson(db, actor, {
      first_name: name,
      last_name: "Test",
      birthdate: "2015-02-28",
    });
  const program = (name = "League") =>
    saveProgram(db, actor, {
      name,
      type: "League",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "All Levels",
      season: "Fall",
      start_date: "2026-10-01",
      fee_cents: 9500,
    });
  return { db, actor, other, person, program };
}
test("member lists expose current household roles for family purchaser selection", () => {
  const { db, actor, other, person } = fixture();
  try {
    const family = saveHousehold(db, actor, { name: "Family" });
    const child = person("Child"), supervisor = person("Supervisor"), unrelated = person("Unrelated");
    linkHouseholdMember(db, actor, family.id, { person_id: child.id, role: "Member" });
    linkHouseholdMember(db, actor, family.id, { person_id: supervisor.id, role: "Supervisor" });
    const foreign = savePerson(db, other, { first_name: "Foreign", last_name: "Member" });
    const members = listPeople(db, actor.org_id);
    assert.equal(members.find(p => p.id === child.id).household_role, "Member");
    assert.equal(members.find(p => p.id === supervisor.id).household_role, "Supervisor");
    assert.equal(members.find(p => p.id === supervisor.id).household_id, family.id);
    assert.equal(members.find(p => p.id === unrelated.id).household_role, null);
    assert.equal(members.some(p => p.id === foreign.id), false);
    db.prepare("UPDATE household_members SET role='Member' WHERE household_id=? AND person_id=?").run(family.id, supervisor.id);
    assert.equal(listPeople(db, actor.org_id).find(p => p.id === supervisor.id).household_role, "Member");
  } finally {
    db.close();
  }
});
test("family links preserve profiles and cannot cross organization boundaries", () => {
  const { db, actor, other, person } = fixture();
  try {
    const h = saveHousehold(db, actor, { name: "Test Family" }),
      p = person();
    linkHouseholdMember(db, actor, h.id, { person_id: p.id, role: "Member" });
    assert.equal(
      db.prepare("SELECT household_id FROM people WHERE id=?").get(p.id)
        .household_id,
      h.id,
    );
    assert.throws(
      () =>
        linkHouseholdMember(db, actor, h.id, {
          person_id: p.id,
          role: "Member",
        }),
      /already belongs/,
    );
    const foreign = saveHousehold(db, other, { name: "Other Family" });
    assert.throws(
      () =>
        linkHouseholdMember(db, actor, foreign.id, {
          person_id: p.id,
          role: "Member",
        }),
      /not found/,
    );
    assert.throws(() =>
      savePerson(db, actor, {
        first_name: "Invalid",
        last_name: "Date",
        birthdate: "2026-02-30",
      }),
    );
    assert.throws(
      () =>
        savePerson(db, actor, {
          first_name: "Other",
          last_name: "Link",
          household_id: foreign.id,
        }),
      /not found/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, 1);
  } finally {
    db.close();
  }
});
test("discount redemption is atomic, validates scope, and enforces per-person and total limits", () => {
  const { db, actor, person, program } = fixture();
  try {
    const a = person(),
      b = person("Second"),
      one = program("One"),
      two = program("Two");
    const discount = saveDiscount(db, actor, {
      name: "Quarter off",
      code: "SAVE25",
      kind: "Percentage",
      value: 2500,
      redemption_limit: 2,
    });
    const reg = register(db, actor, {
      person_id: a.id,
      program_id: one.id,
      discount_code: "save25",
    });
    assert.equal(
      db
        .prepare("SELECT total_cents FROM invoices WHERE id=?")
        .get(reg.invoice_id).total_cents,
      7125,
    );
    assert.throws(
      () =>
        register(db, actor, {
          person_id: a.id,
          program_id: two.id,
          discount_code: "SAVE25",
        }),
      /already used/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registrations").get().n, 1);
    register(db, actor, {
      person_id: b.id,
      program_id: one.id,
      discount_code: "SAVE25",
    });
    assert.throws(
      () =>
        register(db, actor, {
          person_id: person("Third").id,
          program_id: two.id,
          discount_code: "SAVE25",
        }),
      /limit/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM discount_redemptions WHERE discount_id=?",
        )
        .get(discount.id).n,
      2,
    );
    const restricted = saveDiscount(db, actor, {
      name: "Full fee",
      code: "FREE",
      kind: "Fixed",
      value: 20000,
      program_id: two.id,
    });
    assert.throws(
      () =>
        register(db, actor, {
          person_id: person("Fourth").id,
          program_id: one.id,
          discount_code: restricted.code,
        }),
      /invalid/,
    );
    const free = register(db, actor, {
      person_id: a.id,
      program_id: two.id,
      discount_code: "FREE",
    });
    assert.equal(free.status, "Confirmed");
    assert.equal(
      db
        .prepare("SELECT total_cents FROM invoices WHERE id=?")
        .get(free.invoice_id).total_cents,
      0,
    );
  } finally {
    db.close();
  }
});
test("credits cannot be overused, applied across members, or counted as cash receipts", () => {
  const { db, actor, person, program } = fixture();
  try {
    const a = person(),
      b = person("Second"),
      p = program(),
      r = register(db, actor, { person_id: a.id, program_id: p.id }),
      r2 = register(db, actor, { person_id: b.id, program_id: p.id });
    const credit = issueCredit(db, actor, {
      person_id: a.id,
      amount_cents: 12000,
      description: "Season credit",
    });
    const request = {
      credit_id: credit.id,
      amount_cents: 9500,
      idempotency_key: "credit-request-1",
    };
    assert.throws(
      () => applyCredit(db, actor, r2.invoice_id, request),
      /belonging/,
    );
    const applied = applyCredit(db, actor, r.invoice_id, request);
    assert.equal(applyCredit(db, actor, r.invoice_id, request).id, applied.id);
    assert.equal(listCredits(db, actor.org_id, a.id)[0].balance_cents, 2500);
    assert.equal(
      db.prepare("SELECT paid_cents FROM invoices WHERE id=?").get(r.invoice_id)
        .paid_cents,
      9500,
    );
    assert.equal(
      db.prepare("SELECT status FROM registrations WHERE id=?").get(r.id)
        .status,
      "Confirmed",
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
    assert.throws(
      () =>
        applyCredit(db, actor, r.invoice_id, {
          ...request,
          idempotency_key: "new-key-123",
        }),
      /exceeds/,
    );
    assert.throws(
      () =>
        applyCredit(db, actor, r.invoice_id, { ...request, amount_cents: 1 }),
      /already used/,
    );
  } finally {
    db.close();
  }
});
test("whole-venue bookings conflict with individual fields, while separate fields can run concurrently", () => {
  const { db, actor, program } = fixture();
  try {
    const p = program(),
      venue = saveLocation(db, actor, { name: "Sports Complex" }),
      a = saveLocation(db, actor, { name: "Field A", parent_id: venue.id }),
      b = saveLocation(db, actor, { name: "Field B", parent_id: venue.id });
    const event = {
      program_id: p.id,
      type: "Event",
      title: "Practice",
      start_at: "2026-10-01T15:00:00Z",
      end_at: "2026-10-01T16:00:00Z",
    };
    saveEvent(db, actor, { ...event, location_id: a.id });
    saveEvent(db, actor, { ...event, location_id: b.id });
    assert.throws(
      () => saveEvent(db, actor, { ...event, location_id: venue.id }),
      /conflict/,
    );
    assert.throws(
      () => saveLocation(db, actor, { name: "Grandchild", parent_id: a.id }),
      /top-level/,
    );
    assert.throws(
      () =>
        saveEvent(db, actor, {
          ...event,
          start_at: "2026-10-01T15:00:00Z",
          end_at: "2026-10-01T14:00:00Z",
        }),
      /End time/,
    );
  } finally {
    db.close();
  }
});

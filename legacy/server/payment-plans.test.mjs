import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { saveProgram } from "./domain.mjs";
import {
  savePaymentPlan,
  programPaymentPlans,
  installmentSnapshot,
} from "./payment-plans.mjs";
test("payment plan templates validate schedules, isolate organizations, and preserve detached snapshot amounts", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
    ).run();
    const actor = { id: "admin", org_id: "org" };
    const program = saveProgram(db, actor, {
      name: "League",
      type: "League",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "All",
      season: "Fall",
      start_date: "2026-10-01",
    });
    const clock = new Date("2026-09-07T02:00:00Z");
    const input = {
      version: 1,
      name: "Two payments",
      role: "Free Agent",
      fee_type: "Percentage",
      fee_value: 250,
      installments: [
        { due_date: "2026-09-07", amount_cents: 1001 },
        { due_date: "2026-10-01", amount_cents: 999 },
      ],
    };
    const saved = savePaymentPlan(
      db,
      actor,
      program.id,
      input,
      undefined,
      clock,
    );
    const snapshot = installmentSnapshot(saved.plans[0]);
    assert.equal(snapshot.total_cents, 2050);
    assert.equal(snapshot.installments[0].fee_cents, 25);
    const edited = savePaymentPlan(
      db,
      actor,
      program.id,
      { ...input, version: 2, fee_type: "Fixed", fee_value: 100 },
      saved.plans[0].id,
      clock,
    );
    assert.equal(installmentSnapshot(edited.plans[0]).total_cents, 2200);
    assert.equal(snapshot.total_cents, 2050);
    assert.equal(snapshot.plan_version, 1);
    assert.equal(edited.plans[0].version, 2);
    assert.throws(
      () => savePaymentPlan(db, actor, program.id, input, undefined, clock),
      (e) => e.status === 409,
    );
    assert.throws(() =>
      programPaymentPlans(db, { ...actor, org_id: "other" }, program.id),
    );
    assert.throws(
      () =>
        savePaymentPlan(
          db,
          actor,
          program.id,
          {
            ...input,
            version: 3,
            installments: [{ due_date: "2026-09-06", amount_cents: 100 }],
          },
          undefined,
          clock,
        ),
      /future/,
    );
    assert.throws(() =>
      savePaymentPlan(
        db,
        actor,
        program.id,
        { ...input, version: 3, strictly_enforce_first_payment: true },
        undefined,
        clock,
      ),
    );
    assert.throws(
      () =>
        savePaymentPlan(
          db,
          actor,
          program.id,
          {
            ...input,
            version: 3,
            installments: [...input.installments].reverse(),
          },
          undefined,
          clock,
        ),
      /ordered/,
    );
    assert.equal(programPaymentPlans(db, actor, program.id).version, 3);
  } finally {
    db.close();
  }
});

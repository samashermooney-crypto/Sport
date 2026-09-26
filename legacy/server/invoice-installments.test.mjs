import {
  paymentPlanReport,
  paymentReportRange,
} from "./payment-plan-report.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now } from "./db.mjs";
import {
  saveProgram,
  register,
  recordPayment,
  programStats,
} from "./domain.mjs";
import { savePaymentPlan, deletePaymentPlan } from "./payment-plans.mjs";
import {
  attachInvoicePlan,
  invoiceInstallments,
  allocateInstallments,
  scheduledInvoiceDates,
} from "./invoice-installments.mjs";
test("invoice schedules retain template version, reconcile payments, and enforce conversion boundaries", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
    ).run();
    const actor = { id: "admin", org_id: "org" },
      clock = new Date("2026-09-07T12:00:00Z");
    const program = saveProgram(db, actor, {
      name: "League",
      type: "League",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "All",
      season: "Fall",
      start_date: "2026-10-01",
      fee_cents: 2000,
    });
    const person = id();
    db.prepare(
      "INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES(?,?,?,?,?)",
    ).run(person, "org", "Demo", "Player", now());
    const registration = register(db, actor, {
      program_id: program.id,
      person_id: person,
    });
    const input = {
      version: 1,
      name: "Two dues",
      role: "Free Agent",
      installments: [
        { due_date: "2026-10-01", amount_cents: 1000 },
        { due_date: "2026-11-01", amount_cents: 1000 },
      ],
    };
    const plan = savePaymentPlan(db, actor, program.id, input, undefined, clock)
      .plans[0];
    const conversion = { plan_id: plan.id, plan_version: 1 };
    assert.throws(() =>
      attachInvoicePlan(
        db,
        { ...actor, org_id: "other" },
        registration.invoice_id,
        conversion,
        clock,
      ),
    );
    assert.throws(
      () =>
        attachInvoicePlan(
          db,
          actor,
          registration.invoice_id,
          { ...conversion, plan_version: 2 },
          clock,
        ),
      (e) => e.status === 409,
    );
    const assigned = attachInvoicePlan(
      db,
      actor,
      registration.invoice_id,
      conversion,
      clock,
    );
    assert.deepEqual(
      attachInvoicePlan(db, actor, registration.invoice_id, conversion, clock),
      assigned,
    );
    savePaymentPlan(
      db,
      actor,
      program.id,
      {
        ...input,
        version: 2,
        installments: [{ due_date: "2026-12-01", amount_cents: 2000 }],
      },
      plan.id,
      clock,
    );
    assert.throws(
      () => deletePaymentPlan(db, actor, program.id, plan.id, { version: 1 }),
      (e) => e.status === 409,
    );
    assert.throws(() =>
      deletePaymentPlan(
        db,
        { ...actor, org_id: "other" },
        program.id,
        plan.id,
        { version: 3 },
      ),
    );
    assert.deepEqual(
      deletePaymentPlan(db, actor, program.id, plan.id, { version: 3 }),
      { version: 4, plans: [] },
    );
    assert.equal(
      invoiceInstallments(db, "org", registration.invoice_id).plan_id,
      plan.id,
    );
    const payment = {
      amount_cents: 500,
      method: "Cash",
      idempotency_key: "installment-payment-one",
    };
    recordPayment(db, actor, registration.invoice_id, payment);
    recordPayment(db, actor, registration.invoice_id, payment);
    const read = invoiceInstallments(db, "org", registration.invoice_id);
    assert.equal(read.plan_version, 1);
    assert.equal(read.installments.length, 2);
    assert.deepEqual(
      read.installments.map((i) => i.balance_cents),
      [500, 1000],
    );
    assert.deepEqual(
      allocateInstallments(assigned, 800, 300).map((i) => i.balance_cents),
      [500, 700],
    );
    assert.equal(
      scheduledInvoiceDates(db, "org", new Date("2026-11-01T12:00:00Z")).get(
        registration.invoice_id,
      ).due_today_cents,
      1000,
    );
    const report = paymentPlanReport(
      db,
      "org",
      { period: "Custom Range", from: "2026-10-01", to: "2026-11-01" },
      clock,
    );
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].total_due, 1000);
    assert.equal(report.rows[0].total_paid, 500);
    assert.equal(report.rows[0].total_outstanding, 500);
    assert.equal(report.rows[0].installments_outstanding, 1);
    assert.equal(report.rows[0].details[0].invoice_id, registration.invoice_id);
    assert.equal(paymentPlanReport(db, "other", {}, clock).rows.length, 0);
    const october = new Date("2026-10-15T12:00:00Z");
    assert.equal(
      scheduledInvoiceDates(db, "org", october).get(registration.invoice_id)
        .overdue_cents,
      500,
    );
    assert.equal(programStats(db, "org", october)[0].overdue, 500);
    recordPayment(db, actor, registration.invoice_id, {
      ...payment,
      idempotency_key: "installment-payment-two",
    });
    assert.equal(
      scheduledInvoiceDates(db, "org", october).get(registration.invoice_id)
        .due_date,
      "2026-11-01",
    );
    assert.equal(programStats(db, "org", october)[0].overdue, 0);
    recordPayment(db, actor, registration.invoice_id, {
      ...payment,
      amount_cents: 1000,
      idempotency_key: "installment-payment-final",
    });
    assert.equal(
      scheduledInvoiceDates(db, "org", october).get(registration.invoice_id)
        .due_date,
      "",
    );
    db.prepare("UPDATE invoices SET voided=1 WHERE id=?").run(
      registration.invoice_id,
    );
    assert.deepEqual(
      invoiceInstallments(db, "org", registration.invoice_id).installments.map(
        (i) => i.balance_cents,
      ),
      [0, 0],
    );
    const second = id();
    db.prepare(
      "INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES(?,?,?,?,?)",
    ).run(second, "org", "Second", "Player", now());
    const secondReg = register(db, actor, {
      program_id: program.id,
      person_id: second,
    });
    const restoredPlan = savePaymentPlan(
      db,
      actor,
      program.id,
      { ...input, version: 4 },
      undefined,
      clock,
    ).plans[0];
    attachInvoicePlan(
      db,
      actor,
      secondReg.invoice_id,
      { plan_id: restoredPlan.id, plan_version: 1 },
      clock,
    );
    const futurePayment = {
      amount_cents: 1000,
      method: "Cash",
      idempotency_key: "selected-future-installment",
      installment_position: 2,
    };
    recordPayment(db, actor, secondReg.invoice_id, futurePayment);
    recordPayment(db, actor, secondReg.invoice_id, futurePayment);
    assert.deepEqual(
      invoiceInstallments(db, "org", secondReg.invoice_id).installments.map(
        (row) => row.balance_cents,
      ),
      [1000, 0],
    );
    assert.throws(
      () =>
        recordPayment(db, actor, secondReg.invoice_id, {
          ...futurePayment,
          installment_position: 1,
        }),
      (e) => e.status === 409,
    );
    assert.throws(
      () =>
        recordPayment(db, actor, secondReg.invoice_id, {
          ...futurePayment,
          idempotency_key: "selected-overpayment",
        }),
      /selected/,
    );
    const november = paymentPlanReport(
      db,
      "org",
      { period: "Custom Range", from: "2026-11-01", to: "2026-12-01" },
      clock,
    );
    assert.equal(november.rows[0].total_paid, 1000);
    assert.equal(november.rows[0].total_outstanding, 0);
  } finally {
    db.close();
  }
});

test("payment report ranges use exclusive ends, calendar months, Monday weeks and 93-day limit", () => {
  assert.deepEqual(paymentReportRange({ period: "Last Month" }, "2024-03-15"), {
    period: "Last Month",
    from: "2024-02-01",
    to: "2024-03-01",
  });
  assert.equal(
    paymentReportRange({ period: "This Week" }, "2026-09-13").from,
    "2026-09-07",
  );
  assert.equal(
    paymentReportRange({ period: "Today" }, "2026-12-31").to,
    "2027-01-01",
  );
  assert.throws(
    () =>
      paymentReportRange(
        { period: "Custom Range", from: "2026-01-01", to: "2026-05-01" },
        "2026-01-01",
      ),
    /93/,
  );
  assert.throws(
    () =>
      paymentReportRange(
        { period: "Custom Range", from: "2026-01-01", to: "2026-01-01" },
        "2026-01-01",
      ),
    /93/,
  );
});

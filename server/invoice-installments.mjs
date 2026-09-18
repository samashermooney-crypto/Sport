import { z } from "zod";
import { audit, now, transaction } from "./db.mjs";
import { requireEntity } from "./domain.mjs";
import { programPaymentPlans, installmentSnapshot } from "./payment-plans.mjs";
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
export function allocateInstallments(
  snapshot,
  paidCents,
  creditCents = 0,
  assigned = {},
) {
  const rows = snapshot.installments.map((row) => ({
    ...row,
    paid_cents: 0,
    balance_cents: row.total_cents,
  }));
  let assignedTotal = 0;
  for (const row of rows) {
    const amount = Math.min(assigned[row.position] || 0, row.balance_cents);
    row.paid_cents += amount;
    row.balance_cents -= amount;
    assignedTotal += amount;
  }
  // Legacy unassigned payments settle earliest dues; administrator credits settle latest dues first.
  let payment = Math.max(0, paidCents - creditCents - assignedTotal);
  for (const row of rows) {
    const amount = Math.min(payment, row.balance_cents);
    row.paid_cents += amount;
    row.balance_cents -= amount;
    payment -= amount;
  }
  let credit = creditCents;
  for (const row of [...rows].reverse()) {
    const amount = Math.min(credit, row.balance_cents);
    row.paid_cents += amount;
    row.balance_cents -= amount;
    credit -= amount;
  }
  return rows;
}
export function invoiceInstallments(db, orgId, invoiceId) {
  const invoice = requireEntity(db, "invoices", invoiceId, orgId);
  const stored = db
    .prepare(
      "SELECT snapshot FROM invoice_payment_plans WHERE invoice_id=? AND org_id=?",
    )
    .get(invoiceId, orgId);
  if (!stored) return null;
  const snapshot = JSON.parse(stored.snapshot);
  const credits = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents),0) amount FROM credit_applications WHERE invoice_id=? AND org_id=?",
    )
    .get(invoiceId, orgId).amount;
  return {
    ...snapshot,
    voided: !!invoice.voided,
    installments: allocateInstallments(
      snapshot,
      invoice.paid_cents,
      credits,
      paymentAllocations(db, orgId).get(invoiceId) || {},
    ).map((row) => ({
      ...row,
      balance_cents: invoice.voided ? 0 : row.balance_cents,
    })),
  };
}
export function attachInvoicePlan(
  db,
  actor,
  invoiceId,
  input,
  clock = new Date(),
) {
  const { plan_id, plan_version } = z
    .object({
      plan_id: z.string().min(1),
      plan_version: z.number().int().positive(),
    })
    .parse(input);
  return transaction(db, () => {
    const invoice = requireEntity(db, "invoices", invoiceId, actor.org_id);
    const existing = invoiceInstallments(db, actor.org_id, invoiceId);
    if (existing) {
      if (
        existing.plan_id === plan_id &&
        existing.plan_version === plan_version
      )
        return existing;
      fail("This invoice already has an installment schedule", 409);
    }
    if (invoice.voided || invoice.paid_cents !== 0)
      fail("Select an unpaid, nonvoid invoice for conversion");
    const registration = db
      .prepare(
        "SELECT role FROM registrations WHERE invoice_id=? AND org_id=? AND status!='Canceled'",
      )
      .get(invoiceId, actor.org_id);
    if (!registration || !invoice.program_id)
      fail("Only active program registration invoices can be converted");
    const plan = programPaymentPlans(db, actor, invoice.program_id).plans.find(
      (p) => p.id === plan_id,
    );
    if (!plan) fail("Payment plan not found", 404);
    if (plan.version !== plan_version)
      fail("The payment plan changed. Reload before converting.", 409);
    const role = ["Free Agent", "Team Player"].includes(registration.role)
      ? registration.role
      : "Program Staff";
    if (plan.role !== role)
      fail("Plan registration type does not match this invoice");
    if (plan.require_autopay)
      fail(
        "Auto Pay enrollment must be implemented before assigning this plan",
      );
    const snapshot = installmentSnapshot(plan);
    if (snapshot.total_cents !== invoice.total_cents)
      fail("Plan total must match this invoice before conversion");
    const { timezone } = db
      .prepare("SELECT timezone FROM organizations WHERE id=?")
      .get(actor.org_id);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(clock);
    if (snapshot.installments.some((row) => row.due_date <= today))
      fail("Choose a plan with future installment dates");
    db.prepare("INSERT INTO invoice_payment_plans VALUES(?,?,?,?)").run(
      invoiceId,
      actor.org_id,
      JSON.stringify(snapshot),
      now(),
    );
    audit(db, actor, "assign_payment_plan", "invoice", invoiceId, {
      plan_id,
      plan_version,
    });
    return invoiceInstallments(db, actor.org_id, invoiceId);
  });
}
export function installInvoiceInstallmentRoutes(app, db) {
  app.post("/api/invoices/:id/payment-plan", (req, res) =>
    res
      .status(201)
      .json(attachInvoicePlan(db, req.actor, req.params.id, req.body)),
  );
}

export function installmentDueFields(
  invoice,
  snapshot,
  credits,
  today,
  assigned = {},
) {
  const balance = invoice.voided ? 0 : invoice.total_cents - invoice.paid_cents;
  if (!snapshot)
    return {
      due_date: invoice.due_date,
      overdue_cents:
        balance > 0 && invoice.due_date && invoice.due_date < today
          ? balance
          : 0,
    };
  const rows = allocateInstallments(
    snapshot,
    invoice.paid_cents,
    credits,
    assigned,
  );
  const unpaid = invoice.voided
    ? []
    : rows.filter((row) => row.balance_cents > 0);
  return {
    due_date: unpaid[0]?.due_date || "",
    due_today_cents: unpaid
      .filter((row) => row.due_date === today)
      .reduce((sum, row) => sum + row.balance_cents, 0),
    overdue_cents: unpaid
      .filter((row) => row.due_date < today)
      .reduce((sum, row) => sum + row.balance_cents, 0),
  };
}
export function scheduledInvoiceDates(db, orgId, clock = new Date()) {
  const org = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(orgId);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: org?.timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
  const rows = db
    .prepare(
      `SELECT i.*,s.snapshot,COALESCE(c.credits,0) credits FROM invoice_payment_plans s JOIN invoices i ON i.id=s.invoice_id AND i.org_id=s.org_id LEFT JOIN (SELECT invoice_id,SUM(amount_cents) credits FROM credit_applications WHERE org_id=? GROUP BY invoice_id) c ON c.invoice_id=i.id WHERE s.org_id=?`,
    )
    .all(orgId, orgId);
  const allocations = paymentAllocations(db, orgId);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        ...installmentDueFields(
          row,
          JSON.parse(row.snapshot),
          row.credits,
          today,
          allocations.get(row.id) || {},
        ),
        program_id: row.program_id,
      },
    ]),
  );
}

export function paymentAllocations(db, orgId) {
  const result = new Map();
  for (const row of db
    .prepare(
      "SELECT invoice_id,allocations FROM installment_payment_allocations WHERE org_id=?",
    )
    .all(orgId)) {
    const values = result.get(row.invoice_id) || {};
    for (const allocation of JSON.parse(row.allocations))
      values[allocation.position] =
        (values[allocation.position] || 0) + allocation.amount_cents;
    result.set(row.invoice_id, values);
  }
  return result;
}
export function prepareInstallmentPayment(
  db,
  orgId,
  invoiceId,
  amount,
  position,
) {
  const schedule = invoiceInstallments(db, orgId, invoiceId);
  if (!schedule) {
    if (position) fail("This invoice does not have installments");
    return null;
  }
  const rows = position
    ? schedule.installments.filter((row) => row.position === position)
    : schedule.installments;
  if (rows.reduce((sum, row) => sum + row.balance_cents, 0) < amount)
    fail("Payment exceeds the selected installment balance");
  let remaining = amount;
  return rows.flatMap((row) => {
    const paid = Math.min(remaining, row.balance_cents);
    remaining -= paid;
    return paid ? [{ position: row.position, amount_cents: paid }] : [];
  });
}

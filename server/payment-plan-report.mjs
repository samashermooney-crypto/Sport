import { z } from "zod";
import {
  allocateInstallments,
  paymentAllocations,
} from "./invoice-installments.mjs";
const day = 86400000;
const iso = (date) => date.toISOString().slice(0, 10);
const shift = (date, n) => new Date(date.getTime() + n * day);
export const paymentPeriods = [
  "This Month",
  "Last Month",
  "Next Month",
  "This Week",
  "Last Week",
  "Next Week",
  "Last 7 Days",
  "Next 7 Days",
  "Last 30 Days",
  "Next 30 Days",
  "Today",
  "Custom Range",
];
export function paymentReportRange(input, today) {
  const period = z.enum(paymentPeriods).parse(input.period || "This Month");
  const date = new Date(today + "T00:00:00Z");
  let from, to;
  if (period.includes("Month")) {
    const offset =
      period === "Last Month" ? -1 : period === "Next Month" ? 1 : 0;
    from = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1),
    );
    to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  } else if (period.includes("Week")) {
    const offset = period === "Last Week" ? -7 : period === "Next Week" ? 7 : 0;
    from = shift(date, -((date.getUTCDay() + 6) % 7) + offset);
    to = shift(from, 7);
  } else if (period === "Custom Range") {
    from = new Date(z.iso.date().parse(input.from) + "T00:00:00Z");
    to = new Date(z.iso.date().parse(input.to) + "T00:00:00Z");
  } else if (period === "Today") {
    from = date;
    to = shift(date, 1);
  } else {
    const count = period.includes("30") ? 30 : 7;
    from = period.startsWith("Last") ? shift(date, -count) : date;
    to = period.startsWith("Last") ? date : shift(date, count);
  }
  if (to <= from || to - from > 93 * day)
    throw Object.assign(new Error("Choose a date range of 1 to 93 days"), {
      status: 400,
    });
  return { period, from: iso(from), to: iso(to) };
}
export function paymentPlanReport(db, orgId, input = {}, clock = new Date()) {
  const org = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(orgId);
  if (!org)
    throw Object.assign(new Error("Organization not found"), { status: 404 });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: org.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
  const range = paymentReportRange(input, today),
    groups = new Map();
  const invoices = db
    .prepare(
      `SELECT i.*,s.snapshot,p.name program_name,p.data program_data,m.first_name||' '||m.last_name registrant_name,COALESCE(c.amount,0) credits FROM invoice_payment_plans s JOIN invoices i ON i.id=s.invoice_id AND i.org_id=s.org_id JOIN programs p ON p.id=i.program_id AND p.org_id=i.org_id JOIN people m ON m.id=i.person_id AND m.org_id=i.org_id LEFT JOIN (SELECT invoice_id,SUM(amount_cents) amount FROM credit_applications WHERE org_id=? GROUP BY invoice_id) c ON c.invoice_id=i.id WHERE s.org_id=? AND i.voided=0`,
    )
    .all(orgId, orgId);
  const allocations = paymentAllocations(db, orgId);
  for (const invoice of invoices) {
    const plan = JSON.parse(invoice.snapshot);
    for (const row of allocateInstallments(
      plan,
      invoice.paid_cents,
      invoice.credits,
      allocations.get(invoice.id) || {},
    )) {
      if (row.due_date < range.from || row.due_date >= range.to) continue;
      const key = JSON.stringify([
        invoice.program_id,
        plan.plan_id,
        plan.name,
        row.due_date,
      ]);
      let group = groups.get(key);
      if (!group) {
        group = {
          id: key,
          due_date: row.due_date,
          program_id: invoice.program_id,
          program_name: invoice.program_name,
          program_code: JSON.parse(invoice.program_data || "{}").code || "",
          plan_name: plan.name,
          autopay: !!plan.require_autopay,
          total_due: 0,
          total_paid: 0,
          total_outstanding: 0,
          installments_due: 0,
          installments_paid: 0,
          installments_outstanding: 0,
          details: [],
        };
        groups.set(key, group);
      }
      group.total_due += row.total_cents;
      group.total_paid += row.paid_cents;
      group.total_outstanding += row.balance_cents;
      group.installments_due++;
      group[
        row.balance_cents === 0
          ? "installments_paid"
          : "installments_outstanding"
      ]++;
      group.details.push({
        id: invoice.id + ":" + row.position,
        invoice_id: invoice.id,
        invoice_number: invoice.number,
        person_id: invoice.person_id,
        registrant_name: invoice.registrant_name,
        amount_due: row.total_cents,
        amount_paid: row.paid_cents,
        outstanding: row.balance_cents,
      });
    }
  }
  return {
    ...range,
    rows: [...groups.values()].sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date) ||
        a.program_name.localeCompare(b.program_name) ||
        a.plan_name.localeCompare(b.plan_name),
    ),
  };
}
export function installPaymentPlanReportRoutes(app, db) {
  app.get("/api/reports/payment-plans", (req, res) =>
    res.json(paymentPlanReport(db, req.actor.org_id, req.query)),
  );
}

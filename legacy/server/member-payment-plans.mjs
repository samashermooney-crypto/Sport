import { programPaymentPlans, installmentSnapshot } from "./payment-plans.mjs";
import { audit, now } from "./db.mjs";
import { DomainError } from "./domain.mjs";
export function enrollmentPlans(db, orgId, context, code = "") {
  if (!context.rules.enable_payment_plans || context.isStaff) return [];
  return programPaymentPlans(db, { org_id: orgId }, context.program.id)
    .plans.filter(
      (plan) =>
        plan.role === "Free Agent" &&
        (!plan.private_code || plan.private_code === code) &&
        plan.installments.every((row) => row.due_date > context.today),
    )
    .map((plan) => {
      const used = db
        .prepare(
          "SELECT COUNT(*) n FROM invoice_payment_plans WHERE org_id=? AND json_extract(snapshot,'$.plan_id')=?",
        )
        .get(orgId, plan.id).n;
      const snapshot = installmentSnapshot(plan);
      return {
        ...snapshot,
        available: !(
          plan.require_autopay ||
          plan.require_first_payment ||
          snapshot.total_cents === 0 ||
          (plan.redemption_limit !== null && used >= plan.redemption_limit)
        ),
        unavailable_reason:
          plan.require_autopay || plan.require_first_payment
            ? "Online payment enrollment is not available for this plan."
            : snapshot.total_cents === 0
              ? "Use the pay-in-full option for a free registration."
              : plan.redemption_limit !== null && used >= plan.redemption_limit
                ? "This plan has reached its redemption limit."
                : "",
      };
    });
}
export function selectEnrollmentPlan(db, orgId, context, input) {
  if (!input.payment_plan_id) return null;
  const plan = enrollmentPlans(
    db,
    orgId,
    context,
    input.private_plan_code || "",
  ).find((plan) => plan.plan_id === input.payment_plan_id);
  if (!plan || !plan.available)
    throw new DomainError(
      plan?.unavailable_reason || "This payment plan is not available",
      409,
    );
  if (plan.plan_version !== input.payment_plan_version)
    throw new DomainError(
      "Payment plan changed. Review registration again.",
      409,
    );
  const { available, unavailable_reason, ...snapshot } = plan;
  return snapshot;
}
export function discountedSchedule(snapshot, total) {
  const rows = snapshot.installments.map((row) => ({ ...row }));
  let remaining = snapshot.total_cents - total;
  if (remaining < 0)
    throw new DomainError("Invoice total exceeds payment plan total");
  while (remaining > 0) {
    const active = rows.filter((row) => row.total_cents > 0);
    if (!active.length) throw new DomainError("Invalid payment plan discount");
    const each = Math.floor(remaining / active.length),
      extra = remaining % active.length;
    let applied = 0;
    active.forEach((row, index) => {
      const discount = Math.min(
        row.total_cents,
        each + (index < extra ? 1 : 0),
      );
      row.discount_cents = (row.discount_cents || 0) + discount;
      row.total_cents -= discount;
      applied += discount;
    });
    remaining -= applied;
  }
  return { ...snapshot, total_cents: total, installments: rows };
}
export function persistEnrollmentPlan(db, actor, registration, snapshot) {
  if (!snapshot || !registration.invoice_id) return;
  const invoice = db
    .prepare("SELECT total_cents FROM invoices WHERE id=? AND org_id=?")
    .get(registration.invoice_id, actor.org_id);
  const captured = discountedSchedule(snapshot, invoice.total_cents);
  db.prepare("INSERT INTO invoice_payment_plans VALUES(?,?,?,?)").run(
    registration.invoice_id,
    actor.org_id,
    JSON.stringify(captured),
    now(),
  );
  audit(db, actor, "select_payment_plan", "registration", registration.id, {
    plan_id: snapshot.plan_id,
    plan_version: snapshot.plan_version,
  });
}

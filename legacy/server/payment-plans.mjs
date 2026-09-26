import { z } from "zod";
import { audit, id, transaction } from "./db.mjs";
import { requireEntity } from "./domain.mjs";
const cents = z.number().int().min(0).max(100000000);
const installment = z.object({
  due_date: z.iso.date(),
  amount_cents: cents,
  fee_cents: cents.default(0),
});
const planSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(["Free Agent", "Team Player", "Program Staff"]),
    require_first_payment: z.boolean().default(false),
    strictly_enforce_first_payment: z.boolean().default(false),
    require_autopay: z.boolean().default(false),
    private_code: z.string().trim().max(100).default(""),
    redemption_limit: z.number().int().positive().nullable().default(null),
    fee_type: z.enum(["Fixed", "Percentage"]).default("Fixed"),
    fee_value: z.number().int().min(0).max(1000000).default(0),
    installments: z.array(installment).min(1).max(120),
  })
  .superRefine((v, ctx) => {
    if (v.strictly_enforce_first_payment && !v.require_first_payment)
      ctx.addIssue({
        code: "custom",
        message:
          "Strict enforcement requires first payment during registration",
      });
    if (v.redemption_limit !== null && !v.private_code)
      ctx.addIssue({
        code: "custom",
        message: "A redemption limit requires a private plan code",
      });
  });
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
export function programPaymentPlans(db, actor, programId) {
  requireEntity(db, "programs", programId, actor.org_id);
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope=? AND key='payment-plans'",
    )
    .get(actor.org_id, "program:" + programId);
  return row ? JSON.parse(row.value) : { version: 1, plans: [] };
}
export function installmentSnapshot(plan) {
  const rows = plan.installments.map((row, index) => {
    // Percentage values are basis points; round each installment to a whole cent.
    const processing =
      plan.fee_type === "Percentage"
        ? Math.round((row.amount_cents * plan.fee_value) / 10000)
        : plan.fee_value;
    const fee = row.fee_cents + processing;
    return {
      position: index + 1,
      due_date: row.due_date,
      amount_cents: row.amount_cents,
      fee_cents: fee,
      total_cents: row.amount_cents + fee,
    };
  });
  const total_cents = rows.reduce((sum, row) => sum + row.total_cents, 0);
  if (!Number.isSafeInteger(total_cents) || total_cents > 100000000)
    fail("Plan total exceeds the supported invoice amount");
  return {
    plan_id: plan.id,
    plan_version: plan.version,
    name: plan.name,
    role: plan.role,
    require_first_payment: plan.require_first_payment,
    strictly_enforce_first_payment: plan.strictly_enforce_first_payment,
    require_autopay: plan.require_autopay,
    total_cents,
    installments: rows,
  };
}
export function savePaymentPlan(
  db,
  actor,
  programId,
  input,
  planId,
  clock = new Date(),
) {
  const expected = z.number().int().positive().parse(input.version);
  const plan = planSchema.parse(input);
  const org = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(actor.org_id);
  if (!org) fail("Organization not found", 404);
  const localDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: org.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
  if (plan.installments.some((row) => row.due_date <= localDay))
    fail("Installment dates must be in the future");
  for (let n = 1; n < plan.installments.length; n++)
    if (plan.installments[n].due_date < plan.installments[n - 1].due_date)
      fail("Installments must be ordered by due date");
  return transaction(db, () => {
    const current = programPaymentPlans(db, actor, programId);
    if (current.version !== expected)
      fail("Payment plans changed. Reload before saving.", 409);
    const previous = planId ? current.plans.find((p) => p.id === planId) : null;
    if (planId && !previous) fail("Payment plan not found", 404);
    if (
      current.plans.some(
        (p) =>
          p.id !== planId && p.name.toLowerCase() === plan.name.toLowerCase(),
      )
    )
      fail("Payment plan names must be unique");
    if (
      plan.private_code &&
      current.plans.some(
        (p) => p.id !== planId && p.private_code === plan.private_code,
      )
    )
      fail("Private plan codes must be unique");
    const next = {
      ...plan,
      id: planId || id(),
      version: (previous?.version || 0) + 1,
    };
    installmentSnapshot(next);
    const value = {
      version: current.version + 1,
      plans: previous
        ? current.plans.map((p) => (p.id === planId ? next : p))
        : [...current.plans, next],
    };
    db.prepare(
      "INSERT INTO settings(org_id,scope,key,value) VALUES(?,?,'payment-plans',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(actor.org_id, "program:" + programId, JSON.stringify(value));
    audit(db, actor, previous ? "update" : "create", "payment-plan", next.id, {
      program_id: programId,
      version: next.version,
    });
    return value;
  });
}
export function installPaymentPlanRoutes(app, db) {
  app.delete("/api/programs/:id/payment-plans/:planId", (req, res) =>
    res.json(
      deletePaymentPlan(
        db,
        req.actor,
        req.params.id,
        req.params.planId,
        req.body,
      ),
    ),
  );
  app.get("/api/programs/:id/payment-plans", (req, res) =>
    res.json(programPaymentPlans(db, req.actor, req.params.id)),
  );
  app.post("/api/programs/:id/payment-plans", (req, res) =>
    res
      .status(201)
      .json(savePaymentPlan(db, req.actor, req.params.id, req.body)),
  );
  app.put("/api/programs/:id/payment-plans/:planId", (req, res) =>
    res.json(
      savePaymentPlan(
        db,
        req.actor,
        req.params.id,
        req.body,
        req.params.planId,
      ),
    ),
  );
}

export function deletePaymentPlan(db, actor, programId, planId, input) {
  const version = z.number().int().positive().parse(input.version);
  return transaction(db, () => {
    const current = programPaymentPlans(db, actor, programId);
    if (current.version !== version)
      fail("Payment plans changed. Reload before deleting.", 409);
    if (!current.plans.some((plan) => plan.id === planId))
      fail("Payment plan not found", 404);
    const value = {
      version: current.version + 1,
      plans: current.plans.filter((plan) => plan.id !== planId),
    };
    db.prepare(
      "UPDATE settings SET value=? WHERE org_id=? AND scope=? AND key='payment-plans'",
    ).run(JSON.stringify(value), actor.org_id, "program:" + programId);
    // Invoice schedules hold independent snapshots and must survive template removal.
    audit(db, actor, "delete", "payment-plan", planId, {
      program_id: programId,
    });
    return value;
  });
}

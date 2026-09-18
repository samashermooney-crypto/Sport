import { teamCompletionSchema } from "./team-completion.mjs";
import { isStaffRole } from "./staff-roles.mjs";
import { z } from "zod";
import { cleanHtml } from "./html.mjs";
import { audit, now, transaction, unpack } from "./db.mjs";
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const date = z.union([z.iso.date(), z.literal("")]).default("");
const limit = z.number().int().positive().nullable().default(null);
export const captainPermissionSchema = z.object({
  edit_name: z.boolean().default(false),
  invite_players: z.boolean().default(false),
  accept_registrations: z.boolean().default(false),
  add_players: z.boolean().default(false),
});
export const rulesSchema = z
  .object({
    use_site_defaults: z.boolean().default(false),
    team_completion: teamCompletionSchema.default({
      min_players: 0,
      min_male: 0,
      min_female: 0,
      payment: "None",
    }),
    enable_payment_plans: z.boolean().default(false),
    captain_permissions: captainPermissionSchema.default({
      edit_name: false,
      invite_players: false,
      accept_registrations: false,
      add_players: false,
    }),
    allow_free_agents: z.boolean().default(true),
    allow_team_players: z.boolean().default(true),
    allow_staff: z.boolean().default(true),
    min_age: z.number().int().min(0).max(120).nullable().default(null),
    max_age: z.number().int().min(0).max(120).nullable().default(null),
    age_as_of: date,
    capacity_includes_pending: z.boolean().default(true),
    male_capacity: limit,
    female_capacity: limit,
    require_paid_invoices: z.boolean().default(false),
    allow_discounts: z.boolean().default(true),
    require_waiver: z.boolean().default(false),
    early_fee_cents: z
      .number()
      .int()
      .min(0)
      .max(100000000)
      .nullable()
      .default(null),
    early_ends: date,
    late_fee_cents: z
      .number()
      .int()
      .min(0)
      .max(100000000)
      .nullable()
      .default(null),
    late_starts: date,
    deadline_mode: z
      .enum(["Activity start", "During registration", "Date", "None"])
      .default("Activity start"),
    deadline_date: date,
    success_message: z.string().max(10000).default(""),
    skipped_message: z.string().max(10000).default(""),
    abandoned_message: z.string().max(10000).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.min_age !== null && v.max_age !== null && v.min_age > v.max_age)
      ctx.addIssue({
        code: "custom",
        message: "Minimum age must not exceed maximum age",
      });
    if (v.deadline_mode === "Date" && !v.deadline_date)
      ctx.addIssue({
        code: "custom",
        message: "Choose a payment deadline date",
      });
    if (v.early_fee_cents !== null && !v.early_ends)
      ctx.addIssue({
        code: "custom",
        message: "Choose when early-bird pricing ends",
      });
    if (v.late_fee_cents !== null && !v.late_starts)
      ctx.addIssue({
        code: "custom",
        message: "Choose when late pricing starts",
      });
    if (
      v.early_fee_cents !== null &&
      v.late_fee_cents !== null &&
      v.early_ends &&
      v.late_starts &&
      v.early_ends >= v.late_starts
    )
      ctx.addIssue({
        code: "custom",
        message: "Early and late pricing periods must not overlap",
      });
  });
const defaults = rulesSchema.parse({});
export function getRules(db, orgId, program) {
  const site = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope='site' AND key='registration'",
    )
    .get(orgId);
  const local = program
    ? db
        .prepare(
          "SELECT value FROM settings WHERE org_id=? AND scope=? AND key='registration'",
        )
        .get(orgId, "program:" + program.id)
    : null;
  const siteRules = { ...defaults, ...(site ? JSON.parse(site.value) : {}) },
    localRules = local ? JSON.parse(local.value) : defaults;
  return program
    ? {
        ...defaults,
        ...localRules,
        use_site_defaults: false,
        fee_cents: program.fee_cents,
        capacity: program.capacity,
        waitlist: !!program.waitlist,
      }
    : siteRules;
}
// Defaults are copied, never dynamically inherited by an existing program.
export function snapshotProgramRules(db, orgId, programId, sourceProgram) {
  const rules = rulesSchema.parse(getRules(db, orgId, sourceProgram));
  rules.use_site_defaults = false;
  db.prepare(
    "INSERT INTO settings VALUES(?,?,'registration',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
  ).run(orgId, "program:" + programId, JSON.stringify(rules));
}
export function migrateProgramRuleSnapshots(db) {
  transaction(db, () => {
    for (const program of db.prepare("SELECT id,org_id FROM programs").all()) {
      const stored = db
        .prepare(
          "SELECT value FROM settings WHERE org_id=? AND scope=? AND key='registration'",
        )
        .get(program.org_id, "program:" + program.id);
      if (!stored || JSON.parse(stored.value).use_site_defaults)
        snapshotProgramRules(db, program.org_id, program.id);
    }
  });
}
export function saveRules(db, actor, input, programId) {
  const rules = rulesSchema.parse(input);
  rules.use_site_defaults = false;
  for (const key of ["success_message", "skipped_message", "abandoned_message"])
    rules[key] = cleanHtml(rules[key]);
  return transaction(db, () => {
    let program = null;
    if (programId) {
      program = db
        .prepare("SELECT * FROM programs WHERE id=? AND org_id=?")
        .get(programId, actor.org_id);
      if (!program) throw fail("Program not found", 404);
      const pricing = z
        .object({
          fee_cents: z.number().int().min(0).max(100000000),
          capacity: limit,
          waitlist: z.boolean(),
        })
        .parse(input);
      db.prepare(
        "UPDATE programs SET fee_cents=?,capacity=?,waitlist=?,updated_at=? WHERE id=? AND org_id=?",
      ).run(
        pricing.fee_cents,
        pricing.capacity,
        +pricing.waitlist,
        now(),
        programId,
        actor.org_id,
      );
      program = { ...program, ...pricing };
    }
    db.prepare(
      "INSERT INTO settings VALUES(?,?,'registration',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(
      actor.org_id,
      programId ? "program:" + programId : "site",
      JSON.stringify(rules),
    );
    audit(
      db,
      actor,
      "update",
      "registration_rules",
      programId || actor.org_id,
      rules,
    );
    return getRules(db, actor.org_id, program);
  });
}
export function registrationEligibility(
  db,
  orgId,
  program,
  person,
  input,
  rules,
) {
  const isStaff = isStaffRole(input.role);
  if (isStaff && !rules.allow_staff)
    throw fail("Staff registration is disabled for this program");
  if (!isStaff && input.role === "Free Agent" && !rules.allow_free_agents)
    throw fail("Free-agent registration is disabled for this program");
  if (!isStaff && input.role === "Team Player" && !rules.allow_team_players)
    throw fail("Team-player registration is disabled for this program");
  if (!isStaff && (rules.min_age !== null || rules.max_age !== null)) {
    if (!person.birthdate)
      throw fail(
        "Add the member’s birthdate before registering for this age-restricted program",
      );
    const reference = rules.age_as_of || program.start_date,
      [y, m, d] = person.birthdate.split("-").map(Number),
      [year, month, day] = reference.split("-").map(Number),
      age = year - y - (month < m || (month === m && day < d) ? 1 : 0);
    if (
      (rules.min_age !== null && age < rules.min_age) ||
      (rules.max_age !== null && age > rules.max_age)
    )
      throw fail(
        "The member does not meet the age requirements on " + reference,
      );
  }
  if (
    rules.require_paid_invoices &&
    db
      .prepare(
        "SELECT id FROM invoices WHERE person_id=? AND org_id=? AND voided=0 AND paid_cents<total_cents LIMIT 1",
      )
      .get(person.id, orgId)
  )
    throw fail("Outstanding invoices must be paid before another registration");
  if (rules.require_waiver && !input.waiver_accepted)
    throw fail("The registration waiver must be accepted");
  if (!rules.allow_discounts && input.discount_code)
    throw fail("Discount codes are disabled for this program");
}
export function registrationFee(program, rules, today, isStaff) {
  if (isStaff) return 0;
  if (rules.early_fee_cents !== null && today <= rules.early_ends)
    return rules.early_fee_cents;
  if (rules.late_fee_cents !== null && today >= rules.late_starts)
    return rules.late_fee_cents;
  return program.fee_cents;
}
export function installRuleRoutes(app, db) {
  migrateProgramRuleSnapshots(db);
  app.get("/api/settings/registration", (req, res) =>
    res.json(getRules(db, req.actor.org_id)),
  );
  app.put("/api/settings/registration", (req, res) =>
    res.json(saveRules(db, req.actor, req.body)),
  );
  app.get("/api/programs/:id/options", (req, res) => {
    const p = db
      .prepare("SELECT * FROM programs WHERE id=? AND org_id=?")
      .get(req.params.id, req.actor.org_id);
    if (!p) throw fail("Program not found", 404);
    res.json(getRules(db, req.actor.org_id, p));
  });
  app.put("/api/programs/:id/options", (req, res) =>
    res.json(saveRules(db, req.actor, req.body, req.params.id)),
  );
}

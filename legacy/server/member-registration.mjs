import {
  enrollmentPlans,
  selectEnrollmentPlan,
  persistEnrollmentPlan,
} from "./member-payment-plans.mjs";
import {
  requireMemberAddress,
  requireMemberMobile,
  requireSecondaryEmail,
} from "./member-properties.mjs";
import { getStaffRoles } from "./staff-roles.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { unpack } from "./db.mjs";
import { DomainError, register } from "./domain.mjs";
import { publicPrograms } from "./website.mjs";
import { registrationAvailability } from "./registration-availability.mjs";
import { memberFamily } from "./member-auth.mjs";
import {
  accessibleProfile,
  memberProfileForm,
  canReadMemberFile,
} from "./member-profile.mjs";
import {
  registrationFormContext,
  applicableFields,
  validateAnswers,
} from "./forms.mjs";
import { getRules, registrationFee } from "./program-rules.mjs";

const selection = z.object({
  program_id: z.string().min(1),
  person_id: z.string().min(1),
  password: z.string().max(64).default(""),
  role: z.string().min(1).max(80).default("Free Agent"),
});
const digest = (value) => createHash("sha256").update(value).digest();
function enrollment(db, account, input) {
  const p = selection.parse(input);
  if (
    !publicPrograms(db, account.org_id).some(
      (x) => x.id === p.program_id && !x.grouped,
    )
  )
    throw new DomainError("Program not found", 404);
  const isStaff = p.role !== "Free Agent";
  if (
    isStaff &&
    (p.person_id !== account.person_id ||
      !getStaffRoles(db, account.org_id).roles.some(
        (r) => r.name === p.role && r.can_register,
      ))
  )
    throw new DomainError(
      "This staff role is not available for your self-registration.",
      403,
    );
  const program = unpack(
    db
      .prepare("SELECT * FROM programs WHERE id=? AND org_id=?")
      .get(p.program_id, account.org_id),
  );
  const timezone = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(account.org_id).timezone;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  if (!registrationAvailability(program, timezone).open)
    throw new DomainError("Registration is not open for this program.", 409);
  if (
    program.registration_password &&
    !timingSafeEqual(digest(program.registration_password), digest(p.password))
  )
    throw new DomainError(
      "Enter the correct program registration password.",
      403,
    );
  if (
    p.person_id !== account.person_id &&
    !memberFamily(db, account).some(
      (x) => x.id === p.person_id && x.can_register,
    )
  )
    throw new DomainError(
      "You can register yourself or a child in your family account.",
      403,
    );
  const person = accessibleProfile(db, account, p.person_id),
    actor = { ...account, member: true };
  for (const target of new Set([account.person_id, person.id])) {
    const profile = accessibleProfile(db, account, target),
      form = memberProfileForm(db, account, target);
    requireMemberAddress(db, account.org_id, profile);
    requireMemberMobile(db, account.org_id, profile);
    requireSecondaryEmail(db, account.org_id, profile);
    if (!profile.first_name || !profile.last_name || !profile.birthdate)
      throw new DomainError(
        "Complete the participant and guardian profiles before registering.",
      );
    const fields = applicableFields(form, profile, "", today, {
      member: true,
      profile: true,
    }).fields;
    try {
      validateAnswers(
        db,
        account.org_id,
        fields,
        Object.fromEntries(
          fields
            .filter((f) => form.answers[f.id] !== undefined)
            .map((f) => [f.id, form.answers[f.id]]),
        ),
      );
    } catch (e) {
      throw new DomainError(
        `Complete ${profile.first_name}'s profile before registering: ${e.message}`,
      );
    }
  }
  if (
    !isStaff &&
    ["Male", "Female"].includes(program.gender) &&
    person.gender !== program.gender
  )
    throw new DomainError(
      "The participant does not meet this program's gender eligibility. Check the participant profile or contact the organization.",
    );
  const rules = getRules(db, account.org_id, program);
  if (isStaff ? !rules.allow_staff : !rules.allow_free_agents)
    throw new DomainError(
      "Individual registration is not available for this program.",
    );
  const form = registrationFormContext(
    db,
    actor,
    program.id,
    person.id,
    p.role,
  );
  if (!form.signers.length)
    throw new DomainError("An active adult account is required to register.");
  if (rules.require_waiver && !form.waivers.length)
    throw new DomainError(
      "The organization needs to publish its registration waiver before enrollment.",
    );
  return { program, person, actor, rules, form, today, isStaff };
}
export function memberEnrollmentContext(db, account, input) {
  const { program, person, rules, form, today, isStaff } = enrollment(
    db,
    account,
    input,
  );
  return {
    program: {
      id: program.id,
      name: program.name,
      fee_cents: registrationFee(program, rules, today, isStaff),
      waitlist: !isStaff && !!program.waitlist,
    },
    participant: {
      id: person.id,
      name: `${person.first_name} ${person.last_name}`,
    },
    form,
    allow_discounts: !isStaff && rules.allow_discounts,
    payment_plans: enrollmentPlans(
      db,
      account.org_id,
      { program, rules, today, isStaff },
      input.private_plan_code || "",
    ),
  };
}
export function registerMember(db, account, input) {
  let context, selectedPlan;
  const actor = { ...account, member: true };
  const registration = register(
    db,
    actor,
    {
      program_id: input.program_id,
      person_id: input.person_id,
      role: input.role || "Free Agent",
      answers: input.answers,
      form_version: input.form_version,
      waiver_acceptances: input.waiver_acceptances,
      discount_code: input.discount_code,
    },
    {
      priceOverride: () => selectedPlan?.total_cents,
      afterRegister: (registration) =>
        persistEnrollmentPlan(db, actor, registration, selectedPlan),
      beforeRegister: () => {
        context = enrollment(db, account, input);
        const { program, form, rules, today, isStaff } = context;
        selectedPlan = selectEnrollmentPlan(db, account.org_id, context, input);
        if (
          input.expected_fee_cents !==
          (selectedPlan?.total_cents ??
            registrationFee(program, rules, today, isStaff))
        )
          throw new DomainError(
            "The registration price changed. Review registration again.",
            409,
          );
        for (const field of form.fields) {
          const value = input.answers?.[field.id];
          if (
            field.type === "File Upload" &&
            value &&
            (typeof value !== "string" ||
              !canReadMemberFile(db, account, value))
          )
            throw new DomainError(
              "That attachment is not available to your account.",
              403,
            );
        }
      },
    },
  );
  const invoice = registration.invoice_id
    ? db
        .prepare(
          "SELECT id,number,total_cents,paid_cents FROM invoices WHERE id=? AND org_id=?",
        )
        .get(registration.invoice_id, account.org_id)
    : null;
  return {
    id: registration.id,
    status: registration.status,
    program_name: context.program.name,
    participant_name: `${context.person.first_name} ${context.person.last_name}`,
    invoice,
  };
}
export function installMemberRegistrationRoutes(app, db) {
  app.get("/api/member/:org/enrollment-roles", (req, res) => {
    const program = publicPrograms(db, req.member.org_id).find(
      (p) => p.id === req.query.program_id && !p.grouped,
    );
    if (!program) throw new DomainError("Program not found", 404);
    const rules = getRules(db, req.member.org_id, program);
    res.json([
      ...(rules.allow_free_agents ? ["Free Agent"] : []),
      ...(rules.allow_staff
        ? getStaffRoles(db, req.member.org_id)
            .roles.filter((r) => r.can_register)
            .map((r) => r.name)
        : []),
    ]);
  });

  app.get("/api/member/:org/registrations", (req, res) => {
    const rows = db
      .prepare(
        "SELECT r.id,r.person_id,r.status,r.role,r.created_at,p.name program_name,p.id program_id,m.first_name,m.last_name,i.number invoice_number,i.total_cents,i.paid_cents,i.voided FROM registrations r JOIN programs p ON p.id=r.program_id AND p.org_id=r.org_id JOIN people m ON m.id=r.person_id AND m.org_id=r.org_id LEFT JOIN invoices i ON i.id=r.invoice_id AND i.org_id=r.org_id WHERE r.org_id=? ORDER BY r.created_at DESC",
      )
      .all(req.member.org_id)
      .filter((r) => {
        try {
          accessibleProfile(db, req.member, r.person_id, {
            allowArchived: true,
          });
          return true;
        } catch {
          return false;
        }
      });
    res.json(
      rows.map(({ first_name, last_name, ...row }) => ({
        ...row,
        participant_name: `${first_name} ${last_name}`,
      })),
    );
  });
  const attempts = new Map();
  const guard = (req, res, next) => {
    const key = `${req.member.id}:${req.body?.program_id}`,
      time = Date.now();
    if (attempts.size > 1000)
      for (const [k, v] of attempts) if (v.until < time) attempts.delete(k);
    let entry = attempts.get(key);
    if (!entry || entry.until < time) {
      entry = { count: 0, until: time + 60000 };
      attempts.set(key, entry);
    }
    if (++entry.count > 20)
      throw new DomainError(
        "Too many registration attempts. Try again in a minute.",
        429,
      );
    next();
  };
  app.post("/api/member/:org/enrollment", guard, (req, res) =>
    res.json(memberEnrollmentContext(db, req.member, req.body)),
  );
  app.post("/api/member/:org/registrations", guard, (req, res) =>
    res.status(201).json(registerMember(db, req.member, req.body)),
  );
}

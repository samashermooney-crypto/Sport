import { eventTimesOverlap } from "./schedule-time.mjs";
import {
  scheduledInvoiceDates,
  prepareInstallmentPayment,
} from "./invoice-installments.mjs";
import { isStaffRole, validateStaffAssignment } from "./staff-roles.mjs";
import { z } from "zod";
import { id, now, transaction, audit, unpack } from "./db.mjs";
import { gameResultSchema, snapshotStandingsRules } from "./standings.mjs";
import { validateProgramTerminology } from "./terminology.mjs";
import {
  answersSchema,
  acceptanceSchema,
  snapshotProgramForm,
  prepareRegistrationForms,
  persistRegistrationForms,
} from "./forms.mjs";
import {
  getRules,
  captainPermissionSchema,
  registrationEligibility,
  registrationFee,
  snapshotProgramRules,
} from "./program-rules.mjs";
export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Enter a valid calendar date",
  );
const optionalDate = z.union([date, z.literal("")]).default("");
export const programSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum([
      "League",
      "Event",
      "Tournament",
      "Camp",
      "Club team",
      "Class",
    ]),
    sport: z.string().trim().min(1),
    gender: z.enum(["Any gender", "Co-Ed", "Male", "Female"]),
    level: z.string().trim().max(100).default(""),
    season: z.string().trim().max(100).default(""),
    terminology_version: z.number().int().positive().optional(),
    accounting_codes: z.array(z.string().trim().max(100)).max(5).default([]),
    status: z
      .enum(["Unpublished", "Upcoming", "Live", "Completed"])
      .default("Upcoming"),
    grouped: z.boolean().default(false),
    parent_id: z.string().nullable().default(null),
    start_date: date,
    end_date: optionalDate,
    registration_start: optionalDate,
    registration_end: optionalDate,
    fee_cents: z.number().int().min(0).max(100000000).default(0),
    capacity: z.number().int().positive().nullable().default(null),
    waitlist: z.boolean().default(true),
    public: z.boolean().default(true),
    description: z.string().max(10000).default(""),
    audience: z
      .enum(["Youth/Family Accounts", "Adult"])
      .default("Youth/Family Accounts"),
    location_id: z.string().default(""),
    start_visible: z.boolean().default(true),
    end_visible: z.boolean().default(true),
    start_tentative: z.boolean().default(false),
    days: z.array(z.string()).default([]),
    start_time: z.string().default(""),
    end_time: z.string().default(""),
    sponsor: z.string().max(255).default(""),
    host: z.string().max(255).default(""),
    format: z.string().max(255).default(""),
    registration_status: z
      .enum(["", "Open", "Closed", "Coming Soon", "Sold Out"])
      .default(""),
    registration_password: z.string().max(64).default(""),
    code: z.string().max(40).default(""),
    integration_codes: z.array(z.string()).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.end_date && p.end_date < p.start_date)
      ctx.addIssue({
        code: "custom",
        message: "End date must follow start date",
        path: ["end_date"],
      });
    if (
      p.registration_end &&
      p.registration_start &&
      p.registration_end < p.registration_start
    )
      ctx.addIssue({
        code: "custom",
        message: "Registration end must follow registration start",
        path: ["registration_end"],
      });
  });

export function requireEntity(db, table, entityId, orgId) {
  if (
    ![
      "programs",
      "people",
      "teams",
      "invoices",
      "locations",
      "events",
      "households",
      "discounts",
      "credits",
    ].includes(table)
  )
    throw new Error("Unsupported entity");
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE id=? AND org_id=?`)
    .get(entityId, orgId);
  if (!row) throw new DomainError("Record not found", 404);
  return row;
}
export function programStats(db, orgId, clock = new Date()) {
  const timezone =
    db.prepare("SELECT timezone FROM organizations WHERE id=?").get(orgId)
      ?.timezone || "UTC";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
  const schedules = scheduledInvoiceDates(db, orgId, clock);
  const overdueByProgram = new Map();
  for (const row of schedules.values())
    overdueByProgram.set(
      row.program_id,
      (overdueByProgram.get(row.program_id) || 0) + row.overdue_cents,
    );
  return db
    .prepare(
      `SELECT p.*,
  (SELECT COALESCE(SUM(total_cents),0) FROM invoices i WHERE i.program_id=p.id AND i.voided=0) invoiced,
  (SELECT COALESCE(SUM(paid_cents),0) FROM invoices i WHERE i.program_id=p.id AND i.voided=0) paid,
  (SELECT COALESCE(SUM(total_cents-paid_cents),0) FROM invoices i WHERE i.program_id=p.id AND i.voided=0) outstanding,
  (SELECT COUNT(*) FROM invoices i WHERE i.program_id=p.id AND i.voided=0 AND i.paid_cents=i.total_cents) paid_invoices,
  (SELECT COUNT(*) FROM invoices i WHERE i.program_id=p.id AND i.voided=0 AND i.paid_cents>0 AND i.paid_cents<i.total_cents) partial_invoices,
  (SELECT COUNT(*) FROM invoices i WHERE i.program_id=p.id AND i.voided=0 AND i.paid_cents=0 AND i.total_cents>0) unpaid_invoices,
  (SELECT COALESCE(SUM(total_cents-paid_cents),0) FROM invoices i WHERE i.program_id=p.id AND i.voided=0 AND NOT EXISTS(SELECT 1 FROM invoice_payment_plans s WHERE s.invoice_id=i.id AND s.org_id=i.org_id) AND i.due_date!='' AND i.due_date<? AND i.paid_cents<i.total_cents) overdue,
  (SELECT COUNT(*) FROM registrations r WHERE r.program_id=p.id AND r.status!='Canceled' AND r.role IN ('Free Agent','Team Player')) players,
  (SELECT COUNT(*) FROM registrations r WHERE r.program_id=p.id AND r.team_id IS NULL AND r.status!='Canceled' AND r.role IN ('Free Agent','Team Player')) free_agents,
  (SELECT COUNT(*) FROM (SELECT r.person_id FROM registrations r WHERE r.program_id=p.id AND r.role NOT IN ('Free Agent','Team Player') AND r.status!='Canceled' UNION SELECT s.person_id FROM team_staff s JOIN teams t ON t.id=s.team_id WHERE t.program_id=p.id)) staff,
  (SELECT COUNT(*) FROM teams t WHERE t.program_id=p.id) teams
  ,(SELECT COUNT(*) FROM registrations r WHERE r.program_id=p.id AND r.status!='Canceled') registrations
  FROM programs p WHERE org_id=? AND archived_at IS NULL ORDER BY name`,
    )
    .all(today, orgId)
    .map((row) => ({
      ...unpack(row),
      overdue: row.overdue + (overdueByProgram.get(row.id) || 0),
    }));
}
export function saveProgram(db, actor, input, existingId) {
  const p = programSchema.parse(input);
  return transaction(db, () => {
    validateProgramTerminology(db, actor.org_id, p);
    if (p.parent_id) {
      const parent = requireEntity(db, "programs", p.parent_id, actor.org_id);
      if (!parent.grouped || parent.id === existingId)
        throw new DomainError("Select a grouped parent program");
    }
    if (p.location_id)
      requireEntity(db, "locations", p.location_id, actor.org_id);
    const programId = existingId ?? id();
    const timestamp = now();
    const {
      name,
      type,
      sport,
      gender,
      level,
      season,
      status,
      grouped,
      parent_id,
      start_date,
      end_date,
      registration_start,
      registration_end,
      fee_cents,
      capacity,
      waitlist,
      public: isPublic,
      terminology_version,
      ...data
    } = p;
    if (existingId) {
      const previous = requireEntity(db, "programs", existingId, actor.org_id);
      if (
        Boolean(previous.grouped) !== grouped ||
        unpack(previous).audience !== p.audience
      )
        throw new DomainError(
          "Grouping and participant account type cannot change after creation",
        );
      db.prepare(
        "UPDATE programs SET name=?,type=?,sport=?,gender=?,level=?,season=?,status=?,parent_id=?,start_date=?,end_date=?,registration_start=?,registration_end=?,fee_cents=?,capacity=?,waitlist=?,public=?,data=?,updated_at=? WHERE id=? AND org_id=?",
      ).run(
        name,
        type,
        sport,
        gender,
        level,
        season,
        status,
        parent_id,
        start_date,
        end_date,
        registration_start,
        registration_end,
        fee_cents,
        capacity,
        +waitlist,
        +isPublic,
        JSON.stringify(data),
        timestamp,
        programId,
        actor.org_id,
      );
    } else
      db.prepare(
        "INSERT INTO programs(id,org_id,parent_id,name,type,sport,gender,level,season,status,grouped,start_date,end_date,registration_start,registration_end,fee_cents,capacity,waitlist,public,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        programId,
        actor.org_id,
        parent_id,
        name,
        type,
        sport,
        gender,
        level,
        season,
        status,
        +grouped,
        start_date,
        end_date,
        registration_start,
        registration_end,
        fee_cents,
        capacity,
        +waitlist,
        +isPublic,
        JSON.stringify(data),
        timestamp,
        timestamp,
      );
    if (!existingId) {
      snapshotProgramRules(db, actor.org_id, programId);
      snapshotProgramForm(db, actor.org_id, programId);
      snapshotStandingsRules(db, actor.org_id, programId);
    }
    audit(db, actor, existingId ? "update" : "create", "program", programId, {
      name,
    });
    return unpack(requireEntity(db, "programs", programId, actor.org_id));
  });
}
export function createTeam(db, actor, input) {
  const p = z
    .object({
      captain_settings: z
        .object({ detached: z.boolean(), permissions: captainPermissionSchema })
        .optional(),
      program_id: z.string(),
      name: z.string().trim().min(1).max(100),
      division: z.string().max(100).default(""),
      headline: z.string().max(255).default(""),
      description: z.string().max(10000).default(""),
      notes: z.string().max(250).default(""),
    })
    .parse(input);
  return transaction(db, () => {
    const program = requireEntity(db, "programs", p.program_id, actor.org_id);
    if (program.grouped || program.archived_at)
      throw new DomainError(
        "Choose an active individual program for this team",
      );
    const teamId = id();
    db.prepare("INSERT INTO teams VALUES(?,?,?,?,?,?,?,?)").run(
      teamId,
      actor.org_id,
      p.program_id,
      p.name,
      p.division,
      0,
      JSON.stringify({
        headline: p.headline,
        description: p.description,
        notes: p.notes,
      }),
      now(),
    );
    if (p.captain_settings?.detached) {
      db.prepare(
        "INSERT INTO settings VALUES(?,?,'captain_permissions',?)",
      ).run(
        actor.org_id,
        `team:${teamId}`,
        JSON.stringify({
          version: 1,
          detached: true,
          permissions: p.captain_settings.permissions,
        }),
      );
    }
    audit(db, actor, "create", "team", teamId, {
      name: p.name,
      captain_settings: p.captain_settings,
    });
    return unpack(requireEntity(db, "teams", teamId, actor.org_id));
  });
}
export function register(
  db,
  actor,
  input,
  { beforeRegister, priceOverride, afterRegister } = {},
) {
  const p = z
    .object({
      program_id: z.string(),
      person_id: z.string(),
      team_id: z.string().nullable().default(null),
      role: z.string().min(1).max(80).default("Free Agent"),
      waiver_accepted: z.boolean().default(false),
      answers: answersSchema,
      waiver_acceptances: acceptanceSchema,
      form_version: z.number().int().positive().optional(),
      discount_code: z.string().trim().max(64).default(""),
    })
    .parse(input);
  if (p.team_id && p.role === "Free Agent") p.role = "Team Player";
  return transaction(db, () => {
    beforeRegister?.();
    const program = unpack(
      requireEntity(db, "programs", p.program_id, actor.org_id),
    );
    const person = unpack(
      requireEntity(db, "people", p.person_id, actor.org_id),
    );
    if (person.archived_at)
      throw new DomainError("Restore the member before registering");
    if (program.archived_at || program.grouped)
      throw new DomainError("Select an active individual program");
    const rules = getRules(db, actor.org_id, program);
    const preparedForm = prepareRegistrationForms(
      db,
      actor,
      program,
      person,
      p,
    );
    if (preparedForm.evidence.length) p.waiver_accepted = true;
    registrationEligibility(db, actor.org_id, program, person, p, rules);
    if (p.team_id) {
      const team = requireEntity(db, "teams", p.team_id, actor.org_id);
      if (team.program_id !== p.program_id)
        throw new DomainError("Team belongs to a different program");
      if (team.locked) throw new DomainError("This team roster is locked");
    }
    if (
      db
        .prepare(
          "SELECT id FROM registrations WHERE program_id=? AND person_id=? AND status!='Canceled'",
        )
        .get(p.program_id, p.person_id)
    )
      throw new DomainError("This member is already registered", 409);
    const isStaff = isStaffRole(p.role);
    if (isStaff)
      validateStaffAssignment(
        db,
        actor.org_id,
        program.id,
        p.team_id,
        person.id,
        p.role,
      );
    const capacityStatuses = rules.capacity_includes_pending
      ? ["Confirmed", "Pending"]
      : ["Confirmed"];
    const registeredPlayers = db
      .prepare(
        "SELECT r.status,p.gender FROM registrations r JOIN people p ON p.id=r.person_id WHERE r.program_id=? AND r.role IN ('Free Agent','Team Player')",
      )
      .all(program.id)
      .filter((r) => capacityStatuses.includes(r.status));
    const count = registeredPlayers.length;
    const genderCapacity =
      person.gender === "Male"
        ? rules.male_capacity
        : person.gender === "Female"
          ? rules.female_capacity
          : null;
    const genderFull =
      genderCapacity !== null &&
      registeredPlayers.filter((r) => r.gender === person.gender).length >=
        genderCapacity;
    const timezone = db
      .prepare("SELECT timezone FROM organizations WHERE id=?")
      .get(actor.org_id).timezone;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
    }).format(new Date());
    const full =
      !isStaff &&
      ((program.capacity !== null && count >= program.capacity) || genderFull);
    if (full && !program.waitlist)
      throw new DomainError("This program has reached capacity", 409);
    const baseFee =
      priceOverride?.() ?? registrationFee(program, rules, today, isStaff);
    let total = baseFee;
    let discount = null;
    if (p.discount_code && !full && !isStaff) {
      discount = db
        .prepare(
          "SELECT * FROM discounts WHERE org_id=? AND code=? COLLATE NOCASE AND active=1",
        )
        .get(actor.org_id, p.discount_code);
      const timezone = db
        .prepare("SELECT timezone FROM organizations WHERE id=?")
        .get(actor.org_id).timezone;
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
      }).format(new Date());
      if (
        !discount ||
        (discount.program_id && discount.program_id !== p.program_id) ||
        (discount.expires && discount.expires < today)
      )
        throw new DomainError("Discount code is invalid or expired");
      const uses = db
        .prepare(
          "SELECT COUNT(*) n FROM discount_redemptions WHERE discount_id=?",
        )
        .get(discount.id).n;
      if (
        discount.redemption_limit !== null &&
        uses >= discount.redemption_limit
      )
        throw new DomainError(
          "Discount code has reached its redemption limit",
          409,
        );
      if (
        !discount.multi_use &&
        db
          .prepare(
            "SELECT id FROM discount_redemptions WHERE discount_id=? AND person_id=?",
          )
          .get(discount.id, p.person_id)
      )
        throw new DomainError(
          "This member has already used this discount code",
          409,
        );
      const deduction =
        discount.kind === "Fixed"
          ? discount.value
          : Math.round((total * discount.value) / 10000);
      total = Math.max(0, total - deduction);
    }
    const status = full ? "Wait List" : total > 0 ? "Pending" : "Confirmed";
    let invoiceId = null;
    if (!full && baseFee > 0 && !isStaff) {
      invoiceId = id();
      const number = db
        .prepare("SELECT COALESCE(MAX(number),1000)+1 n FROM invoices")
        .get().n;
      db.prepare(
        "INSERT INTO invoices(id,number,org_id,program_id,person_id,description,total_cents,due_date,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        invoiceId,
        number,
        actor.org_id,
        p.program_id,
        p.person_id,
        program.name + " · Registration",
        total,
        rules.deadline_mode === "None"
          ? ""
          : rules.deadline_mode === "During registration"
            ? today
            : rules.deadline_mode === "Date"
              ? rules.deadline_date
              : program.start_date,
        now(),
      );
      if (discount)
        db.prepare(
          "INSERT INTO discount_redemptions VALUES(?,?,?,?,?,?,?)",
        ).run(
          id(),
          actor.org_id,
          discount.id,
          p.person_id,
          invoiceId,
          baseFee - total,
          now(),
        );
      db.prepare("UPDATE invoices SET data=? WHERE id=?").run(
        JSON.stringify({
          base_cents: baseFee,
          discount_cents: baseFee - total,
          discount_code: discount?.code ?? "",
        }),
        invoiceId,
      );
    }
    const regId = id();
    db.prepare("INSERT INTO registrations VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      regId,
      actor.org_id,
      p.program_id,
      p.person_id,
      p.team_id,
      invoiceId,
      p.role,
      status,
      p.waiver_accepted ? now() : null,
      now(),
    );
    audit(db, actor, "register", "registration", regId, {
      program_id: p.program_id,
      person_id: p.person_id,
      team_id: p.team_id,
      role: p.role,
      status,
    });
    persistRegistrationForms(db, actor, regId, person.id, preparedForm);
    const result = db
      .prepare("SELECT * FROM registrations WHERE id=?")
      .get(regId);
    afterRegister?.(result);
    return result;
  });
}
export function recordPayment(db, actor, invoiceId, input) {
  const p = z
    .object({
      amount_cents: z.number().int().positive(),
      installment_position: z.number().int().positive().optional(),
      method: z.enum(["Cash", "Check", "Bank transfer", "Other"]),
      reference: z.string().max(200).default(""),
      idempotency_key: z.string().min(8).max(100),
    })
    .parse(input);
  return transaction(db, () => {
    const invoice = requireEntity(db, "invoices", invoiceId, actor.org_id);
    const previous = db
      .prepare("SELECT * FROM transactions WHERE idempotency_key=?")
      .get(p.idempotency_key);
    if (previous) {
      const selected =
        db
          .prepare(
            "SELECT selected_position FROM installment_payment_allocations WHERE transaction_id=?",
          )
          .get(previous.id)?.selected_position ?? null;
      if (
        selected !== (p.installment_position ?? null) ||
        previous.org_id !== actor.org_id ||
        previous.invoice_id !== invoiceId ||
        previous.amount_cents !== p.amount_cents
      )
        throw new DomainError(
          "This payment key has already been used for another payment",
          409,
        );
      return previous;
    }
    assertInvoicePayable(db, invoice);
    if (
      invoice.voided ||
      p.amount_cents > invoice.total_cents - invoice.paid_cents
    )
      throw new DomainError("Payment exceeds the outstanding invoice balance");
    const allocations = prepareInstallmentPayment(
      db,
      actor.org_id,
      invoiceId,
      p.amount_cents,
      p.installment_position,
    );
    const txId = id();
    db.prepare("INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?)").run(
      txId,
      actor.org_id,
      invoiceId,
      p.amount_cents,
      "payment",
      p.method,
      p.reference,
      p.idempotency_key,
      now(),
    );
    if (allocations)
      db.prepare(
        "INSERT INTO installment_payment_allocations VALUES(?,?,?,?,?)",
      ).run(
        txId,
        actor.org_id,
        invoiceId,
        p.installment_position ?? null,
        JSON.stringify(allocations),
      );
    db.prepare("UPDATE invoices SET paid_cents=paid_cents+? WHERE id=?").run(
      p.amount_cents,
      invoiceId,
    );
    if (invoice.paid_cents + p.amount_cents === invoice.total_cents)
      db.prepare(
        "UPDATE registrations SET status='Confirmed' WHERE invoice_id=? AND status='Pending'",
      ).run(invoiceId);
    audit(db, actor, "record_payment", "invoice", invoiceId, {
      amount_cents: p.amount_cents,
      method: p.method,
    });
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });
}

export function assertInvoicePayable(db, invoice) {
  const order = db
    .prepare("SELECT * FROM product_orders WHERE invoice_id=?")
    .get(invoice.id);
  if (
    order &&
    (order.status === "Canceled" ||
      (order.expires_at &&
        order.expires_at <= now() &&
        invoice.paid_cents === 0))
  )
    throw new DomainError(
      "This order has expired or been canceled. Create a new order.",
      409,
    );
}
export const eventSchema = z.object({
  program_id: z.string(),
  type: z.enum(["Game", "Event"]),
  title: z.string().trim().min(1).max(150),
  home_team_id: z.string().nullable().default(null),
  away_team_id: z.string().nullable().default(null),
  location_id: z.string().nullable().default(null),
  start_at: z.iso.datetime({ offset: true }),
  end_at: z.union([z.iso.datetime({ offset: true }), z.literal("")]),
  state: z
    .enum(["Scheduled", "Rescheduled", "Completed", "Canceled", "Postponed"])
    .default("Scheduled"),
  home_score: z.number().int().min(0).nullable().default(null),
  away_score: z.number().int().min(0).nullable().default(null),
  published: z.boolean().default(false),
  notes: z.string().max(500).default(""),
  activity_type: z.string().max(40).optional(),
  description: z.string().max(10000).optional(),
  location_note: z.string().max(1000).optional(),
  ...gameResultSchema.shape,
});
export function saveEvent(db, actor, input, existingId) {
  const p = eventSchema.parse(input);
  return transaction(db, () => {
    const program = requireEntity(db, "programs", p.program_id, actor.org_id);
    const previous = existingId ? unpack(requireEntity(db, "events", existingId, actor.org_id)) : null;
    if (
      p.type === "Game" &&
      p.game_type === "Pool Play" &&
      program.type !== "Tournament"
    )
      throw new DomainError("Pool Play games require a Tournament program.");
    if (p.end_at && Date.parse(p.start_at) >= Date.parse(p.end_at))
      throw new DomainError("End time must follow start time");
    if (
      p.type === "Game" &&
      (!p.home_team_id || !p.away_team_id || p.home_team_id === p.away_team_id)
    )
      throw new DomainError("Choose two different teams for a game");
    if (
      p.type === "Game" &&
      p.state === "Completed" &&
      p.forfeit === "None" &&
      !p.match_scores.length &&
      (p.home_score === null || p.away_score === null)
    )
      throw new DomainError("Enter both final scores for a completed game.");
    const teamPrograms = [];
    for (const teamId of [p.home_team_id, p.away_team_id].filter(Boolean)) {
      const team = requireEntity(db, "teams", teamId, actor.org_id);
      teamPrograms.push(team.program_id);
    }
    if (teamPrograms.length && !teamPrograms.includes(p.program_id))
      throw new DomainError("At least one team must belong to this program");
    const location = p.location_id
      ? requireEntity(db, "locations", p.location_id, actor.org_id)
      : null;
    const relatedLocations = location
      ? new Set([
          location.id,
          ...(location.parent_id
            ? [location.parent_id]
            : db
                .prepare("SELECT id FROM locations WHERE parent_id=?")
                .all(location.id)
                .map((l) => l.id)),
        ])
      : new Set();
    const start = new Date(p.start_at).toISOString(),
      end = p.end_at ? new Date(p.end_at).toISOString() : "";
    if (p.state !== "Canceled") {
      const overlapping = db
        .prepare(
          `SELECT * FROM events WHERE org_id=? AND id!=? AND state!='Canceled' AND start_at${end ? "<" : "<="}?`,
        )
        .all(actor.org_id, existingId ?? "", end || start);
      const conflict = overlapping.find(
        (e) =>
          eventTimesOverlap({ start_at: start, end_at: end }, e) &&
          ((p.location_id && relatedLocations.has(e.location_id)) ||
            [p.home_team_id, p.away_team_id].some(
              (t) => t && (t === e.home_team_id || t === e.away_team_id),
            )),
      );
      if (conflict)
        throw new DomainError(
          `Schedule conflict with “${conflict.title}”`,
          409,
        );
    }
    const eventId = existingId ?? id();
    const values = [
      p.program_id,
      p.home_team_id,
      p.away_team_id,
      p.location_id,
      p.type,
      p.title,
      start,
      end,
      p.state,
      p.match_scores.length
        ? p.match_scores.filter((s) => s.home > s.away).length
        : p.home_score,
      p.match_scores.length
        ? p.match_scores.filter((s) => s.away > s.home).length
        : p.away_score,
      +p.published,
      JSON.stringify({
        notes: p.notes, ...gameResultSchema.parse(p),
        activity_type: p.activity_type ?? previous?.activity_type ?? "",
        description: p.description ?? previous?.description ?? "",
        location_note: p.location_note ?? previous?.location_note ?? "",
      }),
    ];
    if (existingId)
      db.prepare(
        "UPDATE events SET program_id=?,home_team_id=?,away_team_id=?,location_id=?,type=?,title=?,start_at=?,end_at=?,state=?,home_score=?,away_score=?,published=?,data=? WHERE id=? AND org_id=?",
      ).run(...values, eventId, actor.org_id);
    else
      db.prepare(
        "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(eventId, actor.org_id, ...values);
    audit(db, actor, existingId ? "update" : "create", "event", eventId, {
      title: p.title,
    });
    return unpack(requireEntity(db, "events", eventId, actor.org_id));
  });
}

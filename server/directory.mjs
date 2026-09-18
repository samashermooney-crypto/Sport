import { z } from "zod";
import { id, now, transaction, audit, unpack } from "./db.mjs";
import { DomainError, requireEntity, assertInvoicePayable } from "./domain.mjs";
import {
  answersSchema,
  prepareProfileAnswers,
  persistProfileAnswers,
} from "./forms.mjs";

const optionalDate = z.union([z.iso.date(), z.literal("")]).default("");
const email = z.union([z.email(), z.literal("")]).default("");
const text = (max = 255) => z.string().trim().max(max).default("");
const personSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email,
  birthdate: optionalDate,
  gender: z
    .enum(["Male", "Female", "Unknown", "Non-binary"])
    .default("Unknown"),
  kind: z.enum(["player", "parent", "staff"]).default("player"),
  household_id: z.string().nullable().optional(),
  household_role: z.enum(["Member", "Supervisor"]).optional(),
  phone: text(40),
  secondary_email: email,
  address: text(),
  city: text(100),
  state: text(100),
  postal_code: text(30),
  biography: text(10000),
  notes: text(10000),
  marketing_opt_in: z.boolean().default(false),
  sms_opt_in: z.boolean().default(false),
  email_status: z.enum(["Active", "Unsubscribed", "Bounced"]).default("Active"),
  profile_answers: answersSchema.removeDefault().optional(),
  profile_form_version: z.number().int().positive().optional(),
  profile_record_version: z.number().int().nonnegative().optional(),
});

export function listPeople(db, orgId, includeArchived = false) {
  return db
    .prepare(
      "SELECT p.*,h.name household_name,hm.role household_role FROM people p LEFT JOIN households h ON h.id=p.household_id AND h.org_id=p.org_id LEFT JOIN household_members hm ON hm.household_id=h.id AND hm.person_id=p.id WHERE p.org_id=? ORDER BY last_name,first_name",
    )
    .all(orgId)
    .map(unpack)
    .filter((p) => includeArchived || !p.archived_at);
}
export function savePerson(db, actor, input, existingId) {
  const p = personSchema.parse(input);
  if (p.birthdate && p.birthdate > new Date().toISOString().slice(0, 10))
    throw new DomainError("Birthdate cannot be in the future");
  return transaction(db, () => {
    const previous = existingId
      ? unpack(requireEntity(db, "people", existingId, actor.org_id))
      : null;
    const personId = existingId ?? id(),
      householdId =
        p.household_id === undefined
          ? (previous?.household_id ?? null)
          : p.household_id;
    if (householdId) requireEntity(db, "households", householdId, actor.org_id);
    const profileAnswers = prepareProfileAnswers(db, actor, p, p, existingId);
    const {
      first_name,
      last_name,
      email,
      birthdate,
      gender,
      kind,
      household_id,
      household_role,
      profile_answers,
      profile_form_version,
      profile_record_version,
      ...detail
    } = p;
    const data = {
      ...(previous
        ? JSON.parse(
            db.prepare("SELECT data FROM people WHERE id=?").get(existingId)
              .data,
          )
        : {}),
      ...detail,
    };
    if (existingId)
      db.prepare(
        "UPDATE people SET household_id=?,first_name=?,last_name=?,email=?,birthdate=?,gender=?,kind=?,data=? WHERE id=? AND org_id=?",
      ).run(
        householdId,
        first_name,
        last_name,
        email,
        birthdate,
        gender,
        kind,
        JSON.stringify(data),
        personId,
        actor.org_id,
      );
    else
      db.prepare("INSERT INTO people VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
        personId,
        actor.org_id,
        householdId,
        first_name,
        last_name,
        email,
        birthdate,
        gender,
        kind,
        JSON.stringify(data),
        now(),
      );
    if (householdId)
      db.prepare(
        "INSERT INTO household_members VALUES(?,?,?) ON CONFLICT(household_id,person_id) DO UPDATE SET role=excluded.role",
      ).run(
        householdId,
        personId,
        household_role ?? (kind === "parent" ? "Supervisor" : "Member"),
      );
    persistProfileAnswers(db, actor, personId, profileAnswers);
    audit(db, actor, existingId ? "update" : "create", "person", personId);
    return unpack(requireEntity(db, "people", personId, actor.org_id));
  });
}
export function saveHousehold(db, actor, input, existingId) {
  const p = z
    .object({
      name: z.string().trim().min(1).max(150),
      type: z.literal("Family").default("Family"),
      description: text(2000),
    })
    .parse(input);
  return transaction(db, () => {
    const houseId = existingId ?? id();
    if (existingId) {
      requireEntity(db, "households", houseId, actor.org_id);
      db.prepare("UPDATE households SET name=? WHERE id=?").run(
        p.name,
        houseId,
      );
    } else
      db.prepare("INSERT INTO households VALUES(?,?,?)").run(
        houseId,
        actor.org_id,
        p.name,
      );
    db.prepare(
      "INSERT INTO household_details VALUES(?,?,?) ON CONFLICT(household_id) DO UPDATE SET type=excluded.type,description=excluded.description",
    ).run(houseId, p.type, p.description);
    audit(db, actor, existingId ? "update" : "create", "household", houseId);
    return { ...requireEntity(db, "households", houseId, actor.org_id), ...p };
  });
}
export function linkHouseholdMember(db, actor, houseId, input) {
  const p = z
    .object({ person_id: z.string(), role: z.enum(["Member", "Supervisor"]) })
    .parse(input);
  return transaction(db, () => {
    requireEntity(db, "households", houseId, actor.org_id);
    const person = unpack(
      requireEntity(db, "people", p.person_id, actor.org_id),
    );
    if (person.archived_at)
      throw new DomainError("Restore the member before adding to a family");
    if (
      db
        .prepare(
          "SELECT 1 FROM household_members WHERE household_id=? AND person_id=?",
        )
        .get(houseId, p.person_id)
    )
      throw new DomainError("Member already belongs to this family", 409);
    db.prepare("INSERT INTO household_members VALUES(?,?,?)").run(
      houseId,
      p.person_id,
      p.role,
    );
    db.prepare(
      "UPDATE people SET household_id=COALESCE(household_id,?) WHERE id=?",
    ).run(houseId, p.person_id);
    audit(db, actor, "add_member", "household", houseId, p);
    return { ok: true };
  });
}
export function memberRegistrations(db, orgId, personId) {
  const rows = db
    .prepare(
      `SELECT r.*,m.first_name,m.last_name,p.name program_name,p.season,p.status program_status,p.end_date,t.name team_name,i.number invoice_number,i.total_cents,i.paid_cents FROM registrations r JOIN people m ON m.id=r.person_id JOIN programs p ON p.id=r.program_id LEFT JOIN teams t ON t.id=r.team_id LEFT JOIN invoices i ON i.id=r.invoice_id WHERE r.org_id=? AND r.person_id=?`,
    )
    .all(orgId, personId);
  const assignments = db
    .prepare(
      `SELECT s.*,t.program_id,m.first_name,m.last_name,p.name program_name,p.season,p.status program_status,p.end_date,t.name team_name FROM team_staff s JOIN teams t ON t.id=s.team_id JOIN programs p ON p.id=t.program_id JOIN people m ON m.id=s.person_id WHERE s.org_id=? AND s.person_id=?`,
    )
    .all(orgId, personId);
  for (const staff of assignments)
    if (
      !rows.some(
        (r) =>
          r.team_id === staff.team_id &&
          r.person_id === staff.person_id &&
          r.role === staff.role,
      )
    )
      rows.push({
        ...staff,
        status: "Confirmed",
        invoice_id: null,
        total_cents: 0,
        paid_cents: 0,
        waiver_accepted_at: null,
        staff_assignment: true,
      });
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export function saveLocation(db, actor, input, existingId) {
  const p = z
    .object({
      name: z.string().trim().min(1).max(150),
      parent_id: z.string().nullable().default(null),
      address: text(),
      address2: text(),
      city: text(100),
      state: text(100),
      postal_code: text(30),
      description: text(10000),
    })
    .parse(input);
  return transaction(db, () => {
    const locationId = existingId ?? id();
    if (existingId) requireEntity(db, "locations", locationId, actor.org_id);
    if (p.parent_id) {
      const parent = requireEntity(db, "locations", p.parent_id, actor.org_id);
      if (parent.parent_id || parent.id === locationId)
        throw new DomainError("Choose a top-level location");
      if (p.description.length > 200)
        throw new DomainError(
          "Sublocation description must be 200 characters or fewer",
        );
      if (
        existingId &&
        db.prepare("SELECT id FROM locations WHERE parent_id=?").get(existingId)
      )
        throw new DomainError(
          "A location with sublocations cannot become a sublocation",
        );
    }
    const duplicate = db
      .prepare(
        "SELECT id FROM locations WHERE org_id=? AND COALESCE(parent_id,'')=COALESCE(?,'') AND lower(name)=lower(?) AND id!=?",
      )
      .get(actor.org_id, p.parent_id, p.name, locationId);
    if (duplicate)
      throw new DomainError(
        "A location with this name already exists here",
        409,
      );
    const { name, parent_id, address, ...details } = p;
    if (existingId)
      db.prepare(
        "UPDATE locations SET parent_id=?,name=?,address=?,data=? WHERE id=?",
      ).run(parent_id, name, address, JSON.stringify(details), locationId);
    else
      db.prepare("INSERT INTO locations VALUES(?,?,?,?,?,?)").run(
        locationId,
        actor.org_id,
        parent_id,
        name,
        address,
        JSON.stringify(details),
      );
    audit(db, actor, existingId ? "update" : "create", "location", locationId, {
      name,
    });
    return unpack(requireEntity(db, "locations", locationId, actor.org_id));
  });
}
export function saveDiscount(db, actor, input, existingId) {
  const p = z
    .object({
      name: z.string().trim().min(1).max(150),
      description: text(350),
      code: z
        .string()
        .trim()
        .max(64)
        .regex(/^[a-zA-Z0-9%_$-]*$/, "Use letters, numbers, %, _, $, or -")
        .default(""),
      program_id: z.string().nullable().default(null),
      kind: z.enum(["Fixed", "Percentage"]),
      value: z.number().int().positive().max(100000000),
      expires: optionalDate,
      redemption_limit: z.number().int().positive().nullable().default(null),
      multi_use: z.boolean().default(false),
      active: z.boolean().default(true),
    })
    .parse(input);
  if (p.kind === "Percentage" && p.value > 10000)
    throw new DomainError("Percentage must be between 0.01 and 100");
  return transaction(db, () => {
    const discountId = existingId ?? id();
    if (p.program_id) requireEntity(db, "programs", p.program_id, actor.org_id);
    if (existingId) requireEntity(db, "discounts", discountId, actor.org_id);
    const code = p.code || id().slice(0, 8).toUpperCase();
    if (
      db
        .prepare(
          "SELECT id FROM discounts WHERE org_id=? AND code=? COLLATE NOCASE AND id!=?",
        )
        .get(actor.org_id, code, discountId)
    )
      throw new DomainError("This discount code is already in use", 409);
    if (existingId) {
      const used = db
        .prepare(
          "SELECT COUNT(*) n FROM discount_redemptions WHERE discount_id=?",
        )
        .get(discountId).n;
      if (p.redemption_limit !== null && p.redemption_limit < used)
        throw new DomainError(
          "Redemption limit cannot be lower than the number already redeemed",
        );
      db.prepare(
        "UPDATE discounts SET program_id=?,name=?,description=?,code=?,kind=?,value=?,expires=?,redemption_limit=?,multi_use=?,active=? WHERE id=?",
      ).run(
        p.program_id,
        p.name,
        p.description,
        code,
        p.kind,
        p.value,
        p.expires,
        p.redemption_limit,
        +p.multi_use,
        +p.active,
        discountId,
      );
    } else
      db.prepare("INSERT INTO discounts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        discountId,
        actor.org_id,
        p.program_id,
        p.name,
        p.description,
        code,
        p.kind,
        p.value,
        p.expires,
        p.redemption_limit,
        +p.multi_use,
        +p.active,
        now(),
      );
    audit(db, actor, existingId ? "update" : "create", "discount", discountId);
    return requireEntity(db, "discounts", discountId, actor.org_id);
  });
}
export function listCredits(db, orgId, personId) {
  return db
    .prepare(
      `SELECT c.*,p.first_name,p.last_name,c.amount_cents-COALESCE((SELECT SUM(a.amount_cents) FROM credit_applications a WHERE a.credit_id=c.id),0) balance_cents FROM credits c JOIN people p ON p.id=c.person_id WHERE c.org_id=? AND (? IS NULL OR c.person_id=?) ORDER BY c.created_at DESC`,
    )
    .all(orgId, personId ?? null, personId ?? null);
}
export function issueCredit(db, actor, input) {
  const p = z
    .object({
      person_id: z.string(),
      amount_cents: z.number().int().positive().max(100000000),
      description: text(1000),
      expires: optionalDate,
    })
    .parse(input);
  return transaction(db, () => {
    requireEntity(db, "people", p.person_id, actor.org_id);
    const creditId = id();
    db.prepare("INSERT INTO credits VALUES(?,?,?,?,?,?,?)").run(
      creditId,
      actor.org_id,
      p.person_id,
      p.amount_cents,
      p.description,
      p.expires,
      now(),
    );
    audit(db, actor, "issue", "credit", creditId, {
      amount_cents: p.amount_cents,
    });
    return requireEntity(db, "credits", creditId, actor.org_id);
  });
}
export function applyCredit(db, actor, invoiceId, input) {
  const p = z
    .object({
      credit_id: z.string(),
      amount_cents: z.number().int().positive(),
      idempotency_key: z.string().min(8).max(100),
    })
    .parse(input);
  return transaction(db, () => {
    const invoice = requireEntity(db, "invoices", invoiceId, actor.org_id);
    const credit = listCredits(db, actor.org_id).find(
      (c) => c.id === p.credit_id,
    );
    const prior = db
      .prepare("SELECT * FROM credit_applications WHERE idempotency_key=?")
      .get(p.idempotency_key);
    if (prior) {
      if (
        prior.org_id !== actor.org_id ||
        prior.credit_id !== p.credit_id ||
        prior.invoice_id !== invoiceId ||
        prior.amount_cents !== p.amount_cents
      )
        throw new DomainError("This application key was already used", 409);
      return prior;
    }
    assertInvoicePayable(db, invoice);
    const timezone = db
      .prepare("SELECT timezone FROM organizations WHERE id=?")
      .get(actor.org_id).timezone;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
    }).format(new Date());
    if (!credit || credit.person_id !== invoice.person_id)
      throw new DomainError("Choose a credit belonging to this invoice member");
    if (credit.expires && credit.expires < today)
      throw new DomainError("This credit has expired");
    if (
      invoice.voided ||
      p.amount_cents > invoice.total_cents - invoice.paid_cents ||
      p.amount_cents > credit.balance_cents
    )
      throw new DomainError(
        "Amount exceeds the invoice balance or available credit",
      );
    const applicationId = id();
    db.prepare("INSERT INTO credit_applications VALUES(?,?,?,?,?,?,?)").run(
      applicationId,
      actor.org_id,
      credit.id,
      invoiceId,
      p.amount_cents,
      p.idempotency_key,
      now(),
    );
    db.prepare("UPDATE invoices SET paid_cents=paid_cents+? WHERE id=?").run(
      p.amount_cents,
      invoiceId,
    );
    if (invoice.paid_cents + p.amount_cents === invoice.total_cents)
      db.prepare(
        "UPDATE registrations SET status='Confirmed' WHERE invoice_id=? AND status='Pending'",
      ).run(invoiceId);
    audit(db, actor, "apply_credit", "invoice", invoiceId, {
      credit_id: credit.id,
      amount_cents: p.amount_cents,
    });
    return db
      .prepare("SELECT * FROM credit_applications WHERE id=?")
      .get(applicationId);
  });
}

export function installDirectoryRoutes(app, db) {
  app.get("/api/people", (req, res) =>
    res.json(listPeople(db, req.actor.org_id, req.query.archived === "1")),
  );
  app.post("/api/people", (req, res) =>
    res.status(201).json(savePerson(db, req.actor, req.body)),
  );
  app.put("/api/people/:id", (req, res) =>
    res.json(savePerson(db, req.actor, req.body, req.params.id)),
  );
  app.get("/api/people/:id", (req, res) => {
    const person = unpack(
      requireEntity(db, "people", req.params.id, req.actor.org_id),
    );
    res.json({
      ...person,
      households: db
        .prepare(
          "SELECT h.*,m.role FROM households h JOIN household_members m ON m.household_id=h.id WHERE h.org_id=? AND m.person_id=?",
        )
        .all(req.actor.org_id, person.id),
      registrations: memberRegistrations(db, req.actor.org_id, person.id),
      waivers: db
        .prepare(
          "SELECT w.id,w.registration_id,w.waiver_version,w.accepted_at,p.id program_id,p.name program_name,json_extract(w.document,'$.name') name,s.first_name||' '||s.last_name signer_name FROM waiver_acceptances w JOIN registrations r ON r.id=w.registration_id JOIN programs p ON p.id=r.program_id JOIN people s ON s.id=w.signer_id WHERE w.person_id=? AND w.org_id=? ORDER BY w.accepted_at DESC",
        )
        .all(person.id, req.actor.org_id),
      credits: listCredits(db, req.actor.org_id, person.id),
      invoices: db
        .prepare(
          "SELECT * FROM invoices WHERE person_id=? AND org_id=? ORDER BY number DESC",
        )
        .all(person.id, req.actor.org_id)
        .map(unpack),
    });
  });
  app.patch("/api/people/:id/archive", (req, res) => {
    const p = z.object({ archived: z.boolean() }).parse(req.body),
      row = requireEntity(db, "people", req.params.id, req.actor.org_id);
    db.prepare("UPDATE people SET data=? WHERE id=?").run(
      JSON.stringify({
        ...JSON.parse(row.data),
        archived_at: p.archived ? now() : null,
      }),
      row.id,
    );
    audit(db, req.actor, p.archived ? "archive" : "restore", "person", row.id);
    res.json({ ok: true });
  });
  app.get("/api/households", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT h.*,COALESCE(d.type,'Family') type,COALESCE(d.description,'') description FROM households h LEFT JOIN household_details d ON d.household_id=h.id WHERE h.org_id=? ORDER BY h.name",
        )
        .all(req.actor.org_id),
    ),
  );
  app.post("/api/households", (req, res) =>
    res.status(201).json(saveHousehold(db, req.actor, req.body)),
  );
  app.put("/api/households/:id", (req, res) =>
    res.json(saveHousehold(db, req.actor, req.body, req.params.id)),
  );
  app.get("/api/households/:id", (req, res) => {
    const h = requireEntity(db, "households", req.params.id, req.actor.org_id);
    const members = db
      .prepare(
        "SELECT p.*,m.role household_role FROM people p JOIN household_members m ON m.person_id=p.id WHERE m.household_id=? AND p.org_id=? ORDER BY m.role DESC,p.last_name,p.first_name",
      )
      .all(h.id, req.actor.org_id)
      .map(unpack);
    res.json({
      ...h,
      ...db
        .prepare(
          "SELECT type,description FROM household_details WHERE household_id=?",
        )
        .get(h.id),
      members,
      registrations: members.flatMap((p) =>
        memberRegistrations(db, req.actor.org_id, p.id).map((r) => ({
          ...r,
          first_name: p.first_name,
          last_name: p.last_name,
        })),
      ),
    });
  });
  app.post("/api/households/:id/members", (req, res) =>
    res
      .status(201)
      .json(linkHouseholdMember(db, req.actor, req.params.id, req.body)),
  );
  app.delete("/api/households/:id/members/:personId", (req, res) => {
    requireEntity(db, "households", req.params.id, req.actor.org_id);
    requireEntity(db, "people", req.params.personId, req.actor.org_id);
    transaction(db, () => {
      db.prepare(
        "DELETE FROM household_members WHERE household_id=? AND person_id=?",
      ).run(req.params.id, req.params.personId);
      db.prepare(
        "UPDATE people SET household_id=(SELECT household_id FROM household_members WHERE person_id=? LIMIT 1) WHERE id=? AND household_id=?",
      ).run(req.params.personId, req.params.personId, req.params.id);
      audit(db, req.actor, "remove_member", "household", req.params.id, {
        person_id: req.params.personId,
      });
    });
    res.json({ ok: true });
  });
  app.get("/api/locations", (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM locations WHERE org_id=? ORDER BY name")
        .all(req.actor.org_id)
        .map(unpack),
    ),
  );
  app.get("/api/locations/:id", (req, res) =>
    res.json(
      unpack(requireEntity(db, "locations", req.params.id, req.actor.org_id)),
    ),
  );
  app.post("/api/locations", (req, res) =>
    res.status(201).json(saveLocation(db, req.actor, req.body)),
  );
  app.put("/api/locations/:id", (req, res) =>
    res.json(saveLocation(db, req.actor, req.body, req.params.id)),
  );
  app.delete("/api/locations/:id", (req, res) => {
    const loc = requireEntity(db, "locations", req.params.id, req.actor.org_id);
    if (
      db.prepare("SELECT id FROM locations WHERE parent_id=?").get(loc.id) ||
      db.prepare("SELECT id FROM events WHERE location_id=?").get(loc.id) ||
      db
        .prepare(
          "SELECT id FROM programs WHERE json_extract(data,'$.location_id')=?",
        )
        .get(loc.id)
    )
      throw new DomainError(
        "This location is in use. Remove its assignments and sublocations first.",
        409,
      );
    db.prepare("DELETE FROM locations WHERE id=?").run(loc.id);
    audit(db, req.actor, "delete", "location", loc.id);
    res.json({ ok: true });
  });
  app.get("/api/discounts", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT d.*,(SELECT COUNT(*) FROM discount_redemptions r WHERE r.discount_id=d.id) redeemed FROM discounts d WHERE d.org_id=? ORDER BY d.name",
        )
        .all(req.actor.org_id),
    ),
  );
  app.get("/api/discounts/availability", (req, res) =>
    res.json({
      available:
        !!req.query.code &&
        !db
          .prepare(
            "SELECT id FROM discounts WHERE org_id=? AND code=? COLLATE NOCASE AND id!=?",
          )
          .get(
            req.actor.org_id,
            String(req.query.code),
            String(req.query.exclude ?? ""),
          ),
    }),
  );
  app.get("/api/discounts/:id", (req, res) =>
    res.json(requireEntity(db, "discounts", req.params.id, req.actor.org_id)),
  );
  app.post("/api/discounts", (req, res) =>
    res.status(201).json(saveDiscount(db, req.actor, req.body)),
  );
  app.put("/api/discounts/:id", (req, res) =>
    res.json(saveDiscount(db, req.actor, req.body, req.params.id)),
  );
  app.get("/api/credits", (req, res) =>
    res.json(
      listCredits(
        db,
        req.actor.org_id,
        typeof req.query.person_id === "string"
          ? req.query.person_id
          : undefined,
      ),
    ),
  );
  app.post("/api/credits", (req, res) =>
    res.status(201).json(issueCredit(db, req.actor, req.body)),
  );
  app.post("/api/invoices/:id/credits", (req, res) =>
    res.status(201).json(applyCredit(db, req.actor, req.params.id, req.body)),
  );
}

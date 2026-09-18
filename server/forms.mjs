import { isStaffRole } from "./staff-roles.mjs";
import express from "express";
import { z } from "zod";
import { id, now, transaction, unpack, audit } from "./db.mjs";
import { DomainError, requireEntity } from "./domain.mjs";
import { cleanHtml } from "./html.mjs";

const roles = ["Team", "Team Player", "Free Agent", "Program Staff"];
const applicability = z.enum(["Always", "Adults", "Children"]);
const fieldSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(200),
    tag: z.string().trim().max(80).default(""),
    type: z.enum([
      "Single Text",
      "Paragraph",
      "Numeric",
      "Dropdown",
      "Multiple Checkboxes",
      "File Upload",
    ]),
    required: z.boolean().default(false),
    visibility: z
      .enum(["Public", "Protected", "Private", "Admin Only"])
      .default("Private"),
    apply: applicability.default("Always"),
    order: z.number().int().min(0).max(10000).default(0),
    roles: z
      .array(z.enum(roles))
      .default(["Team Player", "Free Agent", "Program Staff"]),
    staff_roles: z.array(z.string().min(1).max(80)).max(30).default([]),
    roster_required: z.boolean().default(false),
    managed_by_staff: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  })
  .superRefine((f, ctx) => {
    if (
      ["Dropdown", "Multiple Checkboxes"].includes(f.type) &&
      !f.options.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Add at least one option",
        path: ["options"],
      });
    if (
      new Set(f.options.map((o) => o.toLowerCase())).size !== f.options.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Options must be unique",
        path: ["options"],
      });
  });
const waiverSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive().default(1),
    name: z.string().trim().min(1).max(160),
    kind: z
      .enum(["Main Waiver", "Payment Policy", "Additional Waiver"])
      .default("Additional Waiver"),
    content: z.string().max(100000),
    enabled: z.boolean().default(true),
    required: z.boolean().default(true),
    apply: applicability.default("Always"),
    order: z.number().int().min(0).max(10000).default(0),
    roles: z
      .array(z.enum(roles))
      .default(["Team Player", "Free Agent", "Program Staff"]),
    staff_roles: z.array(z.string().min(1).max(80)).max(30).default([]),
  })
  .superRefine((w, ctx) => {
    if (
      w.enabled &&
      !cleanHtml(w.content)
        .replace(/<[^>]*>/g, "")
        .trim()
    )
      ctx.addIssue({
        code: "custom",
        message: "An enabled waiver needs document text",
        path: ["content"],
      });
  });
const definitionSchema = z
  .object({
    version: z.number().int().positive().optional(),
    fields: z.array(fieldSchema).max(150).default([]),
    waivers: z.array(waiverSchema).max(30).default([]),
  })
  .superRefine((d, ctx) => {
    for (const key of ["fields", "waivers"])
      if (new Set(d[key].map((f) => f.id)).size !== d[key].length)
        ctx.addIssue({
          code: "custom",
          message: "Duplicate identifiers",
          path: [key],
        });
    for (const kind of ["Main Waiver", "Payment Policy"])
      if (d.waivers.filter((w) => w.kind === kind).length > 1)
        ctx.addIssue({
          code: "custom",
          message: `Only one ${kind.toLowerCase()} is allowed`,
          path: ["waivers"],
        });
  });
function validateScope(db, org, scope) {
  if (["site", "profile"].includes(scope)) return;
  if (!scope.startsWith("program:"))
    throw new DomainError("Unknown form scope");
  requireEntity(db, "programs", scope.slice(8), org);
}
export function getForm(db, org, scope = "site") {
  validateScope(db, org, scope);
  const row = db
    .prepare("SELECT * FROM form_definitions WHERE org_id=? AND scope=?")
    .get(org, scope);
  return row
    ? { ...definitionSchema.parse(JSON.parse(row.data)), version: row.version }
    : { fields: [], waivers: [], version: 1 };
}
export function snapshotProgramForm(db, org, programId, sourceProgramId) {
  const form = getForm(
    db,
    org,
    sourceProgramId ? `program:${sourceProgramId}` : "site",
  );
  db.prepare(
    "INSERT INTO form_definitions(org_id,scope,data) VALUES(?,?,?)",
  ).run(
    org,
    `program:${programId}`,
    JSON.stringify({ fields: form.fields, waivers: form.waivers }),
  );
}
export function saveForm(db, actor, scope, input) {
  const parsed = definitionSchema.parse(input);
  validateScope(db, actor.org_id, scope);
  if (scope === "profile" && parsed.waivers.length)
    throw new DomainError("Waivers belong to registration forms.");
  return transaction(db, () => {
    const before = getForm(db, actor.org_id, scope);
    if (parsed.version !== before.version)
      throw new DomainError(
        "These form settings changed. Reload before saving.",
        409,
      );
    const waivers = parsed.waivers.map((w) => {
      const previous = before.waivers.find((old) => old.id === w.id),
        content = cleanHtml(w.content);
      return {
        ...w,
        content,
        version: previous
          ? previous.version +
            (previous.content !== content || previous.name !== w.name ? 1 : 0)
          : 1,
      };
    });
    const data = JSON.stringify({ fields: parsed.fields, waivers });
    db.prepare(
      "INSERT INTO form_definitions(org_id,scope,version,data) VALUES(?,?,?,?) ON CONFLICT(org_id,scope) DO UPDATE SET version=excluded.version,data=excluded.data",
    ).run(actor.org_id, scope, before.version + 1, data);
    audit(db, actor, "form.updated", "form", scope, {
      version: before.version + 1,
    });
    return getForm(db, actor.org_id, scope);
  });
}
function isAdult(person, today) {
  if (!person.birthdate)
    return person.kind === "parent" || person.kind === "staff";
  const [y, m, d] = person.birthdate.split("-").map(Number),
    [cy, cm, cd] = today.split("-").map(Number);
  return cy - y - (cm < m || (cm === m && cd < d) ? 1 : 0) >= 18;
}
export function applicableFields(
  form,
  person,
  role,
  today,
  { member = false, profile = false } = {},
) {
  const adult = isAdult(person, today),
    category = isStaffRole(role) ? "Program Staff" : role;
  const applies = (entry) =>
    (entry.apply === "Always" || (entry.apply === "Adults" ? adult : !adult)) &&
    (profile || entry.roles.includes(category)) &&
    (category !== "Program Staff" ||
      !entry.staff_roles.length ||
      entry.staff_roles.includes(role));
  return {
    fields: form.fields
      .filter(
        (f) =>
          applies(f) &&
          (!member || (!f.managed_by_staff && f.visibility !== "Admin Only")),
      )
      .sort((a, b) => a.order - b.order),
    waivers: form.waivers
      .filter((w) => w.enabled && applies(w))
      .sort((a, b) => a.order - b.order),
    version: form.version,
  };
}
const answerValue = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.array(z.string().max(200)).max(100),
  z.null(),
]);
export const answersSchema = z.record(z.string(), answerValue).default({});
export const acceptanceSchema = z
  .array(
    z.object({
      waiver_id: z.uuid(),
      waiver_version: z.number().int().positive(),
      signer_id: z.string(),
      accepted_at: z.iso.datetime().optional(),
    }),
  )
  .max(30)
  .default([]);
function orgToday(db, org) {
  const timezone = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(org).timezone;
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(),
  );
}
export function validateAnswers(db, org, fields, input) {
  const answers = answersSchema.parse(input),
    ids = new Set(fields.map((f) => f.id));
  for (const key of Object.keys(answers))
    if (!ids.has(key))
      throw new DomainError(
        "The form changed or contains a field that does not apply. Reload it.",
        409,
      );
  const clean = {};
  for (const f of fields) {
    let value = answers[f.id];
    if (typeof value === "string") value = value.trim();
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (f.required) throw new DomainError(`${f.name} is required.`);
      continue;
    }
    if (f.type === "Numeric") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new DomainError(`${f.name} must be a number.`);
    } else if (f.type === "Multiple Checkboxes") {
      if (
        !Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((v) => !f.options.includes(v))
      )
        throw new DomainError(`Choose valid options for ${f.name}.`);
    } else {
      if (typeof value !== "string")
        throw new DomainError(`${f.name} must contain text.`);
      if (f.type === "Single Text" && value.length > 500)
        throw new DomainError(`${f.name} is too long.`);
      if (f.type === "Dropdown" && !f.options.includes(value))
        throw new DomainError(`Choose an option for ${f.name}.`);
      if (
        f.type === "File Upload" &&
        !db
          .prepare("SELECT 1 FROM form_files WHERE id=? AND org_id=?")
          .get(value, org)
      )
        throw new DomainError(`Upload a file for ${f.name}.`);
    }
    clean[f.id] = value;
  }
  return clean;
}
export function registrationFormContext(db, actor, programId, personId, role) {
  const form = getForm(db, actor.org_id, `program:${programId}`),
    person = unpack(requireEntity(db, "people", personId, actor.org_id));
  const today = orgToday(db, actor.org_id);
  const signers = db
    .prepare(
      "SELECT DISTINCT p.* FROM people p WHERE p.org_id=? AND (p.id=? OR EXISTS(SELECT 1 FROM household_members h JOIN household_members child ON child.household_id=h.household_id WHERE h.person_id=p.id AND h.role='Supervisor' AND child.person_id=?))",
    )
    .all(actor.org_id, personId, personId)
    .map(unpack)
    .filter((p) => !p.archived_at && isAdult(p, today))
    .map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}` }));
  return {
    ...applicableFields(form, person, role, today, { member: !!actor.member }),
    signers: actor.member
      ? signers.filter((p) => p.id === actor.person_id)
      : signers,
  };
}
export function profileFormContext(db, actor, personId) {
  if (personId) requireEntity(db, "people", personId, actor.org_id);
  const form = getForm(db, actor.org_id, "profile");
  const row =
    personId &&
    db
      .prepare("SELECT * FROM profile_answers WHERE person_id=? AND org_id=?")
      .get(personId, actor.org_id);
  const recordVersion = personId
    ? db
        .prepare(
          "SELECT COALESCE(MAX(version),0) version FROM profile_answer_revisions WHERE person_id=? AND org_id=?",
        )
        .get(personId, actor.org_id).version
    : 0;
  return {
    ...form,
    answers: row ? JSON.parse(row.answers) : {},
    record_version: recordVersion,
    today: orgToday(db, actor.org_id),
  };
}
export function prepareProfileAnswers(db, actor, person, input, existingId) {
  // Console administrators may omit additional profile questions entirely.
  // A submitted question form must still match both the schema and saved record.
  if (
    !actor.member &&
    input.profile_form_version === undefined &&
    input.profile_answers === undefined
  )
    return null;
  const context = profileFormContext(db, actor, existingId);
  if (input.profile_form_version !== context.version)
    throw new DomainError(
      "Profile questions changed. Reload the member form before saving.",
      409,
    );
  if (input.profile_record_version !== context.record_version)
    throw new DomainError(
      "These profile answers were updated elsewhere. Reload before saving.",
      409,
    );
  const form = getForm(db, actor.org_id, "profile");
  const applicable = applicableFields(form, person, "", context.today, {
    profile: true,
    member: !!actor.member,
  });
  const answers = validateAnswers(
    db,
    actor.org_id,
    actor.member
      ? applicable.fields
      : applicable.fields.map((f) => ({ ...f, required: false })),
    input.profile_answers || {},
  );
  const activeIds = new Set(applicable.fields.map((f) => f.id));
  const oldDefinition =
    existingId &&
    db
      .prepare(
        "SELECT definition FROM profile_answers WHERE person_id=? AND org_id=?",
      )
      .get(existingId, actor.org_id);
  const oldFields = oldDefinition
    ? JSON.parse(oldDefinition.definition).fields
    : [];
  // Keep previously supplied answers while an age-specific question is hidden.
  // Removed questions and incompatible type changes remain in revision history.
  for (const field of form.fields) {
    if (
      !activeIds.has(field.id) &&
      oldFields.some((f) => f.id === field.id && f.type === field.type) &&
      context.answers[field.id] !== undefined
    )
      answers[field.id] = context.answers[field.id];
  }
  return {
    definition: form,
    answers,
    record_version: context.record_version + 1,
  };
}
export function persistProfileAnswers(db, actor, personId, prepared) {
  if (!prepared) return;
  const definition = JSON.stringify(prepared.definition),
    answers = JSON.stringify(prepared.answers),
    timestamp = now();
  db.prepare(
    "INSERT INTO profile_answers VALUES(?,?,?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET definition_version=excluded.definition_version,definition=excluded.definition,answers=excluded.answers,updated_at=excluded.updated_at",
  ).run(
    personId,
    actor.org_id,
    prepared.definition.version,
    definition,
    answers,
    timestamp,
  );
  db.prepare(
    "INSERT INTO profile_answer_revisions VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    id(),
    personId,
    actor.org_id,
    prepared.record_version,
    definition,
    answers,
    actor.id,
    timestamp,
  );
}
export function prepareRegistrationForms(db, actor, program, person, input) {
  const context = registrationFormContext(
      db,
      actor,
      program.id,
      person.id,
      input.role,
    ),
    { signers, ...form } = context,
    answers = validateAnswers(
      db,
      actor.org_id,
      form.fields,
      input.answers || {},
    ),
    acceptances = acceptanceSchema.parse(input.waiver_acceptances || []);
  if (
    (form.fields.length || form.waivers.length) &&
    input.form_version !== form.version
  )
    throw new DomainError(
      "The registration form changed. Reload it before submitting.",
      409,
    );
  const acceptedIds = new Set();
  const evidence = acceptances.map((a) => {
    if (acceptedIds.has(a.waiver_id))
      throw new DomainError("A waiver was accepted twice.");
    acceptedIds.add(a.waiver_id);
    const waiver = form.waivers.find((w) => w.id === a.waiver_id);
    if (!waiver || waiver.version !== a.waiver_version)
      throw new DomainError(
        "The waiver changed. Review the current document before recording acceptance.",
        409,
      );
    if (actor.member && (a.signer_id !== actor.person_id || a.accepted_at))
      throw new DomainError("Accept waivers using your own signed-in account.");
    const signer = unpack(
      requireEntity(db, "people", a.signer_id, actor.org_id),
    );
    if (!isAdult(signer, orgToday(db, actor.org_id)) || signer.archived_at)
      throw new DomainError("Choose an active adult signer.");
    if (
      signer.id !== person.id &&
      !db
        .prepare(
          "SELECT 1 FROM household_members h JOIN household_members child ON child.household_id=h.household_id WHERE h.person_id=? AND h.role='Supervisor' AND child.person_id=?",
        )
        .get(signer.id, person.id)
    )
      throw new DomainError(
        "The signer must be the participant or a family supervisor.",
      );
    if (a.accepted_at && Date.parse(a.accepted_at) > Date.now())
      throw new DomainError("Acceptance cannot be in the future.");
    return { ...a, accepted_at: a.accepted_at || now(), document: waiver };
  });
  for (const waiver of form.waivers)
    if (waiver.required && !acceptedIds.has(waiver.id))
      throw new DomainError(`Record acceptance for ${waiver.name}.`);
  return { form, answers, evidence };
}
export function persistRegistrationForms(
  db,
  actor,
  registrationId,
  personId,
  prepared,
) {
  const { form, answers, evidence } = prepared;
  db.prepare("INSERT INTO registration_answers VALUES(?,?,?,?,?,?)").run(
    registrationId,
    actor.org_id,
    form.version,
    JSON.stringify(form),
    JSON.stringify(answers),
    now(),
  );
  for (const a of evidence)
    db.prepare(
      "INSERT INTO waiver_acceptances VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id(),
      actor.org_id,
      registrationId,
      personId,
      a.signer_id,
      a.waiver_id,
      a.waiver_version,
      JSON.stringify(a.document),
      actor.member ? "Member accepted" : "Admin recorded",
      actor.id,
      a.accepted_at,
      now(),
    );
}
export function installFormRoutes(app, db) {
  // Existing programs get empty initial definitions, never newly edited site defaults.
  db.prepare(
    "INSERT OR IGNORE INTO form_definitions(org_id,scope,data) SELECT org_id,'program:'||id,'{\"fields\":[],\"waivers\":[]}' FROM programs",
  ).run();
  app.get("/api/forms/:scope", (req, res) =>
    res.json(getForm(db, req.actor.org_id, req.params.scope)),
  );
  app.put("/api/forms/:scope", (req, res) =>
    res.json(saveForm(db, req.actor, req.params.scope, req.body)),
  );
  app.get("/api/profile-form", (req, res) =>
    res.json(
      profileFormContext(db, req.actor, String(req.query.person_id || "")),
    ),
  );
  app.get("/api/people/:id/profile-answers", (req, res) => {
    requireEntity(db, "people", req.params.id, req.actor.org_id);
    const revisions = db
      .prepare(
        "SELECT version,definition,answers,created_at FROM profile_answer_revisions WHERE person_id=? AND org_id=? ORDER BY version DESC",
      )
      .all(req.params.id, req.actor.org_id)
      .map((row) => ({
        ...row,
        definition: JSON.parse(row.definition),
        answers: JSON.parse(row.answers),
      }));
    res.json({ revisions });
  });
  app.get("/api/registration-form", (req, res) =>
    res.json(
      registrationFormContext(
        db,
        req.actor,
        String(req.query.program_id || ""),
        String(req.query.person_id || ""),
        String(req.query.role || "Free Agent"),
      ),
    ),
  );
  app.get("/api/registrations/:id/form", (req, res) => {
    if (
      !db
        .prepare("SELECT 1 FROM registrations WHERE id=? AND org_id=?")
        .get(req.params.id, req.actor.org_id)
    )
      throw new DomainError("Registration not found", 404);
    const row = db
      .prepare(
        "SELECT * FROM registration_answers WHERE registration_id=? AND org_id=?",
      )
      .get(req.params.id, req.actor.org_id);
    const waivers = db
      .prepare(
        "SELECT w.*,p.first_name,p.last_name FROM waiver_acceptances w JOIN people p ON p.id=w.signer_id WHERE w.registration_id=? AND w.org_id=?",
      )
      .all(req.params.id, req.actor.org_id)
      .map((w) => ({ ...w, document: JSON.parse(w.document) }));
    res.json({
      definition: row
        ? JSON.parse(row.definition)
        : { fields: [], waivers: [] },
      answers: row ? JSON.parse(row.answers) : {},
      waivers,
    });
  });
  app.post("/api/form-files", formFileParser(), (req, res) => {
    const saved = saveFormFile(db, req.actor.org_id, req);
    res.status(201).json(saved);
  });
  app.get("/api/form-files/:id", (req, res) => {
    const file = db
      .prepare("SELECT * FROM form_files WHERE id=? AND org_id=?")
      .get(req.params.id, req.actor.org_id);
    if (!file) throw new DomainError("File not found", 404);
    res
      .type(file.mime)
      .attachment(file.name)
      .set("Content-Security-Policy", "default-src 'none'")
      .send(Buffer.from(file.bytes));
  });
}

export const formFileParser = () =>
  express.raw({
    type: [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
      "text/plain",
    ],
    limit: "5mb",
  });
export function saveFormFile(db, org, req) {
  const mime = req.get("Content-Type")?.split(";")[0],
    bytes = req.body;
  if (!Buffer.isBuffer(bytes) || !bytes.length)
    throw new DomainError(
      "Choose a PDF, image, or plain-text file (up to 5MB).",
    );
  const valid =
    mime === "application/pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : mime === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : mime === "image/webp"
            ? bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            : mime === "text/plain" && !bytes.includes(0);
  if (!valid)
    throw new DomainError("The file content does not match its type.");
  let providedName = String(req.get("X-File-Name") || "attachment");
  try {
    providedName = decodeURIComponent(providedName);
  } catch {}
  const fileId = id(),
    name = providedName.replace(/[\\/\r\n\x00-\x1f]/g, "_").slice(0, 180);
  db.prepare("INSERT INTO form_files VALUES(?,?,?,?,?,?)").run(
    fileId,
    org,
    name,
    mime,
    bytes,
    now(),
  );
  return { id: fileId, name, mime };
}

// Historical records retain their original labels/types while honoring current staff privacy.
export function memberRecordedFields(db, org, scope, definition) {
  const current = getForm(db, org, scope);
  return definition.fields.filter(
    (f) =>
      !f.managed_by_staff &&
      f.visibility !== "Admin Only" &&
      !current.fields.some(
        (c) =>
          c.id === f.id &&
          (c.managed_by_staff || c.visibility === "Admin Only"),
      ),
  );
}

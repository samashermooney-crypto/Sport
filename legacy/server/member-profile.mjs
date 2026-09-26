import {
  memberCollectionSettings,
  memberPhonePolicy,
  requireMemberMobile,
  secondaryEmailSchema,
  secondaryEmailPolicy,
  requireSecondaryEmail,
  requireMemberAddress,
} from "./member-properties.mjs";
import { z } from "zod";
import { id, now, unpack, transaction, audit } from "./db.mjs";
import { DomainError } from "./domain.mjs";
import {
  profileFormContext,
  prepareProfileAnswers,
  persistProfileAnswers,
  applicableFields,
  formFileParser,
  saveFormFile,
  memberRecordedFields,
} from "./forms.mjs";

const personal = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  birthdate: z.iso.date(),
  gender: z.enum(["Unknown", "Male", "Female", "Nonbinary"]),
  phone: z.string().trim().max(50).default(""),
  secondary_email: secondaryEmailSchema,
  address: z.string().trim().max(300).default(""),
  city: z.string().trim().max(100).default(""),
  state: z.string().trim().max(100).default(""),
  postal: z.string().trim().max(30).default(""),
});
const actorFor = (account) => ({
  id: account.id,
  org_id: account.org_id,
  member: true,
});
export function accessibleProfile(
  db,
  account,
  personId,
  { allowArchived = false } = {},
) {
  const row = db
    .prepare("SELECT * FROM people WHERE id=? AND org_id=?")
    .get(personId, account.org_id);
  if (
    !row ||
    (!allowArchived && unpack(row).archived_at) ||
    (personId !== account.person_id &&
      !db
        .prepare(
          "SELECT 1 FROM household_members s JOIN households h ON h.id=s.household_id AND h.org_id=? JOIN household_members m ON m.household_id=h.id WHERE s.person_id=? AND s.role='Supervisor' AND m.person_id=?",
        )
        .get(account.org_id, account.person_id, personId))
  )
    throw new DomainError("Member not found", 404);
  return unpack(row);
}
function safePerson(person) {
  return {
    id: person.id,
    email: person.email,
    kind: person.kind,
    ...Object.fromEntries(
      Object.keys(personal.shape).map((key) => [
        key,
        person[key] || (key === "gender" ? "Unknown" : ""),
      ]),
    ),
  };
}
export function memberProfileForm(db, account, personId) {
  if (personId) accessibleProfile(db, account, personId);
  const context = profileFormContext(db, actorFor(account), personId);
  // Include both age groups so changing a birthdate updates questions immediately.
  const fields = context.fields.filter(
    (f) => !f.managed_by_staff && f.visibility !== "Admin Only",
  );
  return {
    ...context,
    fields,
    waivers: [],
    answers: Object.fromEntries(
      Object.entries(context.answers).filter(([key]) =>
        fields.some((f) => f.id === key),
      ),
    ),
  };
}
export function canReadMemberFile(db, account, fileId) {
  if (
    db
      .prepare(
        "SELECT 1 FROM member_file_owners o JOIN form_files f ON f.id=o.file_id WHERE o.file_id=? AND o.account_id=? AND f.org_id=?",
      )
      .get(fileId, account.id, account.org_id)
  )
    return true;
  const rows = db
    .prepare(
      "SELECT a.person_id FROM profile_answers a WHERE a.org_id=? AND (a.person_id=? OR EXISTS(SELECT 1 FROM household_members s JOIN households h ON h.id=s.household_id AND h.org_id=a.org_id JOIN household_members m ON m.household_id=h.id WHERE s.person_id=? AND s.role='Supervisor' AND m.person_id=a.person_id))",
    )
    .all(account.org_id, account.person_id, account.person_id);
  for (const row of rows) {
    let person;
    try {
      person = accessibleProfile(db, account, row.person_id);
    } catch {
      continue;
    }
    const form = memberProfileForm(db, account, person.id);
    const fields = applicableFields(form, person, "", form.today, {
      member: true,
      profile: true,
    }).fields;
    if (
      fields.some(
        (f) => f.type === "File Upload" && form.answers[f.id] === fileId,
      )
    )
      return true;
  }
  const registrations = db
    .prepare(
      "SELECT r.person_id,r.program_id,a.definition,a.answers FROM registration_answers a JOIN registrations r ON r.id=a.registration_id AND r.org_id=a.org_id WHERE r.org_id=?",
    )
    .all(account.org_id);
  for (const row of registrations) {
    try {
      accessibleProfile(db, account, row.person_id, { allowArchived: true });
    } catch {
      continue;
    }
    const fields = memberRecordedFields(
      db,
      account.org_id,
      `program:${row.program_id}`,
      JSON.parse(row.definition),
    );
    const answers = JSON.parse(row.answers);
    if (
      fields.some((f) => f.type === "File Upload" && answers[f.id] === fileId)
    )
      return true;
  }
  return false;
}
export function saveMemberProfile(db, account, input, personId) {
  return transaction(db, () => {
    const actor = actorFor(account),
      previous = personId ? accessibleProfile(db, account, personId) : null;
    const data = personal.parse(input),
      form = memberProfileForm(db, account, personId);
    if (!memberPhonePolicy(db, account.org_id, data).collect)
      data.phone = previous?.phone || "";
    requireMemberAddress(db, account.org_id, data);
    if (!secondaryEmailPolicy(db, account.org_id, data).collect)
      data.secondary_email = previous?.secondary_email || "";
    requireMemberMobile(db, account.org_id, data);
    requireSecondaryEmail(db, account.org_id, data);
    if (data.birthdate > form.today)
      throw new DomainError("Birthdate cannot be in the future.");
    let household;
    if (!previous) {
      household = db
        .prepare(
          "SELECT h.id FROM households h JOIN household_members m ON m.household_id=h.id WHERE h.org_id=? AND m.person_id=? AND m.role='Supervisor' AND h.id=?",
        )
        .get(account.org_id, account.person_id, input.household_id);
      if (!household) throw new DomainError("Choose a family you manage.", 403);
      const [y, m, d] = data.birthdate.split("-").map(Number),
        [cy, cm, cd] = form.today.split("-").map(Number);
      if (cy - y - (cm < m || (cm === m && cd < d) ? 1 : 0) >= 18)
        throw new DomainError("Use Add child for a family member under 18.");
    }
    for (const f of form.fields) {
      const value = input.profile_answers?.[f.id];
      if (
        f.type === "File Upload" &&
        value &&
        (typeof value !== "string" || !canReadMemberFile(db, account, value))
      )
        throw new DomainError(
          "That attachment is not available to your account.",
          403,
        );
    }
    const person = { ...previous, ...data, kind: previous?.kind || "player" };
    const prepared = prepareProfileAnswers(db, actor, person, input, personId);
    const target = personId || id();
    const { first_name, last_name, birthdate, gender, ...detail } = data;
    if (previous) {
      const raw = JSON.parse(
        db.prepare("SELECT data FROM people WHERE id=?").get(target).data,
      );
      db.prepare(
        "UPDATE people SET first_name=?,last_name=?,birthdate=?,gender=?,data=? WHERE id=? AND org_id=?",
      ).run(
        first_name,
        last_name,
        birthdate,
        gender,
        JSON.stringify({ ...raw, ...detail }),
        target,
        account.org_id,
      );
    } else {
      db.prepare("INSERT INTO people VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
        target,
        account.org_id,
        household.id,
        first_name,
        last_name,
        "",
        birthdate,
        gender,
        "player",
        JSON.stringify(detail),
        now(),
      );
      db.prepare("INSERT INTO household_members VALUES(?,?,'Member')").run(
        household.id,
        target,
      );
    }
    persistProfileAnswers(db, actor, target, prepared);
    audit(
      db,
      actor,
      previous ? "member.profile_updated" : "member.child_added",
      "person",
      target,
    );
    return safePerson(accessibleProfile(db, account, target));
  });
}
export function installMemberProfileRoutes(app, db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS member_file_owners(file_id TEXT PRIMARY KEY REFERENCES form_files(id),account_id TEXT NOT NULL REFERENCES member_accounts(id))",
  );
  app.get("/api/member/:org/households", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT h.id,h.name FROM households h JOIN household_members m ON m.household_id=h.id WHERE h.org_id=? AND m.person_id=? AND m.role='Supervisor'",
        )
        .all(req.member.org_id, req.member.person_id),
    ),
  );
  app.get("/api/member/:org/profile-properties", (req, res) =>
    res.json(memberCollectionSettings(db, req.member.org_id)),
  );
  app.get("/api/member/:org/profile-form", (req, res) =>
    res.json(
      memberProfileForm(db, req.member, req.query.person_id || undefined),
    ),
  );
  app.get("/api/member/:org/profiles/:id", (req, res) =>
    res.json(safePerson(accessibleProfile(db, req.member, req.params.id))),
  );
  app.put("/api/member/:org/profiles/:id", (req, res) =>
    res.json(saveMemberProfile(db, req.member, req.body, req.params.id)),
  );
  app.post("/api/member/:org/children", (req, res) =>
    res.status(201).json(saveMemberProfile(db, req.member, req.body)),
  );
  app.post("/api/member/:org/form-files", formFileParser(), (req, res) => {
    const file = transaction(db, () => {
      const saved = saveFormFile(db, req.member.org_id, req);
      db.prepare("INSERT INTO member_file_owners VALUES(?,?)").run(
        saved.id,
        req.member.id,
      );
      return saved;
    });
    res.status(201).json(file);
  });
  app.get("/api/member/:org/form-files/:id", (req, res) => {
    if (!canReadMemberFile(db, req.member, req.params.id))
      throw new DomainError("File not found", 404);
    const file = db
      .prepare("SELECT * FROM form_files WHERE id=? AND org_id=?")
      .get(req.params.id, req.member.org_id);
    if (!file) throw new DomainError("File not found", 404);
    res
      .type(file.mime)
      .attachment(file.name)
      .set("Content-Security-Policy", "default-src 'none'")
      .send(Buffer.from(file.bytes));
  });
}

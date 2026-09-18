import { z } from "zod";
import { transaction, audit } from "./db.mjs";
import { DomainError } from "./domain.mjs";
const schema = z.object({
  version: z.number().int().positive(),
  require_profile_completion: z.boolean(),
  require_address: z.boolean().default(false),
  collect_adult_mobile: z.boolean().default(true),
  require_adult_mobile: z.boolean().default(false),
  collect_child_mobile: z.boolean().default(true),
  collect_secondary_email: z.boolean().default(false),
  require_secondary_email: z.boolean().default(false),
});
export function getMemberProperties(db, org) {
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope='site' AND key='member_properties'",
    )
    .get(org);
  return row
    ? schema.parse(JSON.parse(row.value))
    : schema.parse({ version: 1, require_profile_completion: false });
}
export function saveMemberProperties(db, actor, input) {
  const data = schema.parse(input);
  return transaction(db, () => {
    if (data.version !== getMemberProperties(db, actor.org_id).version)
      throw new DomainError(
        "Member profile settings changed. Reload before saving.",
        409,
      );
    const saved = { ...data, version: data.version + 1 };
    db.prepare(
      "INSERT INTO settings(org_id,scope,key,value) VALUES(?,'site','member_properties',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(actor.org_id, JSON.stringify(saved));
    audit(
      db,
      actor,
      "member_properties.updated",
      "settings",
      "member_properties",
    );
    return saved;
  });
}
export const addressFields = [
  ["address", "Address"],
  ["city", "City"],
  ["state", "State"],
  ["postal", "Postal code"],
];
export function missingAddress(db, org, person) {
  return getMemberProperties(db, org).require_address
    ? addressFields
        .filter(([key]) => !String(person[key] || "").trim())
        .map(([, label]) => label)
    : [];
}
export function requireMemberAddress(db, org, person) {
  const missing = missingAddress(db, org, person);
  if (missing.length)
    throw new DomainError(
      `Complete the member address: ${missing.join(", ")}.`,
    );
}

export function memberCollectionSettings(db, org) {
  const {
    require_address,
    collect_adult_mobile,
    require_adult_mobile,
    collect_child_mobile,
    collect_secondary_email,
    require_secondary_email,
  } = getMemberProperties(db, org);
  const timezone = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(org).timezone;
  return {
    require_address,
    collect_adult_mobile,
    require_adult_mobile,
    collect_child_mobile,
    collect_secondary_email,
    require_secondary_email,
    today: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
      new Date(),
    ),
  };
}
export function memberPhonePolicy(db, org, person) {
  const settings = memberCollectionSettings(db, org);
  const [y, m, d] = (person.birthdate || "").split("-").map(Number),
    [cy, cm, cd] = settings.today.split("-").map(Number);
  const child = !!y && cy - y - (cm < m || (cm === m && cd < d) ? 1 : 0) < 18;
  const collect = child
    ? settings.collect_child_mobile
    : settings.collect_adult_mobile;
  return {
    child,
    collect,
    required: !child && collect && settings.require_adult_mobile,
  };
}
export function missingMobile(db, org, person) {
  return memberPhonePolicy(db, org, person).required &&
    !String(person.phone || "").trim()
    ? ["Mobile number"]
    : [];
}
export function requireMemberMobile(db, org, person) {
  if (missingMobile(db, org, person).length)
    throw new DomainError("A parent/adult mobile number is required.");
}

export const secondaryEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.union([z.email().max(254), z.literal("")]))
  .default("");
export function secondaryEmailPolicy(db, org, person) {
  const settings = getMemberProperties(db, org);
  const collect =
    !memberPhonePolicy(db, org, person).child &&
    settings.collect_secondary_email;
  return { collect, required: collect && settings.require_secondary_email };
}
export function missingSecondaryEmail(db, org, person) {
  if (!secondaryEmailPolicy(db, org, person).required) return [];
  const result = secondaryEmailSchema.safeParse(person.secondary_email);
  return !result.success || !result.data ? ["Secondary email address"] : [];
}
export function requireSecondaryEmail(db, org, person) {
  if (missingSecondaryEmail(db, org, person).length)
    throw new DomainError(
      "A parent/adult secondary email address is required.",
    );
}

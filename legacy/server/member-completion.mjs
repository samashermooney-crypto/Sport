import {
  getMemberProperties,
  saveMemberProperties,
  missingAddress,
  missingMobile,
  missingSecondaryEmail,
} from "./member-properties.mjs";
export {
  getMemberProperties,
  saveMemberProperties,
} from "./member-properties.mjs";
import { DomainError } from "./domain.mjs";
import { accessibleProfile, memberProfileForm } from "./member-profile.mjs";
import { applicableFields, validateAnswers } from "./forms.mjs";

export function memberCompletion(db, account) {
  if (!getMemberProperties(db, account.org_id).require_profile_completion)
    return { required: false, profiles: [] };
  const ids = new Set([
    account.person_id,
    ...db
      .prepare(
        "SELECT m.person_id FROM household_members s JOIN households h ON h.id=s.household_id AND h.org_id=? JOIN household_members m ON m.household_id=h.id WHERE s.person_id=? AND s.role='Supervisor'",
      )
      .all(account.org_id, account.person_id)
      .map((r) => r.person_id),
  ]);
  const profiles = [];
  for (const personId of ids) {
    let person;
    try {
      person = accessibleProfile(db, account, personId);
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) continue;
      throw error;
    }
    const form = memberProfileForm(db, account, personId);
    const fields = applicableFields(form, person, "", form.today, {
      member: true,
      profile: true,
    }).fields.filter((f) => f.required);
    const missing = [
      ...missingAddress(db, account.org_id, person),
      ...missingMobile(db, account.org_id, person),
      ...missingSecondaryEmail(db, account.org_id, person),
    ];
    for (const [key, label] of [
      ["first_name", "First name"],
      ["last_name", "Last name"],
      ["birthdate", "Birth date"],
    ])
      if (!person[key]) missing.push(label);
    for (const field of fields) {
      try {
        validateAnswers(
          db,
          account.org_id,
          [field],
          form.answers[field.id] === undefined
            ? {}
            : { [field.id]: form.answers[field.id] },
        );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        missing.push(field.name);
      }
    }
    if (missing.length)
      profiles.push({
        id: person.id,
        name: `${person.first_name} ${person.last_name}`.trim(),
        missing,
      });
  }
  return { required: profiles.length > 0, profiles };
}
export function installMemberPropertyRoutes(app, db) {
  app.get("/api/settings/member-properties", (req, res) =>
    res.json(getMemberProperties(db, req.actor.org_id)),
  );
  app.put("/api/settings/member-properties", (req, res) =>
    res.json(saveMemberProperties(db, req.actor, req.body)),
  );
}

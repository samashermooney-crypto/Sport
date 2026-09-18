import { z } from "zod";
import { transaction, audit } from "./db.mjs";
import { DomainError } from "./domain.mjs";

export const isStaffRole = (role) =>
  !["Free Agent", "Team Player", "Team", ""].includes(role);
export const staffPermissionKeys = [
  "can_register",
  "can_join_team",
  "can_create_team",
  "can_invite_players",
  "can_manage_fields",
  "can_submit_roster",
  "can_invite_staff",
  "can_be_invited",
  "can_check_in",
  "can_edit_scores",
  "can_evaluate",
];
const permissions = Object.fromEntries(
  staffPermissionKeys.map((key) => [key, z.boolean().default(false)]),
);
const roleSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  ...permissions,
  max_program: z.number().int().positive().nullable().default(null),
  max_team: z.number().int().positive().nullable().default(null),
});
const schema = z.object({
  version: z.number().int().positive(),
  roles: z.array(roleSchema).max(100),
});
export function getStaffRoles(db, org) {
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope='site' AND key='staff_roles'",
    )
    .get(org);
  return row
    ? schema.parse(JSON.parse(row.value))
    : {
        version: 1,
        roles: ["Captain", "Coach", "Volunteer"].map((name) =>
          roleSchema.parse({
            id: name.toLowerCase(),
            name,
            can_register: name !== "Volunteer",
          }),
        ),
      };
}
function inUse(db, org, name) {
  if (
    db
      .prepare(
        "SELECT 1 FROM registrations WHERE org_id=? AND role=? UNION SELECT 1 FROM team_staff WHERE org_id=? AND role=? LIMIT 1",
      )
      .get(org, name, org, name)
  )
    return true;
  return db
    .prepare("SELECT data FROM form_definitions WHERE org_id=?")
    .all(org)
    .some((row) => {
      const form = JSON.parse(row.data);
      return [...(form.fields || []), ...(form.waivers || [])].some((f) =>
        f.staff_roles?.includes(name),
      );
    });
}
export function saveStaffRoles(db, actor, input) {
  const value = schema.parse(input);
  return transaction(db, () => {
    const previous = getStaffRoles(db, actor.org_id);
    if (value.version !== previous.version)
      throw new DomainError("Staff roles changed. Reload before saving.", 409);
    const names = new Set(),
      ids = new Set();
    for (const role of value.roles) {
      const key = role.name.toLowerCase();
      if (
        names.has(key) ||
        ["free agent", "team player", "team", "program staff"].includes(key)
      )
        throw new DomainError(
          "Choose unique staff role names that differ from player roles.",
        );
      if (ids.has(role.id)) throw new DomainError("Role IDs must be unique.");
      names.add(key);
      ids.add(role.id);
      if (!role.can_register && (role.can_join_team || role.can_create_team))
        throw new DomainError(
          "Enable self-registration before allowing a role to join or create teams.",
        );
    }
    for (const role of previous.roles)
      if (
        !value.roles.some((r) => r.id === role.id && r.name === role.name) &&
        inUse(db, actor.org_id, role.name)
      )
        throw new DomainError(
          `The ${role.name} role is in use. Keep its name and definition.`,
          409,
        );
    const next = { ...value, version: previous.version + 1 };
    db.prepare(
      "INSERT INTO settings(org_id,scope,key,value) VALUES(?,'site','staff_roles',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(actor.org_id, JSON.stringify(next));
    audit(db, actor, "staff_roles.updated", "organization", actor.org_id);
    return next;
  });
}
export function validateStaffAssignment(
  db,
  org,
  programId,
  teamId,
  personId,
  name,
) {
  const role = getStaffRoles(db, org).roles.find((r) => r.name === name);
  if (!role) throw new DomainError("Choose a configured staff role.");
  const people = db
    .prepare(
      "SELECT person_id,team_id FROM registrations WHERE org_id=? AND program_id=? AND role=? AND status!='Canceled' UNION SELECT s.person_id,s.team_id FROM team_staff s JOIN teams t ON t.id=s.team_id AND t.org_id=s.org_id WHERE s.org_id=? AND t.program_id=? AND s.role=?",
    )
    .all(org, programId, name, org, programId, name);
  const programPeople = new Set([...people.map((p) => p.person_id), personId]);
  const teamPeople = new Set([
    ...people.filter((p) => p.team_id === teamId).map((p) => p.person_id),
    personId,
  ]);
  if (role.max_program !== null && programPeople.size > role.max_program)
    throw new DomainError(
      `The ${name} limit for this program has been reached.`,
      409,
    );
  if (teamId && role.max_team !== null && teamPeople.size > role.max_team)
    throw new DomainError(
      `The ${name} limit for this team has been reached.`,
      409,
    );
  return role;
}
export function installStaffRoleRoutes(app, db) {
  app.get("/api/settings/staff-roles", (req, res) =>
    res.json(getStaffRoles(db, req.actor.org_id)),
  );
  app.put("/api/settings/staff-roles", (req, res) =>
    res.json(saveStaffRoles(db, req.actor, req.body)),
  );
}

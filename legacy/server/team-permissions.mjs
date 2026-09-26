import { memberFamily } from "./member-auth.mjs";
import { canViewWebsiteRoster } from "./roster-visibility.mjs";
import { z } from "zod";
import { transaction, audit, unpack } from "./db.mjs";
import { DomainError, requireEntity } from "./domain.mjs";
import { getRules, captainPermissionSchema } from "./program-rules.mjs";

function activeTeam(db, org, teamId) {
  const team = unpack(requireEntity(db, "teams", teamId, org));
  const program = unpack(requireEntity(db, "programs", team.program_id, org));
  if (team.archived_at || program.archived_at)
    throw new DomainError(
      "Restore the team and program before changing this team",
      409,
    );
  return { team, program };
}
export function teamPermissions(db, org, teamId) {
  const { program } = activeTeam(db, org, teamId);
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope=? AND key='captain_permissions'",
    )
    .get(org, `team:${teamId}`);
  const stored = row ? JSON.parse(row.value) : { version: 1, detached: false };
  const inherited = captainPermissionSchema.parse(
    getRules(db, org, program).captain_permissions || {},
  );
  return {
    version: stored.version,
    detached: stored.detached,
    permissions: stored.detached
      ? captainPermissionSchema.parse(stored.permissions)
      : inherited,
    inherited,
  };
}
export function saveTeamPermissions(
  db,
  actor,
  teamId,
  input,
  afterSave = () => {},
) {
  const value = z
    .object({
      version: z.number().int().positive(),
      detached: z.boolean(),
      permissions: captainPermissionSchema,
    })
    .parse(input);
  return transaction(db, () => {
    const current = teamPermissions(db, actor.org_id, teamId);
    if (value.version !== current.version)
      throw new DomainError(
        "Team permissions changed. Reload before saving.",
        409,
      );
    const next = {
      version: current.version + 1,
      detached: value.detached,
      permissions: value.detached ? value.permissions : {},
    };
    db.prepare(
      "INSERT INTO settings VALUES(?,?,'captain_permissions',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(actor.org_id, `team:${teamId}`, JSON.stringify(next));
    audit(db, actor, "update_captain_permissions", "team", teamId, next);
    afterSave();
    return teamPermissions(db, actor.org_id, teamId);
  });
}
export function renameMemberTeam(db, account, teamId, input) {
  const value = z
    .object({
      name: z.string().trim().min(1).max(100),
      expected_name: z.string(),
    })
    .parse(input);
  return transaction(db, () => {
    const { team } = activeTeam(db, account.org_id, teamId);
    const person = unpack(
      requireEntity(db, "people", account.person_id, account.org_id),
    );
    const captain = db
      .prepare(
        "SELECT 1 FROM team_staff WHERE org_id=? AND team_id=? AND person_id=? AND role='Captain' UNION SELECT 1 FROM registrations WHERE org_id=? AND team_id=? AND person_id=? AND role='Captain' AND status='Confirmed' LIMIT 1",
      )
      .get(
        account.org_id,
        teamId,
        person.id,
        account.org_id,
        teamId,
        person.id,
      );
    if (
      person.archived_at ||
      !captain ||
      !teamPermissions(db, account.org_id, teamId).permissions.edit_name
    )
      throw new DomainError(
        "You are not permitted to edit this team name",
        403,
      );
    if (team.locked) throw new DomainError("This team is locked", 409);
    if (team.name !== value.expected_name)
      throw new DomainError("Team name changed. Reload before saving.", 409);
    db.prepare("UPDATE teams SET name=? WHERE id=? AND org_id=?").run(
      value.name,
      teamId,
      account.org_id,
    );
    audit(
      db,
      { id: account.id, org_id: account.org_id },
      "member_rename",
      "team",
      teamId,
      { before: team.name, name: value.name },
    );
    return { id: teamId, name: value.name };
  });
}

export function memberTeams(db, account) {
  const person = unpack(
    requireEntity(db, "people", account.person_id, account.org_id),
  );
  if (person.archived_at) return [];
  const people = JSON.stringify([
    ...new Set([
      person.id,
      ...memberFamily(db, account)
        .filter((p) => p.self || p.household_role === "Member")
        .map((p) => p.id),
    ]),
  ]);
  return db
    .prepare(
      `SELECT DISTINCT t.*,p.name program_name FROM teams t JOIN programs p ON p.id=t.program_id AND p.org_id=t.org_id WHERE t.org_id=? AND p.archived_at IS NULL AND (EXISTS(SELECT 1 FROM team_staff s WHERE s.team_id=t.id AND s.org_id=t.org_id AND s.person_id IN (SELECT value FROM json_each(?))) OR EXISTS(SELECT 1 FROM registrations r WHERE r.team_id=t.id AND r.org_id=t.org_id AND r.person_id IN (SELECT value FROM json_each(?)) AND r.status IN ('Confirmed','Pending'))) ORDER BY t.name`,
    )
    .all(account.org_id, people, people)
    .filter((row) => !JSON.parse(row.data).archived_at)
    .map((row) => {
      const captain = db
        .prepare(
          "SELECT 1 FROM team_staff WHERE org_id=? AND team_id=? AND person_id=? AND role='Captain' UNION SELECT 1 FROM registrations WHERE org_id=? AND team_id=? AND person_id=? AND role='Captain' AND status='Confirmed' LIMIT 1",
        )
        .get(
          account.org_id,
          row.id,
          person.id,
          account.org_id,
          row.id,
          person.id,
        );
      return {
        id: row.id,
        name: row.name,
        program_name: row.program_name,
        can_view_roster: canViewWebsiteRoster(db, account.org_id, row.id, account),
        can_edit_name:
          !!captain &&
          !row.locked &&
          teamPermissions(db, account.org_id, row.id).permissions.edit_name,
      };
    });
}

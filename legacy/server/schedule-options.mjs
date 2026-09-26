import { unpack } from "./db.mjs";
import { requireEntity } from "./domain.mjs";
import { isStaffRole } from "./staff-roles.mjs";

export function scheduleOptions(db, actor, programId) {
  if (programId) requireEntity(db, "programs", programId, actor.org_id);
  const teams = db
    .prepare(
      `SELECT t.* FROM teams t
    JOIN programs p ON p.id=t.program_id AND p.org_id=t.org_id
    WHERE t.org_id=? AND p.archived_at IS NULL
      AND json_extract(t.data,'$.archived_at') IS NULL
      AND (? IS NULL OR t.program_id=?) ORDER BY t.name,t.id`,
    )
    .all(actor.org_id, programId || null, programId || null)
    .map(unpack);
  const teamIds = new Set(teams.map((t) => t.id));
  const assignments = db
    .prepare(
      `
    SELECT s.person_id,s.team_id,s.role,p.first_name,p.last_name
    FROM team_staff s JOIN people p ON p.id=s.person_id AND p.org_id=s.org_id
    WHERE s.org_id=? AND json_extract(p.data,'$.archived_at') IS NULL
    UNION ALL
    SELECT r.person_id,r.team_id,r.role,p.first_name,p.last_name
    FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id
    JOIN teams t ON t.id=r.team_id AND t.org_id=r.org_id AND t.program_id=r.program_id
    WHERE r.org_id=? AND r.status='Confirmed' AND json_extract(p.data,'$.archived_at') IS NULL
  `,
    )
    .all(actor.org_id, actor.org_id);
  const staff = new Map();
  for (const row of assignments) {
    if (
      !teamIds.has(row.team_id) ||
      row.role === "Captain" ||
      !isStaffRole(row.role)
    )
      continue;
    let person = staff.get(row.person_id);
    if (!person) {
      person = {
        id: row.person_id,
        name: `${row.first_name} ${row.last_name}`.trim(),
        team_ids: [],
      };
      staff.set(row.person_id, person);
    }
    if (!person.team_ids.includes(row.team_id))
      person.team_ids.push(row.team_id);
  }
  return {
    teams,
    staff: [...staff.values()]
      .map((p) => ({ ...p, team_ids: p.team_ids.sort() }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}
export function installScheduleOptionRoutes(app, db) {
  app.get("/api/schedule/options", (req, res) =>
    res.json(scheduleOptions(db, req.actor, req.query.program_id)),
  );
}

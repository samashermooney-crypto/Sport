import { teamRegistrationState } from "./team-registration-state.mjs";
import { websiteRosterSchema } from "./roster-visibility.mjs";
import { teamPermissions, saveTeamPermissions } from "./team-permissions.mjs";
import { isStaffRole, validateStaffAssignment } from "./staff-roles.mjs";
import { z } from "zod";
import { id, now, transaction, audit, unpack } from "./db.mjs";
import { DomainError, requireEntity, createTeam } from "./domain.mjs";

export function listTeams(db, orgId, programId) {
  const staffByTeam = new Map();
  for (const person of db.prepare(`SELECT s.team_id,s.person_id,s.role,p.first_name,p.last_name,p.email
    FROM team_staff s JOIN people p ON p.id=s.person_id AND p.org_id=s.org_id
    WHERE s.org_id=? AND json_extract(p.data,'$.archived_at') IS NULL
    UNION SELECT r.team_id,r.person_id,r.role,p.first_name,p.last_name,p.email
    FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id
    WHERE r.org_id=? AND r.status='Confirmed' AND json_extract(p.data,'$.archived_at') IS NULL
    ORDER BY last_name,first_name`).all(orgId,orgId)) {
    if (!isStaffRole(person.role)) continue;
    const staff = staffByTeam.get(person.team_id) || [];
    if (!staff.some(p => p.person_id === person.person_id)) staff.push(person);
    staffByTeam.set(person.team_id, staff);
  }
  const programs = db
    .prepare("SELECT id FROM programs WHERE org_id=? AND (id=? OR parent_id=?)")
    .all(orgId, programId || "", programId || "")
    .map((p) => p.id);
  return db
    .prepare(
      `SELECT t.*,p.name program_name,p.parent_id,p.start_date,
        COALESCE(roster.players,0) players, COALESCE(roster.pending,0) pending,
        COALESCE(roster.male,0) players_male, COALESCE(roster.female,0) players_female,
        COALESCE(roster.nonbinary,0) players_nonbinary, COALESCE(roster.unknown,0) players_unknown
      FROM teams t JOIN programs p ON p.id=t.program_id AND p.org_id=t.org_id
      LEFT JOIN (
        SELECT r.team_id,r.org_id, SUM(r.status='Confirmed') players, SUM(r.status='Pending') pending,
          SUM(r.status='Confirmed' AND person.gender='Male') male,
          SUM(r.status='Confirmed' AND person.gender='Female') female,
          SUM(r.status='Confirmed' AND person.gender='Non-binary') nonbinary,
          SUM(r.status='Confirmed' AND person.gender NOT IN ('Male','Female','Non-binary')) unknown
        FROM registrations r JOIN people person ON person.id=r.person_id AND person.org_id=r.org_id
        WHERE r.role IN ('Free Agent','Team Player') AND r.status IN ('Confirmed','Pending')
        GROUP BY r.team_id,r.org_id
      ) roster ON roster.team_id=t.id AND roster.org_id=t.org_id
      WHERE t.org_id=? AND p.archived_at IS NULL AND (?=1 OR p.status IN ('Live','Upcoming')) ORDER BY t.name`,
    )
    .all(orgId, programId ? 1 : 0)
    .map(unpack)
    .filter(
      (t) => !t.archived_at && (!programId || programs.includes(t.program_id)),
    )
    .map((team) => ({
      ...team,
      staff: staffByTeam.get(team.id) || [],
      primary_staff: (staffByTeam.get(team.id) || []).find(p => p.person_id === team.primary_staff_person_id) || null,
      registration_status: teamRegistrationState(db, orgId, team.id).status,
    }));
}
export function teamProfile(db, actor, teamId) {
  const team = unpack(requireEntity(db, "teams", teamId, actor.org_id));
  const roster = db
    .prepare(
      `SELECT r.*,p.first_name,p.last_name,p.gender,p.birthdate,p.email,p.data member_data,i.number invoice_number,i.total_cents,i.paid_cents FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id LEFT JOIN invoices i ON i.id=r.invoice_id AND i.org_id=r.org_id AND i.voided=0 WHERE r.team_id=? AND r.org_id=? AND r.status!='Canceled' ORDER BY p.last_name,p.first_name`,
    )
    .all(teamId, actor.org_id)
    .map((r) => {
      const { member_data, ...rest } = r;
      return { ...JSON.parse(member_data), ...rest };
    });
  const staff = db
    .prepare(
      `SELECT s.*,p.first_name,p.last_name,p.email,p.data FROM team_staff s JOIN people p ON p.id=s.person_id WHERE s.team_id=? AND s.org_id=? ORDER BY s.role,p.last_name`,
    )
    .all(teamId, actor.org_id)
    .map(unpack);
  for (const r of roster.filter((r) => isStaffRole(r.role)))
    if (!staff.some((s) => s.person_id === r.person_id))
      staff.push({ ...r, legacy_registration: true });
  const players = roster.filter((r) => !isStaffRole(r.role));
  const invoices = [...new Map(
    players
      .filter((r) => r.invoice_id && r.total_cents != null)
      .map((r) => [r.invoice_id, r]),
  ).values()];
  const parents = db.prepare(
    `SELECT p.* FROM household_members child JOIN household_members parent ON parent.household_id=child.household_id AND parent.role='Supervisor' JOIN people p ON p.id=parent.person_id WHERE child.person_id=? AND child.role='Member' AND p.org_id=?`,
  );
  for (const player of players)
    player.parent_contacts = parents
      .all(player.person_id, actor.org_id)
      .map(unpack)
      .filter((p) => !p.archived_at);
  return {
    ...team,
    registration_state: teamRegistrationState(db, actor.org_id, teamId),
    program: unpack(
      requireEntity(db, "programs", team.program_id, actor.org_id),
    ),
    roster: players,
    staff: staff.map(person => ({ ...person, is_primary: !person.archived_at && (!person.legacy_registration || person.status === 'Confirmed') && person.person_id === team.primary_staff_person_id })),
    events: db
      .prepare(
        "SELECT * FROM events WHERE org_id=? AND (home_team_id=? OR away_team_id=?) ORDER BY start_at",
      )
      .all(actor.org_id, teamId, teamId)
      .map(unpack),
    invoiced: invoices.reduce((s, r) => s + r.total_cents, 0),
    paid: invoices.reduce((s, r) => s + r.paid_cents, 0),
  };
}
export function updateTeam(db, actor, teamId, input) {
  const v = z
    .object({
      captain_settings: z.unknown().optional(),
      name: z.string().trim().min(1).max(80),
      division: z.string().max(100).default(""),
      headline: z.string().max(200).default(""),
      description: z.string().max(500).default(""),
      notes: z.string().max(255).default(""),
    })
    .parse(input);
  const { captain_settings, ...fields } = v;
  const write = () => {
    const previous = unpack(requireEntity(db, "teams", teamId, actor.org_id)),
      { name, division, ...details } = fields;
    // Only extension fields belong in data; never let data shadow canonical columns.
    const {
      id: key,
      org_id,
      program_id,
      locked,
      created_at,
      name: oldName,
      division: oldDivision,
      ...extra
    } = previous;
    db.prepare(
      "UPDATE teams SET name=?,division=?,data=? WHERE id=? AND org_id=?",
    ).run(
      name,
      division,
      JSON.stringify({ ...extra, ...details }),
      teamId,
      actor.org_id,
    );
    audit(db, actor, "update", "team", teamId);
  };
  if (captain_settings !== undefined)
    saveTeamPermissions(db, actor, teamId, captain_settings, write);
  else transaction(db, write);
  return teamProfile(db, actor, teamId);
}
export function assignRoster(db, actor, input) {
  const { changes } = z
    .object({
      changes: z
        .array(
          z.object({
            registration_id: z.string(),
            team_id: z.string().nullable(),
            expected_team_id: z.string().nullable(),
          }),
        )
        .min(1)
        .max(1000),
    })
    .parse(input);
  if (new Set(changes.map((c) => c.registration_id)).size !== changes.length)
    throw new DomainError("A player can occur only once in a change set");
  return transaction(db, () => {
    for (const change of changes) {
      const reg = db
        .prepare("SELECT * FROM registrations WHERE id=? AND org_id=?")
        .get(change.registration_id, actor.org_id);
      if (!reg) throw new DomainError("Player registration not found", 404);
      if (reg.team_id !== change.expected_team_id)
        throw new DomainError(
          "The roster changed while you were editing. Reload and review your changes.",
          409,
        );
      if (
        !["Confirmed", "Pending"].includes(reg.status) ||
        isStaffRole(reg.role)
      )
        throw new DomainError(
          "Only active player registrations can be assigned",
        );
      if (
        reg.team_id &&
        requireEntity(db, "teams", reg.team_id, actor.org_id).locked
      )
        throw new DomainError(
          "Unlock the current roster before moving this player",
        );
      if (change.team_id) {
        const target = unpack(
          requireEntity(db, "teams", change.team_id, actor.org_id),
        );
        if (target.locked)
          throw new DomainError("The destination roster is locked");
        if (target.archived_at)
          throw new DomainError("The destination team is archived");
        if (target.program_id !== reg.program_id)
          throw new DomainError(
            "Players must stay in their registration program. Use a program transfer to change programs.",
          );
      }
      db.prepare("UPDATE registrations SET team_id=?,role=? WHERE id=?").run(
        change.team_id,
        change.team_id ? "Team Player" : "Free Agent",
        reg.id,
      );
      audit(db, actor, "move", "registration", reg.id, {
        from: reg.team_id,
        to: change.team_id,
      });
    }
    return { updated: changes.length };
  });
}
export function setPrimaryStaff(db, actor, teamId, input) {
  const { person_id } = z.object({ person_id: z.string().min(1).nullable() }).parse(input);
  return transaction(db, () => {
    const team = unpack(requireEntity(db, "teams", teamId, actor.org_id));
    if (team.archived_at) throw new DomainError("Restore this team before changing primary staff");
    if (person_id !== null) {
      const person = unpack(requireEntity(db, "people", person_id, actor.org_id));
      const assignments = db.prepare(`SELECT role FROM team_staff WHERE org_id=? AND team_id=? AND person_id=?
        UNION SELECT role FROM registrations WHERE org_id=? AND team_id=? AND person_id=? AND status='Confirmed'`)
        .all(actor.org_id, teamId, person_id, actor.org_id, teamId, person_id);
      if (person.archived_at || !assignments.some(p => isStaffRole(p.role)))
        throw new DomainError("Choose an active staff member assigned to this team");
    }
    db.prepare("UPDATE teams SET data=json_set(data,'$.primary_staff_person_id',?) WHERE id=? AND org_id=?")
      .run(person_id, teamId, actor.org_id);
    audit(db, actor, "primary_staff.updated", "team", teamId, { person_id });
    return teamProfile(db, actor, teamId);
  });
}

export function assignStaff(db, actor, teamId, input) {
  const v = z
    .object({ person_id: z.string(), role: z.string().min(1).max(80) })
    .parse(input);
  return transaction(db, () => {
    const team = unpack(requireEntity(db, "teams", teamId, actor.org_id)),
      person = unpack(requireEntity(db, "people", v.person_id, actor.org_id));
    if (team.archived_at || person.archived_at)
      throw new DomainError("Restore archived records before assigning staff");
    validateStaffAssignment(
      db,
      actor.org_id,
      team.program_id,
      teamId,
      v.person_id,
      v.role,
    );
    db.prepare(
      "INSERT INTO team_staff VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,person_id) DO UPDATE SET role=excluded.role",
    ).run(id(), actor.org_id, teamId, v.person_id, v.role, now());
    audit(db, actor, "assign_staff", "team", teamId, v);
    return teamProfile(db, actor, teamId);
  });
}
export function copyTeam(db, actor, teamId, input) {
  const source = unpack(requireEntity(db, "teams", teamId, actor.org_id));
  const value = z
    .object({
      name: z.string().trim().min(1).max(100),
      program_id: z.string().optional(),
    })
    .parse(input);
  if (source.archived_at)
    throw new DomainError("Restore the source team before copying it", 409);
  return createTeam(db, actor, {
    ...source,
    name: value.name,
    program_id: value.program_id || source.program_id,
  });
}
export function saveRosterSettings(db, actor, programId, input) {
  requireEntity(db, "programs", programId, actor.org_id);
    const v = z
      .object({
        version: z.number().int().positive(),
        fields: z.array(
          z.enum([
            "name",
            "gender",
            "birthdate",
            "email",
            "phone",
            "address",
            "member_id",
            "invoice",
            "balance",
          ]),
        ),
        parent_contacts: z.boolean(),
        allow_staff_print: z.boolean(),
        website: websiteRosterSchema.optional(),
        foreground: z.string().regex(/^#[0-9a-f]{6}$/i),
        background: z.string().regex(/^#[0-9a-f]{6}$/i),
      })
      .parse(input);
  return transaction(db, () => {
    const scope="program:"+programId;
    const previous=db.prepare("SELECT value FROM settings WHERE org_id=? AND scope=? AND key='roster'").get(actor.org_id,scope);
    const version=previous ? JSON.parse(previous.value).version || 1 : 1;
    if (v.version !== version) throw new DomainError("Roster settings changed. Reload before saving again.",409);
    const saved={...v,version:version+1};
    db.prepare("INSERT INTO settings VALUES(?,?,'roster',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value")
      .run(actor.org_id,scope,JSON.stringify(saved));
    audit(db,actor,"update","roster_settings",programId);
    return saved;
  });
}

export function installTeamRoutes(app, db) {
  app.get("/api/teams/:id/captain-permissions", (req, res) =>
    res.json(teamPermissions(db, req.actor.org_id, req.params.id)),
  );
  app.put("/api/teams/:id/captain-permissions", (req, res) =>
    res.json(saveTeamPermissions(db, req.actor, req.params.id, req.body)),
  );
  app.get("/api/teams", (req, res) =>
    res.json(listTeams(db, req.actor.org_id, req.query.program_id)),
  );
  app.post("/api/teams", (req, res) =>
    res.status(201).json(createTeam(db, req.actor, req.body)),
  );
  app.get("/api/teams/:id", (req, res) =>
    res.json(teamProfile(db, req.actor, req.params.id)),
  );
  app.put("/api/teams/:id", (req, res) =>
    res.json(updateTeam(db, req.actor, req.params.id, req.body)),
  );
  app.post("/api/teams/:id/lock", (req, res) => {
    requireEntity(db, "teams", req.params.id, req.actor.org_id);
    const { locked } = z.object({ locked: z.boolean() }).parse(req.body);
    db.prepare("UPDATE teams SET locked=? WHERE id=? AND org_id=?").run(
      +locked,
      req.params.id,
      req.actor.org_id,
    );
    audit(db, req.actor, "roster_lock", "team", req.params.id, { locked });
    res.json({ locked });
  });
  app.post("/api/teams/:id/copy", (req, res) => {
    res.status(201).json(copyTeam(db, req.actor, req.params.id, req.body));
  });
  app.delete("/api/teams/:id", (req, res) => {
    transaction(db, () => {
      requireEntity(db, "teams", req.params.id, req.actor.org_id);
      const count = db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM registrations WHERE team_id=?)+(SELECT COUNT(*) FROM events WHERE home_team_id=? OR away_team_id=?)+(SELECT COUNT(*) FROM team_staff WHERE team_id=?) n",
        )
        .get(req.params.id, req.params.id, req.params.id, req.params.id).n;
      if (count)
        throw new DomainError(
          "This team has registrations, staff, or scheduled activities. Move or remove those associations first.",
        );
      db.prepare("DELETE FROM teams WHERE id=? AND org_id=?").run(
        req.params.id,
        req.actor.org_id,
      );
      audit(db, req.actor, "delete", "team", req.params.id);
    });
    res.json({ ok: true });
  });
  app.post("/api/roster/assign", (req, res) =>
    res.json(assignRoster(db, req.actor, req.body)),
  );
  app.post("/api/teams/:id/staff", (req, res) =>
    res.json(assignStaff(db, req.actor, req.params.id, req.body)),
  );
  app.post("/api/teams/:id/primary-staff", (req, res) =>
    res.json(setPrimaryStaff(db, req.actor, req.params.id, req.body)),
  );
  app.delete("/api/teams/:id/staff/:staffId", (req, res) => {
    transaction(db, () => {
    requireEntity(db, "teams", req.params.id, req.actor.org_id);
    const changed = db
      .prepare("DELETE FROM team_staff WHERE id=? AND team_id=? AND org_id=?")
      .run(req.params.staffId, req.params.id, req.actor.org_id);
    if (!changed.changes)
      throw new DomainError("Staff assignment not found", 404);
    audit(db, req.actor, "remove_staff", "team", req.params.id, {
      staff_id: req.params.staffId,
    });
    });
    res.json({ ok: true });
  });
  app.get("/api/programs/:id/roster-settings", (req, res) => {
    requireEntity(db, "programs", req.params.id, req.actor.org_id);
    const row = db
      .prepare(
        "SELECT value FROM settings WHERE org_id=? AND scope=? AND key='roster'",
      )
      .get(req.actor.org_id, "program:" + req.params.id);
    res.json(
      row
        ? {version: 1, ...JSON.parse(row.value)}
        : {
            version: 1,
            fields: ["name", "gender", "birthdate", "email"],
            parent_contacts: true,
            allow_staff_print: true,
            foreground: "#ffffff",
            background: "#206334",
          },
    );
  });
  app.put("/api/programs/:id/roster-settings", (req, res) => {
    res.json(saveRosterSettings(db, req.actor, req.params.id, req.body));
  });
}

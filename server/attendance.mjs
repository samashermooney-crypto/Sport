import { getStaffRoles } from "./staff-roles.mjs";
import { z } from "zod";
import { DomainError } from "./domain.mjs";
import { audit, now, transaction } from "./db.mjs";
import { memberSchedule } from "./member-schedule.mjs";

function activity(db, org, eventId) {
  const event = db
    .prepare(
      "SELECT e.*,p.name program_name FROM events e JOIN programs p ON p.id=e.program_id AND p.org_id=e.org_id WHERE e.id=? AND e.org_id=?",
    )
    .get(eventId, org);
  if (!event) throw new DomainError("Activity not found", 404);
  return event;
}
export function activityAttendance(db, org, eventId) {
  const e = activity(db, org, eventId);
  const rows = db
    .prepare(
      "SELECT r.person_id,r.team_id,p.first_name,p.last_name,t.name team_name,COALESCE(a.rsvp,'') rsvp,a.checked_in_at,COALESCE(a.version,0) version FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id LEFT JOIN teams t ON t.id=r.team_id AND t.org_id=r.org_id LEFT JOIN activity_attendance a ON a.event_id=? AND a.person_id=r.person_id AND a.org_id=r.org_id WHERE r.org_id=? AND r.program_id=? AND r.status IN ('Confirmed','Pending') AND r.role IN ('Free Agent','Team Player') AND json_extract(p.data,'$.archived_at') IS NULL AND ((? IS NULL AND ? IS NULL) OR r.team_id=? OR r.team_id=?) ORDER BY p.last_name,p.first_name,p.id",
    )
    .all(
      e.id,
      org,
      e.program_id,
      e.home_team_id,
      e.away_team_id,
      e.home_team_id,
      e.away_team_id,
    );
  return {
    event: {
      id: e.id,
      program_id: e.program_id,
      type: e.type,
      title: e.title,
      program_name: e.program_name,
      start_at: e.start_at,
      state: e.state,
    },
    rows,
  };
}
export function recordAttendance(
  db,
  actor,
  eventId,
  personId,
  input,
  kind = "check-in",
) {
  const data =
    kind === "rsvp"
      ? z
          .object({
            version: z.number().int().nonnegative(),
            rsvp: z.enum(["", "Yes", "No", "Maybe"]),
          })
          .parse(input)
      : z
          .object({
            version: z.number().int().nonnegative(),
            checked_in: z.boolean(),
          })
          .parse(input);
  return transaction(db, () => {
    const roster = activityAttendance(db, actor.org_id, eventId),
      row = roster.rows.find((r) => r.person_id === personId);
    if (!row)
      throw new DomainError("Participant not found for this activity", 404);
    if (roster.event.state === "Canceled")
      throw new DomainError("This activity is canceled.", 409);
    if (row.version !== data.version)
      throw new DomainError("Attendance changed. Reload before saving.", 409);
    db.prepare(
      "INSERT INTO activity_attendance(org_id,event_id,person_id,rsvp,version) VALUES(?,?,?,'',0) ON CONFLICT(event_id,person_id) DO NOTHING",
    ).run(actor.org_id, eventId, personId);
    db.prepare(
      "INSERT INTO attendance_roster_snapshots(event_id,person_id,org_id,first_name,last_name,team_id,team_name,captured_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id,person_id) DO NOTHING",
    ).run(
      eventId,
      personId,
      actor.org_id,
      row.first_name,
      row.last_name,
      row.team_id,
      row.team_name,
      now(),
    );
    if (kind === "rsvp")
      db.prepare(
        "UPDATE activity_attendance SET rsvp=?,version=version+1 WHERE event_id=? AND person_id=? AND org_id=?",
      ).run(data.rsvp, eventId, personId, actor.org_id);
    else
      db.prepare(
        "UPDATE activity_attendance SET checked_in_at=?,version=version+1 WHERE event_id=? AND person_id=? AND org_id=?",
      ).run(
        data.checked_in ? row.checked_in_at || now() : null,
        eventId,
        personId,
        actor.org_id,
      );
    audit(
      db,
      actor,
      kind === "rsvp" ? "attendance.rsvp" : "attendance.check_in",
      "event",
      eventId,
      { person_id: personId, ...data },
    );
    return activityAttendance(db, actor.org_id, eventId);
  });
}
function staffAttendanceRows(db, account, roster) {
  const allowed = new Set(
    getStaffRoles(db, account.org_id)
      .roles.filter((r) => r.can_check_in)
      .map((r) => r.name),
  );
  if (!allowed.size) return [];
  const assignments = db
    .prepare(
      "SELECT r.team_id,r.role FROM registrations r WHERE r.org_id=? AND r.person_id=? AND r.program_id=? AND r.status IN ('Confirmed','Pending') UNION SELECT s.team_id,s.role FROM team_staff s JOIN teams t ON t.id=s.team_id AND t.org_id=s.org_id WHERE s.org_id=? AND s.person_id=? AND t.program_id=?",
    )
    .all(
      account.org_id,
      account.person_id,
      roster.event.program_id,
      account.org_id,
      account.person_id,
      roster.event.program_id,
    )
    .filter((r) => allowed.has(r.role));
  if (assignments.some((r) => !r.team_id)) return roster.rows;
  const teams = new Set(assignments.map((r) => r.team_id));
  return roster.rows.filter((r) => r.team_id && teams.has(r.team_id));
}
export function memberRoster(db, account, eventId) {
  const event = memberSchedule(db, account).events.find(
    (e) => e.id === eventId,
  );
  if (!event) throw new DomainError("Activity not found", 404);
  const roster = activityAttendance(db, account.org_id, eventId);
  return {
    ...roster,
    staff_rows: staffAttendanceRows(db, account, roster),
    rows: roster.rows.filter((r) =>
      event.participants.some((p) => p.id === r.person_id),
    ),
  };
}
export function memberRsvp(db, account, eventId, personId, input) {
  if (
    !memberRoster(db, account, eventId).rows.some(
      (r) => r.person_id === personId,
    )
  )
    throw new DomainError("Family participant not found", 404);
  recordAttendance(db, account, eventId, personId, input, "rsvp");
  return memberRoster(db, account, eventId);
}
export function memberCheckin(db, account, eventId, personId, input) {
  if (
    !memberRoster(db, account, eventId).staff_rows.some(
      (r) => r.person_id === personId,
    )
  )
    throw new DomainError("You cannot check in this participant.", 403);
  recordAttendance(db, account, eventId, personId, input);
  return memberRoster(db, account, eventId);
}
function reportedAttendance(db, org, eventId) {
  const roster = activityAttendance(db, org, eventId);
  const rows = new Map(
    roster.rows.map((r) => [r.person_id, { ...r, roster_status: "Current" }]),
  );
  const recorded = db
    .prepare(
      "SELECT a.person_id,a.rsvp,a.checked_in_at,a.version,COALESCE(s.first_name,p.first_name) first_name,COALESCE(s.last_name,p.last_name) last_name,s.team_id,s.team_name FROM activity_attendance a JOIN people p ON p.id=a.person_id AND p.org_id=a.org_id LEFT JOIN attendance_roster_snapshots s ON s.event_id=a.event_id AND s.person_id=a.person_id AND s.org_id=a.org_id WHERE a.org_id=? AND a.event_id=?",
    )
    .all(org, eventId);
  for (const row of recorded)
    rows.set(row.person_id, {
      ...row,
      roster_status: rows.has(row.person_id) ? "Current" : "Former",
    });
  return {
    ...roster,
    rows: [...rows.values()].sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(
        `${b.last_name} ${b.first_name}`,
      ),
    ),
  };
}
export function attendanceReport(db, org, input) {
  const p = z
    .object({
      from: z.iso.date(),
      to: z.iso.date(),
      program_id: z.string().default(""),
      name: z.string().max(100).default(""),
      event_type: z.enum(["", "Game", "Event"]).default(""),
      title: z.string().max(150).default(""),
    })
    .parse(input);
  if (p.from > p.to || Date.parse(p.to) - Date.parse(p.from) > 366 * 86400000)
    throw new DomainError("Choose a date range of one year or less.");
  const tz = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(org).timezone;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  const events = db
    .prepare(
      "SELECT id,program_id,start_at,type,title FROM events WHERE org_id=? ORDER BY start_at,id",
    )
    .all(org)
    .filter(
      (e) =>
        (!p.program_id || e.program_id === p.program_id) &&
        (!p.event_type || e.type === p.event_type) &&
        e.title.toLowerCase().includes(p.title.toLowerCase()) &&
        day.format(new Date(e.start_at)) >= p.from &&
        day.format(new Date(e.start_at)) <= p.to,
    );
  const rows = events.flatMap((e) => {
    const roster = reportedAttendance(db, org, e.id);
    return roster.rows
      .filter((r) =>
        `${r.first_name} ${r.last_name}`
          .toLowerCase()
          .includes(p.name.toLowerCase()),
      )
      .map((r) => ({
        ...r,
        ...roster.event,
        id: `${e.id}:${r.person_id}`,
        event_id: e.id,
      }));
  });
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.program_id)) grouped.set(row.program_id, []);
    grouped.get(row.program_id).push(row);
  }
  return {
    rows,
    summary: attendanceCounts(rows),
    timezone: tz,
    programs: [...grouped].map(([id, entries]) => ({
      id,
      name: entries[0].program_name,
      ...attendanceCounts(entries),
    })),
  };
}
function attendanceCounts(rows) {
  const summary = {
    participants: rows.length,
    yes: 0,
    no: 0,
    maybe: 0,
    not_responded: 0,
    checked_in: 0,
  };
  for (const r of rows) {
    summary[r.rsvp ? r.rsvp.toLowerCase() : "not_responded"]++;
    if (r.checked_in_at) summary.checked_in++;
  }
  return summary;
}
export function attendanceDefaults(db, org, instant = new Date()) {
  const timezone = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(org).timezone;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    instant,
  );
  const start = new Date(today + "T12:00:00Z");
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    timezone,
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}
export function attendanceCsv(report, section = "players") {
  const kind = z
    .enum(["summary", "programs", "players", "checkins"])
    .parse(section);
  const headings = [
    "Participants",
    "RSVP Yes",
    "RSVP No",
    "RSVP Maybe",
    "Not Responded",
    "Checked In",
  ];
  const counts = (r) => [
    r.participants,
    r.yes,
    r.no,
    r.maybe,
    r.not_responded,
    r.checked_in,
  ];
  const local = (value) =>
    value
      ? new Intl.DateTimeFormat("sv-SE", {
          timeZone: report.timezone,
          dateStyle: "short",
          timeStyle: "medium",
        }).format(new Date(value))
      : "";
  const rows =
    kind === "summary"
      ? [headings, counts(report.summary)]
      : kind === "programs"
        ? [
            ["Program", ...headings],
            ...report.programs.map((p) => [p.name, ...counts(p)]),
          ]
        : [
            [
              "Player",
              "Program",
              "Activity",
              `Activity Start (${report.timezone})`,
              "RSVP",
              "Roster status",
              `Checked In (${report.timezone})`,
            ],
            ...report.rows
              .filter((r) => kind !== "checkins" || r.checked_in_at)
              .map((r) => [
                `${r.first_name} ${r.last_name}`,
                r.program_name,
                r.title,
                local(r.start_at),
                r.rsvp || "Not responded",
                r.roster_status,
                local(r.checked_in_at),
              ]),
          ];
  const cell = (value) =>
    '"' +
    String(
      typeof value === "string" && /^[=+\-@\t\r\n]/.test(value)
        ? "'" + value
        : value,
    ).replaceAll('"', '""') +
    '"';
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function installAttendanceRoutes(app, db) {
  app.get("/api/reports/attendance/options", (req, res) =>
    res.json(attendanceDefaults(db, req.actor.org_id)),
  );
  app.get("/api/reports/attendance.csv", (req, res) => {
    const section = req.query.section || "players";
    const csv = attendanceCsv(
      attendanceReport(db, req.actor.org_id, req.query),
      section,
    );
    res.type("text/csv").attachment(`attendance-${section}.csv`).send(csv);
  });
  app.get("/api/activities/:id/attendance", (req, res) =>
    res.json(activityAttendance(db, req.actor.org_id, req.params.id)),
  );
  app.put("/api/activities/:id/attendance/:person", (req, res) =>
    res.json(
      recordAttendance(
        db,
        req.actor,
        req.params.id,
        req.params.person,
        req.body,
      ),
    ),
  );
  app.get("/api/reports/attendance", (req, res) =>
    res.json(attendanceReport(db, req.actor.org_id, req.query)),
  );
}
export function installMemberAttendanceRoutes(app, db) {
  app.put("/api/member/:org/activities/:id/check-in/:person", (req, res) =>
    res.json(
      memberCheckin(db, req.member, req.params.id, req.params.person, req.body),
    ),
  );
  app.get("/api/member/:org/activities/:id/attendance", (req, res) =>
    res.json(memberRoster(db, req.member, req.params.id)),
  );
  app.put("/api/member/:org/activities/:id/rsvp/:person", (req, res) =>
    res.json(
      memberRsvp(db, req.member, req.params.id, req.params.person, req.body),
    ),
  );
}

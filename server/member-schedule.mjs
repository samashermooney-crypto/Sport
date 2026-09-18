import { DomainError } from "./domain.mjs";
import { memberFamily } from "./member-auth.mjs";
import { accessibleProfile } from "./member-profile.mjs";
import { getStandingsRules } from "./standings.mjs";

export function memberSchedule(db, account, personId = "") {
  const self = accessibleProfile(db, account, account.person_id);
  const people = [
    ...new Map(
      [
        { id: self.id, first_name: self.first_name, last_name: self.last_name },
        ...memberFamily(db, account).filter(
          (p) => p.self || p.household_role === "Member",
        ),
      ].map((p) => [
        p.id,
        { id: p.id, name: `${p.first_name} ${p.last_name}` },
      ]),
    ).values(),
  ];
  if (personId && !people.some((p) => p.id === personId))
    throw new DomainError("Family member not found", 404);
  const selected = new Set(
    people.filter((p) => !personId || p.id === personId).map((p) => p.id),
  );
  const registrations = db
    .prepare(
      "SELECT r.person_id,r.program_id,r.team_id FROM registrations r JOIN programs p ON p.id=r.program_id AND p.org_id=r.org_id WHERE r.org_id=? AND r.status IN ('Confirmed','Pending') AND p.archived_at IS NULL",
    )
    .all(account.org_id)
    .filter((r) => selected.has(r.person_id));
  const staff = db
    .prepare(
      "SELECT s.person_id,t.program_id,t.id team_id FROM team_staff s JOIN teams t ON t.id=s.team_id AND t.org_id=s.org_id JOIN programs p ON p.id=t.program_id AND p.org_id=t.org_id WHERE s.org_id=? AND p.archived_at IS NULL",
    )
    .all(account.org_id)
    .filter((r) => selected.has(r.person_id));
  const memberships = [...registrations, ...staff];
  const events = db
    .prepare(
      "SELECT e.id,e.program_id,e.home_team_id,e.away_team_id,e.title,e.type,e.start_at,e.end_at,e.state,e.home_score,e.away_score,e.data,p.name program_name,h.name home_team,a.name away_team,l.name location,l.address location_address FROM events e JOIN programs p ON p.id=e.program_id AND p.org_id=e.org_id LEFT JOIN teams h ON h.id=e.home_team_id AND h.org_id=e.org_id LEFT JOIN teams a ON a.id=e.away_team_id AND a.org_id=e.org_id LEFT JOIN locations l ON l.id=e.location_id AND l.org_id=e.org_id WHERE e.org_id=? AND e.published=1 AND p.status!='Unpublished' AND p.archived_at IS NULL AND (e.home_team_id IS NULL OR h.id IS NOT NULL) AND (e.away_team_id IS NULL OR a.id IS NOT NULL) ORDER BY e.start_at,e.id",
    )
    .all(account.org_id)
    .flatMap((event) => {
      const participants = [
        ...new Set(
          memberships
            .filter((m) =>
              !event.home_team_id && !event.away_team_id
                ? m.program_id === event.program_id
                : m.team_id &&
                  (m.team_id === event.home_team_id ||
                    m.team_id === event.away_team_id),
            )
            .map((m) => m.person_id),
        ),
      ];
      if (!participants.length) return [];
      const { data, home_team_id, away_team_id, ...safe } = event,
        result = JSON.parse(data || "{}");
      return [
        {
          ...safe,
          participants: people.filter((p) => participants.includes(p.id)),
          overtime: result.overtime === true,
          forfeit: result.forfeit || "None",
          match_scores: (result.match_scores || []).map((s) => ({
            home: s.home,
            away: s.away,
          })),
        },
      ];
    });
  const organization = db
    .prepare("SELECT name,timezone FROM organizations WHERE id=?")
    .get(account.org_id);
  return {
    people,
    events,
    organization,
    week_start: getStandingsRules(db, account.org_id).calendar_week_start,
  };
}
const escapeText = (value) =>
  String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n|\r/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
function fold(line) {
  let output = "",
    width = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (width + size > 75) {
      output += "\r\n ";
      width = 1;
    }
    output += char;
    width += size;
  }
  return output;
}
const stamp = (value) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
export function scheduleCalendar(schedule) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Athlentry//Member Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(schedule.organization.name)} — My Schedule`,
  ];
  for (const e of schedule.events)
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@fieldhouse.local`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(e.start_at)}`,
      ...(e.end_at ? [`DTEND:${stamp(e.end_at)}`] : []),
      `SUMMARY:${escapeText(e.title)}`,
      `LOCATION:${escapeText([e.location, e.location_address].filter(Boolean).join(" · "))}`,
      `DESCRIPTION:${escapeText([e.program_name, e.participants.map((p) => p.name).join(", "), [e.home_team, e.away_team].filter(Boolean).join(" vs. ")].join("\n"))}`,
      `STATUS:${e.state === "Canceled" ? "CANCELLED" : e.state === "Postponed" ? "TENTATIVE" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
export function installMemberScheduleRoutes(app, db) {
  const selection = (req) =>
    typeof req.query.person_id === "string" ? req.query.person_id : "";
  app.get("/api/member/:org/schedule", (req, res) =>
    res.json(memberSchedule(db, req.member, selection(req))),
  );
  app.get("/api/member/:org/schedule.ics", (req, res) =>
    res
      .set("Cache-Control", "private, no-store")
      .type("text/calendar; charset=utf-8")
      .attachment("athlentry-schedule.ics")
      .send(scheduleCalendar(memberSchedule(db, req.member, selection(req)))),
  );
}

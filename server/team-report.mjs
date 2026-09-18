import { id, transaction } from "./db.mjs";
import { z } from "zod";
import { DomainError } from "./domain.mjs";
import { getForm } from "./forms.mjs";

export function teamReportFields(db, org, programId) {
  // getForm validates the program's organization even when it has no questions.
  const form = getForm(db, org, `program:${programId}`);
  const fields = new Map();
  const add = (f) => {
    if (
      f.type === "Dropdown" &&
      f.roles?.some((r) => ["Free Agent", "Team Player"].includes(r))
    ) {
      const existing = fields.get(f.id);
      fields.set(f.id, {
        id: f.id,
        name: existing?.name || f.name,
        options: [
          ...new Set([...(existing?.options || []), ...(f.options || [])]),
        ],
      });
    }
  };
  form.fields.forEach(add);
  for (const row of db
    .prepare(
      "SELECT a.definition FROM registration_answers a JOIN registrations r ON r.id=a.registration_id AND r.org_id=a.org_id WHERE r.org_id=? AND r.program_id=?",
    )
    .all(org, programId))
    JSON.parse(row.definition).fields.forEach(add);
  return [...fields.values()];
}
function shiftYears(date, years) {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
export function teamReportDateLimits(db, org) {
  const row = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(org);
  if (!row) throw new DomainError("Organization not found", 404);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: row.timezone,
  }).format(new Date());
  return {
    min: shiftYears(today, -3),
    max: today,
    default_from: shiftYears(today, -1),
  };
}
export function teamReportRange(input, limits) {
  const to =
    input.to ||
    (input.from
      ? [shiftYears(input.from, 1), limits.max].sort()[0]
      : limits.max);
  const from = input.from || shiftYears(to, -1);
  if (from > to)
    throw new DomainError("The start date must not follow the end date.");
  if (from < limits.min || to > limits.max)
    throw new DomainError("Choose dates within the past three years.");
  if (to > shiftYears(from, 1))
    throw new DomainError("Choose a date range of one year or less.");
  return { from, to };
}
const selection = z.object({
  program_id: z.string().min(1),
  field_id: z.string().min(1),
  status: z
    .enum(["", "Confirmed", "Pending", "Wait List", "Canceled"])
    .default(""),
  from: z.union([z.iso.date(), z.literal("")]).default(""),
  to: z.union([z.iso.date(), z.literal("")]).default(""),
});
export function teamPropertyReport(db, org, input) {
  const p = selection.parse(input);
  const range = teamReportRange(p, teamReportDateLimits(db, org));
  if (p.from && p.to && p.from > p.to)
    throw new DomainError("The start date must not follow the end date.");
  const field = teamReportFields(db, org, p.program_id).find(
    (f) => f.id === p.field_id,
  );
  if (!field)
    throw new DomainError("Choose a player dropdown registration field.");
  const timezone = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(org).timezone;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const rows = db
    .prepare(
      "SELECT id,name FROM teams WHERE org_id=? AND program_id=? ORDER BY name,id",
    )
    .all(org, p.program_id)
    .map((t) => ({ ...t, counts: Object.create(null), answered: 0 }));
  const teams = new Map(rows.map((t) => [t.id, t]));
  const options = [...field.options];
  for (const r of db
    .prepare(
      "SELECT r.team_id,r.status,r.created_at,a.answers FROM registrations r JOIN registration_answers a ON a.registration_id=r.id AND a.org_id=r.org_id WHERE r.org_id=? AND r.program_id=? AND r.role IN ('Free Agent','Team Player')",
    )
    .all(org, p.program_id)) {
    if (!teams.has(r.team_id) || (p.status && p.status !== r.status)) continue;
    const date = day.format(new Date(r.created_at));
    if (date < range.from || date > range.to) continue;
    const answer = JSON.parse(r.answers)[p.field_id];
    if (typeof answer !== "string" || !answer.trim()) continue;
    if (!options.includes(answer)) options.push(answer);
    const team = teams.get(r.team_id);
    team.counts[answer] = (team.counts[answer] || 0) + 1;
    team.answered++;
  }
  return {
    field,
    range,
    options,
    rows,
    totals: Object.fromEntries(
      options.map((o) => [o, rows.reduce((n, r) => n + (r.counts[o] || 0), 0)]),
    ),
    answered: rows.reduce((n, r) => n + r.answered, 0),
  };
}
export function teamReportCsv(report) {
  const cell = (v) =>
    '"' +
    String(
      typeof v === "string" && /^[=+\-@\t\r\n]/.test(v) ? "'" + v : v,
    ).replaceAll('"', '""') +
    '"';
  return (
    [
      ["Team", ...report.options, "Total"],
      ...report.rows.map((r) => [
        r.name,
        ...report.options.map((o) => r.counts[o] || 0),
        r.answered,
      ]),
      [
        "Total",
        ...report.options.map((o) => report.totals[o]),
        report.answered,
      ],
    ]
      .map((r) => r.map(cell).join(","))
      .join("\r\n") + "\r\n"
  );
}
export function savedTeamReports(db, actor) {
  return db
    .prepare(
      "SELECT key,value FROM settings WHERE org_id=? AND scope=? ORDER BY key",
    )
    .all(actor.org_id, `report:teams:${actor.id}`)
    .map((row) => ({ id: row.key, ...JSON.parse(row.value) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function saveTeamReport(db, actor, input) {
  const name = z.string().trim().min(1).max(100).parse(input.name),
    filters = selection.parse(input.filters);
  teamPropertyReport(db, actor.org_id, filters);
  return transaction(db, () => {
    const existing = savedTeamReports(db, actor);
    if (existing.length >= 100)
      throw new DomainError("You can save up to 100 team reports.");
    if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      throw new DomainError("You already have a report with this name.", 409);
    const report = { id: id(), name, filters };
    db.prepare(
      "INSERT INTO settings(org_id,scope,key,value) VALUES(?,?,?,?)",
    ).run(
      actor.org_id,
      `report:teams:${actor.id}`,
      report.id,
      JSON.stringify({ name, filters }),
    );
    return report;
  });
}
export function deleteTeamReport(db, actor, reportId) {
  const result = db
    .prepare("DELETE FROM settings WHERE org_id=? AND scope=? AND key=?")
    .run(actor.org_id, `report:teams:${actor.id}`, reportId);
  if (!result.changes) throw new DomainError("Saved report not found", 404);
}
export function installTeamReportRoutes(app, db) {
  app.get("/api/reports/team-properties/saved", (req, res) =>
    res.json(savedTeamReports(db, req.actor)),
  );
  app.post("/api/reports/team-properties/saved", (req, res) =>
    res.status(201).json(saveTeamReport(db, req.actor, req.body)),
  );
  app.delete("/api/reports/team-properties/saved/:id", (req, res) => {
    deleteTeamReport(db, req.actor, req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/reports/team-properties/date-limits", (req, res) =>
    res.json(teamReportDateLimits(db, req.actor.org_id)),
  );
  app.get("/api/reports/team-properties/fields", (req, res) =>
    res.json(teamReportFields(db, req.actor.org_id, req.query.program_id)),
  );
  app.get("/api/reports/team-properties", (req, res) =>
    res.json(teamPropertyReport(db, req.actor.org_id, req.query)),
  );
  app.get("/api/reports/team-properties.csv", (req, res) =>
    res
      .type("text/csv")
      .attachment("team-properties.csv")
      .send(teamReportCsv(teamPropertyReport(db, req.actor.org_id, req.query))),
  );
}

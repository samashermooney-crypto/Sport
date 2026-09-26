import { DomainError, saveEvent } from "./domain.mjs";
import { unpack, transaction, now, audit } from "./db.mjs";
import { createHash } from "node:crypto";
import { parseScheduleCsv } from "./schedule-csv.mjs";
import { z } from "zod";

const importPreviewSchema = z.object({
  csv: z.string(),
  program_id: z.string().min(1).optional(),
  mappings: z.record(z.string(), z.string().min(1)).default({}),
  cross_program: z.boolean().default(false),
});

// Preview only: all choices come from current organization data. Explicit IDs
// are checked against the same eligible set as automatic name matching.
export function previewScheduleImport(db, actor, input) {
  const { csv, program_id, mappings, cross_program } = importPreviewSchema.parse(input);
  const organization = db.prepare("SELECT timezone FROM organizations WHERE id=?").get(actor.org_id);
  if (!organization) throw new DomainError("Organization not found.", 404);
  const programs = db.prepare("SELECT * FROM programs WHERE org_id=? AND archived_at IS NULL").all(actor.org_id).map(unpack);
  const programById = new Map(programs.map((program) => [program.id, program]));
  const root = program_id ? programs.find((p) => p.id === program_id) : null;
  if (program_id && !root) throw new DomainError("Choose an available program.");
  const eligiblePrograms = root ? programs.filter((p) => p.id === root.id || p.parent_id === root.id) : programs;
  const teams = db.prepare("SELECT * FROM teams WHERE org_id=? AND json_extract(data,'$.archived_at') IS NULL").all(actor.org_id).map(unpack);
  const locations = db.prepare("SELECT * FROM locations WHERE org_id=? AND json_extract(data,'$.archived_at') IS NULL").all(actor.org_id).map(unpack);
  const parsed = parseScheduleCsv(csv, { timezone: organization.timezone });
  const issues = [...parsed.issues], choices = new Map(), resolutions = new Map(), rows = [];
  let issueCount = parsed.issue_count;
  const issue = (line, column, message) => { issueCount++; if (issues.length < 200) issues.push({ line, column, message }); };
  function resolve(kind, name, candidates, row, column, scope = "", required = false) {
    if (!name && !required) return null;
    const key = JSON.stringify([kind, scope, name]);
    const selected = Object.hasOwn(mappings, key) ? mappings[key] : undefined;
    const matches = resolutions.get(key) ?? (selected !== undefined
      ? candidates.filter((item) => item.id === selected)
      : candidates.filter((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase()));
    resolutions.set(key, matches);
    if (!choices.has(key)) choices.set(key, { key, kind, name, scope, selected_id: matches.length === 1 ? matches[0].id : null,
      options: candidates.map((item) => ({ id: item.id, name: kind === "team" && cross_program ? `${item.name} — ${programById.get(item.program_id)?.name || ""}` : item.name })).sort((a, b) => a.name.localeCompare(b.name)) });
    if (matches.length !== 1) {
      issue(row.line, column, selected !== undefined ? "The selected mapping is no longer available." : `Choose a ${kind} for ${name || "this activity"}.`);
      return null;
    }
    return matches[0];
  }
  for (const row of parsed.rows) {
    const before = issueCount;
    const program = !row.sub_program && root && !root.grouped ? root : resolve("program", row.sub_program, eligiblePrograms.filter((p) => !p.grouped), row, "SUB_PROGRAM", "", true);
    const candidates = program ? teams.filter((t) => t.program_id === program.id || (cross_program && programById.has(t.program_id))) : [];
    const home = program ? resolve("team", row.home_team, candidates, row, row.kind === "Game" ? "HOME_TEAM" : "TEAM", program.id, row.kind === "Game") : null;
    const away = program && row.kind === "Game" ? resolve("team", row.away_team, candidates, row, "AWAY_TEAM", program.id, true) : null;
    if (home && away && home.id === away.id) issue(row.line, "AWAY_TEAM", "Choose two different teams for a game.");
    if (program && (home || away) && ![home, away].some((team) => team?.program_id === program.id))
      issue(row.line, "TEAM", "At least one team must belong to this program.");
    const location = resolve("location", row.location, locations.filter((l) => !l.parent_id), row, "LOCATION", "", !!row.sub_location);
    const child = location && row.sub_location ? resolve("sub-location", row.sub_location, locations.filter((l) => l.parent_id === location.id), row, "SUB_LOCATION", location.id, true) : null;
    const title = row.title || `${home?.name || ""} vs ${away?.name || ""}`;
    if (before === issueCount && title.length > 150)
      issue(row.line, "NAME", "The generated activity title exceeds 150 characters. Shorten the team names before importing.");
    if (before === issueCount) rows.push({ ...row, title, program_id: program.id, program_name: program.name,
      home_team_id: home?.id || null, home_team_name: home?.name || "",
      away_team_id: away?.id || null, away_team_name: away?.name || "",
      location_id: child?.id || location?.id || null, location_name: location?.name || "", sub_location_name: child?.name || "" });
  }
  if (!issueCount) {
    // Exercise the same domain validation as acceptance in a rollback-only
    // transaction. Earlier rows participate in later rows' conflict checks.
    const rollback = new Error("Import preview rollback");
    try {
      transaction(db, () => {
        for (const row of rows) {
          try { saveEvent(db, actor, importEventInput(row, false)); }
          catch (error) {
            if (error instanceof DomainError) issue(row.line, "", error.message);
            else if (error instanceof z.ZodError) issue(row.line, "", error.issues.map((item) => item.message).join("; "));
            else throw error;
          }
        }
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  }
  return { kind: parsed.kind, timezone: organization.timezone, row_count: parsed.row_count,
    rows, mappings: [...choices.values()], issues, issue_count: issueCount, ready: issueCount === 0 };
}

export function installScheduleImportRoutes(app, db) {
  app.post("/api/schedule/import/preview", (req, res) => {
    res.json(previewScheduleImport(db, req.actor, req.body));
  });
  app.post("/api/schedule/import/accept", (req, res) => {
    try { res.json(acceptScheduleImport(db, req.actor, req.body)); }
    catch (error) {
      if (!error.import_not_saved) throw error;
      res.status(error.status || 400).json({ error: error.message, import_not_saved: true });
    }
  });
}

const acceptSchema = importPreviewSchema.extend({
  request_key: z.string().min(16).max(100),
  published: z.boolean().default(false),
});
const gameTypes = {
  REGULAR_SEASON: "Regular Season", PLAYOFF: "Playoff", CHAMPIONSHIP: "Championship",
  QUARTERFINAL: "Quarterfinals", SEMIFINAL: "Semifinals", FINAL: "Final",
  FRIENDLY: "Exhibition", SCRIMMAGE: "Scrimmage", TEAM_PRACTICE: "Exhibition",
  TOURNAMENT: "Tournament", POOL_PLAY: "Pool Play",
};
function importEventInput(row, published) {
  return { ...row, type: row.kind, game_type: gameTypes[row.activity_type] || "Regular Season", published };
}
export function acceptScheduleImport(db, actor, input) {
  const p = acceptSchema.parse(input);
  const hash = createHash("sha256").update(JSON.stringify({ ...p,
    mappings: Object.fromEntries(Object.entries(p.mappings).sort(([a], [b]) => a.localeCompare(b))),
  })).digest("hex");
  let newRequest = false;
  try { return transaction(db, () => {
    const previous = db.prepare("SELECT * FROM schedule_imports WHERE org_id=? AND request_key=?").get(actor.org_id, p.request_key);
    if (previous) {
      if (previous.request_hash !== hash) throw new DomainError("This import request was already used with different content.", 409);
      return JSON.parse(previous.result);
    }
    newRequest = true;
    const preview = previewScheduleImport(db, actor, p);
    if (!preview.ready) throw new DomainError(`CSV line ${preview.issues[0].line}: ${preview.issues[0].message} Resolve all ${preview.issue_count} import issues before accepting.`, 400);
    const ids = [];
    for (const row of preview.rows) {
      try {
        const event = saveEvent(db, actor, importEventInput(row, p.published));
        ids.push(event.id);
      } catch (error) {
        if (error instanceof DomainError) throw new DomainError(`CSV line ${row.line}: ${error.message}`, error.status);
        throw error;
      }
    }
    const result = { event_ids: ids, count: ids.length, published: p.published };
    db.prepare("INSERT INTO schedule_imports VALUES(?,?,?,?,?)").run(actor.org_id, p.request_key, hash, JSON.stringify(result), now());
    audit(db, actor, "import", "schedule", p.request_key, { count: ids.length, published: p.published });
    return result;
  }); } catch (error) {
    // Only known domain rejections after rollback authorize editing the payload.
    // Database/transport failures and reused keys retain the original request.
    if (newRequest && error instanceof DomainError) error.import_not_saved = true;
    throw error;
  }
}

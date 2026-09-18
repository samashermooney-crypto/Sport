import { z } from "zod";
import { audit, transaction, unpack } from "./db.mjs";
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export const rankingOptions = [
  "Standings Point Differential",
  "Winning Percentage",
  "Cumulative Match Game Winning Percentage",
];
export const tiebreakerOptions = [
  "More Points Scored",
  "More Wins",
  "Fewer Points Scored Against",
  "More Standings Points For",
  "Higher Points Scored Differential",
  "Head to Head",
  "More Match Game Wins",
  "Fewer Match Game Losses",
  "Higher Match Game Winning Percentage",
];
export const displayFields = [
  "played",
  "wins",
  "losses",
  "ties",
  "percentage",
  "scored",
  "against",
  "differential",
  "forfeits",
  "points_for",
  "points_against",
  "points_differential",
  "match_wins",
  "match_losses",
  "match_percentage",
];
const point = (value) => z.number().min(0).max(10000).default(value);
export const standingsSchema = z
  .object({
    version: z.number().int().positive().default(1),
    scoring_method: z.enum(["Game", "Match"]).default("Game"),
    ranking: z.enum(rankingOptions).default("Standings Point Differential"),
    percentage_format: z.enum(["100.00%", "1.000"]).default("100.00%"),
    win_points: point(3),
    overtime_win_points: point(3),
    loss_points: point(0),
    overtime_loss_points: point(0),
    tie_points: point(1),
    forfeit_deduction: point(0),
    tiebreakers: z
      .array(z.enum(tiebreakerOptions))
      .length(3)
      .default([
        "More Wins",
        "Higher Points Scored Differential",
        "Head to Head",
      ]),
    exclude_tournament: z.boolean().default(false),
    exclude_playoff: z.boolean().default(true),
    exclude_championship: z.boolean().default(true),
    include_cross_program: z.boolean().default(false),
    rank_by_division: z.boolean().default(false),
    points_based_percentage: z.boolean().default(false),
    fields: z
      .array(z.enum(displayFields))
      .min(1)
      .default([
        "played",
        "wins",
        "losses",
        "ties",
        "percentage",
        "scored",
        "against",
        "differential",
        "points_differential",
      ]),
    calendar_week_start: z.number().int().min(0).max(1).default(0),
  })
  .superRefine((rules, ctx) => {
    if (rules.points_based_percentage && rules.win_points <= 0)
      ctx.addIssue({
        code: "custom",
        message:
          "A points-based winning percentage requires positive points for a win.",
      });
  });
function scopeFor(db, org, programId) {
  if (!programId || programId === "site") return "site";
  if (
    !db
      .prepare("SELECT 1 FROM programs WHERE id=? AND org_id=?")
      .get(programId, org)
  )
    throw fail("Program not found", 404);
  return `program:${programId}`;
}
export function getStandingsRules(db, org, programId = "site") {
  const scope = scopeFor(db, org, programId);
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope=? AND key='standings'",
    )
    .get(org, scope);
  return standingsSchema.parse(row ? JSON.parse(row.value) : {});
}
export function snapshotStandingsRules(db, org, programId, sourceProgramId) {
  const rules = getStandingsRules(db, org, sourceProgramId || "site");
  db.prepare("INSERT OR IGNORE INTO settings VALUES(?,?,?,?)").run(
    org,
    `program:${programId}`,
    "standings",
    JSON.stringify({ ...rules, version: 1 }),
  );
}
export function saveStandingsRules(db, actor, programId, input) {
  const rules = standingsSchema.parse(input),
    scope = scopeFor(db, actor.org_id, programId);
  return transaction(db, () => {
    const before = getStandingsRules(db, actor.org_id, programId);
    if (rules.version !== before.version)
      throw fail("Standings rules changed. Reload before saving.", 409);
    const next = {
      ...rules,
      version: before.version + 1,
      fields: [...new Set(rules.fields)],
    };
    db.prepare(
      "INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(actor.org_id, scope, "standings", JSON.stringify(next));
    audit(db, actor, "standings.updated", "settings", scope, {
      version: next.version,
    });
    return next;
  });
}
export function getStandingsNote(db, org, programId) {
  if (!programId || programId === "site") throw fail("Program not found", 404);
  const scope = scopeFor(db, org, programId);
  const saved = db.prepare("SELECT value FROM settings WHERE org_id=? AND scope=? AND key='standings-note'").get(org, scope);
  return saved ? JSON.parse(saved.value) : { text: "", version: 1 };
}
export function saveStandingsNote(db, actor, programId, input) {
  const value = z.object({text: z.string().max(10000), version: z.number().int().positive()}).parse(input);
  const scope = scopeFor(db, actor.org_id, programId);
  return transaction(db, () => {
    const before = getStandingsNote(db, actor.org_id, programId);
    if (before.version !== value.version) throw fail("Standings note changed. Reload before saving.", 409);
    const next = {text: value.text.trim(), version: before.version + 1};
    db.prepare("INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value").run(actor.org_id, scope, "standings-note", JSON.stringify(next));
    audit(db, actor, "standings.note.updated", "settings", scope, {version: next.version});
    return next;
  });
}
export function getManualRanking(db, org, programId) {
  if (!programId || programId === "site") throw fail("Program not found",404);
  const scope=scopeFor(db,org,programId);
  const row=db.prepare("SELECT value FROM settings WHERE org_id=? AND scope=? AND key='manual-ranking'").get(org,scope);
  return row ? JSON.parse(row.value) : {enabled:false,ranks:{},version:1};
}
export function saveManualRanking(db, actor, programId, input) {
  const value=z.object({enabled:z.boolean(),ranks:z.record(z.string(),z.number().int().min(0).max(100000)),version:z.number().int().positive()}).parse(input);
  return transaction(db,()=>{
    const before=getManualRanking(db,actor.org_id,programId);
    if(before.version!==value.version) throw fail("Rankings changed. Reload before saving.",409);
    const ids=new Set(programStandings(db,actor.org_id,programId).groups.flatMap(g=>g.rows.map(r=>r.id)));
    if(Object.keys(value.ranks).some(id=>!ids.has(id))) throw fail("A ranked team does not belong to this program.");
    const next={...value,version:before.version+1};
    db.prepare("INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value").run(actor.org_id,scopeFor(db,actor.org_id,programId),"manual-ranking",JSON.stringify(next));
    audit(db,actor,"standings.ranking.updated","settings",`program:${programId}`,{enabled:next.enabled,version:next.version});
    return next;
  });
}
export const gameResultSchema = z.object({
  game_type: z
    .enum([
      "Regular Season",
      "Playoff",
      "Championship",
      "Quarterfinals",
      "Semifinals",
      "Final",
      "Pool Play",
      "Tournament",
      "Exhibition",
      "Scrimmage",
    ])
    .default("Regular Season"),
  overtime: z.boolean().default(false),
  forfeit: z.enum(["None", "Home", "Away", "Both"]).default("None"),
  exclude_home: z.boolean().default(false),
  exclude_away: z.boolean().default(false),
  match_scores: z
    .array(
      z.object({
        home: z.number().int().min(0).max(100000),
        away: z.number().int().min(0).max(100000),
      }),
    )
    .max(31)
    .default([]),
});
function eligible(event, rules) {
  const type = event.game_type || "Regular Season";
  return (
    event.type === "Game" &&
    event.state === "Completed" &&
    !["Exhibition", "Scrimmage"].includes(type) &&
    !(rules.exclude_tournament && type === "Tournament") &&
    !(
      rules.exclude_playoff &&
      ["Playoff", "Quarterfinals", "Semifinals"].includes(type)
    ) &&
    !(rules.exclude_championship && ["Championship", "Final"].includes(type)) &&
    ((Number.isFinite(event.home_score) && Number.isFinite(event.away_score)) ||
      event.match_scores?.length ||
      (event.forfeit && event.forfeit !== "None"))
  );
}
function result(event, rules) {
  const sets = event.match_scores || [];
  const homeGames = sets.length
    ? sets.filter((s) => s.home > s.away).length
    : rules.scoring_method === "Match"
      ? event.home_score || 0
      : 0;
  const awayGames = sets.length
    ? sets.filter((s) => s.away > s.home).length
    : rules.scoring_method === "Match"
      ? event.away_score || 0
      : 0;
  const tiedGames = sets.filter((s) => s.home === s.away).length;
  const homeScored = sets.length
    ? sets.reduce((n, s) => n + s.home, 0)
    : event.home_score || 0;
  const awayScored = sets.length
    ? sets.reduce((n, s) => n + s.away, 0)
    : event.away_score || 0;
  const h = rules.scoring_method === "Match" ? homeGames : homeScored;
  const a = rules.scoring_method === "Match" ? awayGames : awayScored;
  const forfeited = event.forfeit || "None";
  return {
    home:
      forfeited === "Both" || forfeited === "Home"
        ? "loss"
        : forfeited === "Away"
          ? "win"
          : h > a
            ? "win"
            : h < a
              ? "loss"
              : "tie",
    away:
      forfeited === "Both" || forfeited === "Away"
        ? "loss"
        : forfeited === "Home"
          ? "win"
          : a > h
            ? "win"
            : a < h
              ? "loss"
              : "tie",
    homeGames,
    awayGames,
    tiedGames,
    homeScored,
    awayScored,
  };
}
export function calculateStandings(teams, events, input) {
  const rules = standingsSchema.parse(input);
  const teamMap = new Map(
    teams.map((t) => [
      t.id,
      {
        id: t.id,
        name: t.name,
        program_id: t.program_id,
        division: t.division || "",
        played: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        scored: 0,
        against: 0,
        forfeits: 0,
        points_for: 0,
        points_against: 0,
        match_wins: 0,
        match_losses: 0,
        match_ties: 0,
      },
    ]),
  );
  const games = events.filter((e) => eligible(e, rules));
  const encounters = [];
  let gamesCounted = 0;
  for (const e of games) {
    const r = result(e, rules);
    const counted = [];
    for (const side of ["home", "away"]) {
      const row = teamMap.get(e[`${side}_team_id`]);
      if (!row || e[`exclude_${side}`]) continue;
      const crossProgram =
        e.home_program_id &&
        e.away_program_id &&
        e.home_program_id !== e.away_program_id;
      if (crossProgram && !rules.include_cross_program) continue;
      const outcome = r[side],
        home = side === "home",
        forfeited =
          e.forfeit === "Both" || e.forfeit === (home ? "Home" : "Away");
      row.played++;
      row[
        outcome === "win" ? "wins" : outcome === "loss" ? "losses" : "ties"
      ]++;
      row.scored += home ? r.homeScored : r.awayScored;
      row.against += home ? r.awayScored : r.homeScored;
      row.match_wins += home ? r.homeGames : r.awayGames;
      row.match_losses += home ? r.awayGames : r.homeGames;
      row.match_ties += r.tiedGames;
      const overtime = e.overtime && (!e.forfeit || e.forfeit === "None");
      row.points_for +=
        rules[
          outcome === "tie"
            ? "tie_points"
            : `${overtime ? "overtime_" : ""}${outcome}_points`
        ];
      if (forfeited) {
        row.forfeits++;
        row.points_against += rules.forfeit_deduction;
      }
      counted.push(row.id);
    }
    if (counted.length) gamesCounted++;
    if (counted.length === 2)
      encounters.push({
        home: e.home_team_id,
        away: e.away_team_id,
        homeResult: r.home,
        awayResult: r.away,
      });
  }
  const rows = [...teamMap.values()].map((r) => ({
    ...r,
    differential: r.scored - r.against,
    points_differential: r.points_for - r.points_against,
    percentage: r.played
      ? rules.points_based_percentage
        ? (r.points_for - r.points_against) / (r.played * rules.win_points)
        : (r.wins + r.ties / 2) / r.played
      : 0,
    match_percentage:
      r.match_wins + r.match_losses + r.match_ties
        ? (r.match_wins + r.match_ties / 2) /
          (r.match_wins + r.match_losses + r.match_ties)
        : 0,
  }));
  const metrics = {
    "Standings Point Differential": "points_differential",
    "Winning Percentage": "percentage",
    "Cumulative Match Game Winning Percentage": "match_percentage",
    "More Points Scored": "scored",
    "More Wins": "wins",
    "Fewer Points Scored Against": "against",
    "More Standings Points For": "points_for",
    "Higher Points Scored Differential": "differential",
    "More Match Game Wins": "match_wins",
    "Fewer Match Game Losses": "match_losses",
    "Higher Match Game Winning Percentage": "match_percentage",
  };
  function rankGroup(group, criteria, index = 0) {
    if (group.length < 2 || index === criteria.length)
      return [
        group.sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        ),
      ];
    const criterion = criteria[index],
      head = criterion === "Head to Head";
    let values = new Map();
    if (head) {
      const ids = new Set(group.map((r) => r.id));
      const meetings = encounters.filter(
        (e) => ids.has(e.home) && ids.has(e.away),
      );
      const pairs = group.flatMap((a, i) =>
        group
          .slice(i + 1)
          .map(
            (b) =>
              meetings.filter(
                (e) =>
                  [e.home, e.away].includes(a.id) &&
                  [e.home, e.away].includes(b.id),
              ).length,
          ),
      );
      // Use a balanced mini-table for multi-team ties; skip incomplete matchups.
      if (pairs.some((n) => !n || n !== pairs[0]))
        return rankGroup(group, criteria, index + 1);
      for (const row of group)
        values.set(
          row.id,
          meetings.reduce((sum, e) => {
            const outcome =
              e.home === row.id
                ? e.homeResult
                : e.away === row.id
                  ? e.awayResult
                  : "";
            return sum + (outcome === "win" ? 1 : outcome === "tie" ? 0.5 : 0);
          }, 0),
        );
    } else
      for (const row of group)
        values.set(
          row.id,
          row[metrics[criterion]] * (criterion.startsWith("Fewer") ? -1 : 1),
        );
    const buckets = new Map();
    for (const row of group) {
      const value = Number(values.get(row.id).toFixed(10));
      if (!buckets.has(value)) buckets.set(value, []);
      buckets.get(value).push(row);
    }
    return [...buckets]
      .sort(([a], [b]) => b - a)
      .flatMap(([, bucket]) => rankGroup(bucket, criteria, index + 1));
  }
  const divisions = rules.rank_by_division
    ? [...new Set(rows.map((r) => r.division))].sort()
    : [""];
  const groups = divisions.map((division) => {
    let rank = 1;
    const ranked = rankGroup(
      rules.rank_by_division
        ? rows.filter((r) => r.division === division)
        : rows,
      [rules.ranking, ...rules.tiebreakers],
    );
    return {
      division,
      rows: ranked.flatMap((bucket) => {
        const values = bucket.map((row) => ({
          ...row,
          rank,
          tied: bucket.length > 1,
        }));
        rank += bucket.length;
        return values;
      }),
    };
  });
  return { rules, groups, games_counted: gamesCounted };
}
export function programStandings(
  db,
  org,
  programId,
  { publicOnly = false, visibleProgramIds } = {},
) {
  scopeFor(db, org, programId);
  const program = db
    .prepare("SELECT * FROM programs WHERE id=? AND org_id=?")
    .get(programId, org);
  if (!program) throw fail("Program not found", 404);
  const ids = program.grouped
    ? db
        .prepare(
          "SELECT id FROM programs WHERE org_id=? AND parent_id=? AND archived_at IS NULL",
        )
        .all(org, programId)
        .map((p) => p.id)
    : [programId];
  const allowed = new Set(
    ids.filter((id) => !visibleProgramIds || visibleProgramIds.has(id)),
  );
  const teams = db
    .prepare(
      "SELECT t.id,t.name,t.division,t.program_id,p.name program_name FROM teams t JOIN programs p ON p.id=t.program_id AND p.org_id=t.org_id WHERE t.org_id=? AND p.archived_at IS NULL AND json_extract(t.data,'$.archived_at') IS NULL",
    )
    .all(org)
    .filter((t) => allowed.has(t.program_id))
    .map((t) => ({
      ...t,
      division: t.division || (program.grouped ? t.program_name : ""),
    }));
  const teamIds = new Set(teams.map((t) => t.id));
  const games = db
    .prepare(
      "SELECT e.*,h.program_id home_program_id,a.program_id away_program_id FROM events e LEFT JOIN teams h ON h.id=e.home_team_id LEFT JOIN teams a ON a.id=e.away_team_id WHERE e.org_id=? AND e.type='Game'",
    )
    .all(org)
    .map(unpack)
    .filter(
      (e) =>
        (teamIds.has(e.home_team_id) || teamIds.has(e.away_team_id)) &&
        (!publicOnly ||
          (e.published &&
            visibleProgramIds?.has(e.program_id) &&
            visibleProgramIds?.has(e.home_program_id) &&
            visibleProgramIds?.has(e.away_program_id))),
    );
  const calculated=calculateStandings(teams, games, getStandingsRules(db, org, programId));
  const savedRanking=getManualRanking(db,org,programId);
  const manualRanking={...savedRanking,ranks:Object.fromEntries(Object.entries(savedRanking.ranks).filter(([id])=>teamIds.has(id)))};
  if(manualRanking.enabled) for(const group of calculated.groups) {
    group.rows=group.rows.map(r=>({...r,rank:manualRanking.ranks[r.id] ?? 0,tied:false})).sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name));
  }
  return {
    program: { id: program.id, name: program.name },
    note: getStandingsNote(db, org, programId),
    manualRanking,
    ...calculated,
  };
}
export function installStandingsRoutes(app, db) {
  app.put("/api/programs/:id/standings/ranking",(req,res)=>res.json(saveManualRanking(db,req.actor,req.params.id,req.body)));
  app.put("/api/programs/:id/standings/note", (req, res) => res.json(saveStandingsNote(db, req.actor, req.params.id, req.body)));
  for (const p of db.prepare("SELECT id,org_id FROM programs").all())
    snapshotStandingsRules(db, p.org_id, p.id);
  app.get("/api/standings-rules/:program", (req, res) =>
    res.json(getStandingsRules(db, req.actor.org_id, req.params.program)),
  );
  app.put("/api/standings-rules/:program", (req, res) =>
    res.json(saveStandingsRules(db, req.actor, req.params.program, req.body)),
  );
  app.get("/api/programs/:id/standings", (req, res) =>
    res.json(programStandings(db, req.actor.org_id, req.params.id)),
  );
}

import test from "node:test";
import assert from "node:assert/strict";
import { openDb, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProgram, createTeam, saveEvent } from "./domain.mjs";
import {
  getManualRanking,
  saveManualRanking,
  getStandingsNote,
  saveStandingsNote,
  calculateStandings,
  getStandingsRules,
  saveStandingsRules,
  programStandings,
} from "./standings.mjs";

const teams = ["A", "B", "C", "D"].map((name) => ({
  id: name,
  name,
  program_id: "p",
  division: "North",
}));
const game = (home, away, h, a, extra = {}) => ({
  id: crypto.randomUUID(),
  type: "Game",
  state: "Completed",
  program_id: "p",
  home_program_id: "p",
  away_program_id: "p",
  home_team_id: home,
  away_team_id: away,
  home_score: h,
  away_score: a,
  ...extra,
});
const rows = (value) =>
  Object.fromEntries(value.groups.flatMap((g) => g.rows).map((r) => [r.id, r]));

test("standings distinguish scores, awarded points, overtime, ties and forfeit deductions", () => {
  const result = calculateStandings(
    teams,
    [
      game("A", "B", 3, 1),
      game("A", "C", 2, 2),
      game("B", "C", 1, 0, { overtime: true }),
      game("D", "A", null, null, { forfeit: "Home" }),
    ],
    { overtime_win_points: 2, overtime_loss_points: 1, forfeit_deduction: 2 },
  );
  const r = rows(result);
  assert.equal(result.games_counted, 4);
  assert.deepEqual(
    [
      r.A.played,
      r.A.wins,
      r.A.losses,
      r.A.ties,
      r.A.scored,
      r.A.against,
      r.A.points_for,
    ],
    [3, 2, 0, 1, 5, 3, 7],
  );
  assert.equal(r.A.percentage, 5 / 6);
  assert.equal(r.B.points_for, 2);
  assert.equal(r.C.points_for, 2);
  assert.equal(r.D.points_against, 2);
  assert.equal(r.D.points_differential, -2);
  assert.equal(r.D.forfeits, 1);
  const points = rows(
    calculateStandings(teams, [game("A", "B", 0, 0)], {
      points_based_percentage: true,
      win_points: 3,
      tie_points: 1,
    }),
  );
  assert.equal(points.A.percentage, 1 / 3);
});

test("standings exclude nonresults, selected game types, cross-program games and individual team results", () => {
  const result = calculateStandings(
    teams,
    [
      game("A", "B", 5, 0, { state: "Canceled" }),
      game("A", "B", 5, 0, { state: "Scheduled" }),
      game("A", "B", null, null),
      game("A", "B", 5, 0, { game_type: "Playoff" }),
      game("A", "B", 5, 0, { game_type: "Final" }),
      game("A", "B", 5, 0, { game_type: "Tournament" }),
      game("A", "B", 5, 0, { game_type: "Exhibition" }),
      game("A", "B", 5, 0, { away_program_id: "other" }),
      game("A", "B", 5, 0, { exclude_home: true }),
      game("C", "D", 0, 0, { forfeit: "Both" }),
    ],
    { exclude_tournament: true },
  );
  const r = rows(result);
  assert.equal(result.games_counted, 2);
  assert.equal(r.A.played, 0);
  assert.equal(r.B.played, 1);
  assert.equal(r.B.against, 5);
  assert.equal(r.C.losses, 1);
  assert.equal(r.D.losses, 1);
  assert.equal(r.C.wins, 0);
  assert.equal(r.C.forfeits, 1);
  const cross = rows(
    calculateStandings(
      teams,
      [game("A", "B", 5, 0, { away_program_id: "other" })],
      { include_cross_program: true },
    ),
  );
  assert.equal(cross.A.wins, 1);
});

test("match scoring uses individual game wins while retaining actual points scored", () => {
  const e = game("A", "B", null, null, {
    match_scores: [
      { home: 25, away: 20 },
      { home: 10, away: 25 },
      { home: 25, away: 20 },
    ],
  });
  const match = rows(
    calculateStandings(teams, [e], {
      scoring_method: "Match",
      ranking: "Cumulative Match Game Winning Percentage",
    }),
  );
  assert.equal(match.A.wins, 1);
  assert.equal(match.A.match_wins, 2);
  assert.equal(match.A.match_losses, 1);
  assert.equal(match.A.match_percentage, 2 / 3);
  assert.equal(match.A.scored, 60);
  assert.equal(match.A.against, 65);
  assert.equal(
    rows(calculateStandings(teams, [e], { scoring_method: "Game" })).B.wins,
    1,
  );
});

test("staged tiebreakers use deterministic head-to-head groups and retain shared ranks", () => {
  const settings = {
    ranking: "Winning Percentage",
    tiebreakers: [
      "Head to Head",
      "More Points Scored",
      "Fewer Points Scored Against",
    ],
  };
  const e = [game("A", "B", 2, 1), game("B", "C", 3, 0), game("C", "A", 4, 0)];
  const result = calculateStandings(teams.slice(0, 3), e, settings);
  assert.deepEqual(
    result.groups[0].rows.map((r) => [r.name, r.rank]),
    [
      ["B", 1],
      ["C", 2],
      ["A", 3],
    ],
  );
  assert.deepEqual(
    calculateStandings(
      [...teams.slice(0, 3)].reverse(),
      [...e].reverse(),
      settings,
    ).groups[0].rows.map((r) => r.name),
    ["B", "C", "A"],
  );
  const tied = calculateStandings(teams, [], settings);
  assert.ok(tied.groups[0].rows.every((r) => r.rank === 1 && r.tied));
  const direct = calculateStandings(
    teams.slice(0, 2),
    [game("A", "B", 1, 0), game("D", "A", 1, 0), game("B", "D", 1, 0)],
    settings,
  );
  assert.equal(direct.groups[0].rows[0].id, "A");
  const divisions = calculateStandings(
    teams.map((t, i) => ({ ...t, division: i < 2 ? "North" : "South" })),
    [game("A", "B", 1, 0), game("D", "C", 1, 0)],
    { rank_by_division: true },
  );
  assert.deepEqual(
    divisions.groups.map((g) => [g.division, g.rows[0].id, g.rows[0].rank]),
    [
      ["North", "A", 1],
      ["South", "D", 1],
    ],
  );
});

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('foreign','Other')",
  ).run();
  const actor = { id: "admin", org_id: "org" };
  const base = {
    name: "Season",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "All",
    season: "Fall",
    start_date: "2026-10-01",
    status: "Live",
    public: true,
  };
  const p = saveProgram(db, actor, base);
  const a = createTeam(db, actor, { program_id: p.id, name: "Alpha" }),
    b = createTeam(db, actor, { program_id: p.id, name: "Bravo" });
  const event = {
    program_id: p.id,
    type: "Game",
    title: "Alpha vs Bravo",
    home_team_id: a.id,
    away_team_id: b.id,
    start_at: "2026-10-01T18:00:00Z",
    end_at: "2026-10-01T19:00:00Z",
    state: "Completed",
    home_score: 3,
    away_score: 1,
    published: true,
  };
  return { db, actor, base, p, a, b, event };
}
test("saved rules snapshot new-program defaults and score changes validate before modifying events", () => {
  const { db, actor, base, p, a, event } = fixture();
  try {
    saveStandingsRules(db, actor, "site", { version: 1, win_points: 5 });
    const newer = saveProgram(db, actor, { ...base, name: "New season" });
    assert.equal(getStandingsRules(db, "org", p.id).win_points, 3);
    assert.equal(getStandingsRules(db, "org", newer.id).win_points, 5);
    const changed = saveStandingsRules(db, actor, p.id, {
      ...getStandingsRules(db, "org", p.id),
      forfeit_deduction: 2,
    });
    assert.throws(
      () => saveStandingsRules(db, actor, p.id, { ...changed, version: 1 }),
      /changed/,
    );
    const saved = saveEvent(db, actor, event);
    assert.equal(programStandings(db, "org", p.id).groups[0].rows[0].id, a.id);
    assert.throws(
      () => saveEvent(db, actor, { ...event, home_score: null }, saved.id),
      /both final scores/,
    );
    assert.equal(
      db.prepare("SELECT home_score FROM events WHERE id=?").get(saved.id)
        .home_score,
      3,
    );
    assert.throws(
      () =>
        saveEvent(db, actor, { ...event, game_type: "Pool Play" }, saved.id),
      /Tournament program/,
    );
    assert.equal(
      JSON.parse(
        db.prepare("SELECT data FROM events WHERE id=?").get(saved.id).data,
      ).game_type,
      "Regular Season",
    );
    const tournament = saveProgram(db, actor, {
      ...base,
      type: "Tournament",
      name: "Tournament",
    });
    const tournamentTeam = createTeam(db, actor, {
      program_id: tournament.id,
      name: "Tournament Alpha",
    });
    const tournamentOpponent = createTeam(db, actor, {
      program_id: tournament.id,
      name: "Tournament Bravo",
    });
    const pool = saveEvent(db, actor, {
      ...event,
      program_id: tournament.id,
      home_team_id: tournamentTeam.id,
      away_team_id: tournamentOpponent.id,
      game_type: "Pool Play",
      start_at: "2026-10-05T18:00:00Z",
      end_at: "2026-10-05T19:00:00Z",
    });
    assert.equal(pool.game_type, "Pool Play");
    assert.throws(() =>
      saveEvent(
        db,
        actor,
        { ...event, match_scores: [{ home: -1, away: 3 }] },
        saved.id,
      ),
    );
    assert.throws(
      () =>
        saveStandingsRules(db, { ...actor, org_id: "foreign" }, p.id, changed),
      /not found/,
    );
    assert.throws(() => programStandings(db, "foreign", p.id), /not found/);
    const crossTeam = createTeam(db, actor, {
      program_id: newer.id,
      name: "Crossover",
    });
    saveEvent(db, actor, { ...event, away_team_id: crossTeam.id }, saved.id);
    assert.equal(programStandings(db, "org", p.id).games_counted, 0);
    saveStandingsRules(db, actor, p.id, {
      ...changed,
      include_cross_program: true,
    });
    assert.equal(programStandings(db, "org", p.id).games_counted, 1);
  } finally {
    db.close();
  }
});

test("public standings expose only published results in visible programs", async () => {
  const { db, actor, base, p, a, event } = fixture();
  for (const org of ["org", "foreign"])
    db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
      org,
      org,
      "Admin",
      `${org}@example.com`,
      passwordHash("test-password"),
      "owner",
    );
  saveEvent(db, actor, {
    ...event,
    overtime: true,
    notes: "INTERNAL COACH NOTE",
  });
  saveEvent(db, actor, {
    ...event,
    title: "Unpublished result",
    published: false,
    home_score: 0,
    away_score: 4,
    start_at: "2026-10-02T18:00:00Z",
    end_at: "2026-10-02T19:00:00Z",
  });
  const privateProgram = saveProgram(db, actor, {
    ...base,
    name: "Private season",
    public: false,
  });
  const privateTeam = createTeam(db, actor, {
    program_id: privateProgram.id,
    name: "PRIVATE TEAM",
  });
  saveStandingsRules(db, actor, p.id, {
    ...getStandingsRules(db, "org", p.id),
    include_cross_program: true,
  });
  saveEvent(db, actor, {
    ...event,
    title: "Private opponent",
    away_team_id: privateTeam.id,
    start_at: "2026-10-03T18:00:00Z",
    end_at: "2026-10-03T19:00:00Z",
  });
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(
      root + `/api/public/sites/org/programs/${p.id}/standings`,
    );
    assert.equal(response.status, 200);
    const publicData = await response.json();
    assert.equal(publicData.games_counted, 1);
    assert.equal(rows(publicData)[a.id].played, 1);
    assert.equal(JSON.stringify(publicData).includes("PRIVATE TEAM"), false);
    const calendar = await (
      await fetch(root + "/api/public/sites/org/calendar")
    ).json();
    assert.equal(calendar.length, 1);
    assert.equal(calendar[0].overtime, true);
    assert.equal(calendar[0].home_score, 3);
    assert.equal(calendar[0].forfeit, "None");
    assert.deepEqual(calendar[0].match_scores, []);
    assert.doesNotMatch(
      JSON.stringify(calendar),
      /PRIVATE TEAM|INTERNAL COACH NOTE|home_program_id|away_program_id/,
    );
    assert.equal(
      (
        await fetch(
          root +
            `/api/public/sites/org/programs/${privateProgram.id}/standings`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(
          root + `/api/public/sites/foreign/programs/${p.id}/standings`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await fetch(root + `/api/programs/${p.id}/standings`)).status,
      401,
    );
    assert.equal((await fetch(root + "/api/standings-rules/site")).status, 401);
    assert.equal(programStandings(db, "org", p.id).games_counted, 3);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("standings notes preserve content, reject stale and foreign writes, and appear in public results", () => {
 const {db, actor, p} = fixture();
 try {
  assert.deepEqual(getStandingsNote(db, actor.org_id, p.id), {text:"",version:1});
  const saved = saveStandingsNote(db, actor, p.id, {text:"Schedule updated.\nFinals on Sunday.", version:1});
  assert.equal(saved.version,2);
  assert.throws(()=>saveStandingsNote(db,actor,"site",{text:"Wrong scope",version:1}),{status:404});
  assert.throws(()=>getStandingsNote(db,actor.org_id,"missing"),{status:404});
  assert.equal(programStandings(db, actor.org_id, p.id).note.text,saved.text);
  assert.equal(programStandings(db, actor.org_id, p.id,{publicOnly:true,visibleProgramIds:new Set([p.id])}).note.text,saved.text);
  assert.throws(()=>saveStandingsNote(db, actor,p.id,{text:"Stale",version:1}),{status:409});
  assert.throws(()=>saveStandingsNote(db,{...actor,org_id:"foreign"},p.id,{text:"Wrong org",version:2}),{status:404});
  assert.throws(()=>saveStandingsNote(db,actor,p.id,{text:"x".repeat(10001),version:2}));
  assert.equal(getStandingsNote(db,actor.org_id,p.id).text,saved.text);
  assert.equal(saveStandingsNote(db,actor,p.id,{text:"",version:2}).text,"");
 } finally {db.close();}
});

test("manual rankings override order without changing statistics and restore automatic ranking",()=>{
 const {db,actor,p,a,b,event}=fixture();
 try {
  saveEvent(db,actor,event);
  const before=programStandings(db,actor.org_id,p.id);
  const ranks={[a.id]:2,[b.id]:1};
  saveManualRanking(db,actor,p.id,{enabled:true,ranks,version:1});
  const result=programStandings(db,actor.org_id,p.id);
  assert.equal(result.groups[0].rows[0].id,b.id);
  assert.equal(result.groups[0].rows.find(r=>r.id===a.id).wins,before.groups[0].rows.find(r=>r.id===a.id).wins);
  assert.equal(programStandings(db,actor.org_id,p.id,{publicOnly:true,visibleProgramIds:new Set([p.id])}).groups[0].rows[0].id,b.id);
  assert.deepEqual(programStandings(db,actor.org_id,p.id,{publicOnly:true,visibleProgramIds:new Set()}).manualRanking.ranks,{});
  assert.throws(()=>saveManualRanking(db,actor,p.id,{enabled:true,ranks,version:1}),{status:409});
  assert.throws(()=>saveManualRanking(db,{...actor,org_id:"foreign"},p.id,{enabled:true,ranks,version:2}),{status:404});
  assert.throws(()=>saveManualRanking(db,actor,p.id,{enabled:true,ranks:{foreign:1},version:2}));
  assert.throws(()=>saveManualRanking(db,actor,p.id,{enabled:true,ranks:{[a.id]:-1},version:2}));
  assert.equal(getManualRanking(db,actor.org_id,p.id).version,2);
  saveManualRanking(db,actor,p.id,{enabled:false,ranks,version:2});
  assert.deepEqual(programStandings(db,actor.org_id,p.id).groups,before.groups);
 }finally{db.close();}
});

test("archived teams leave standings and rank responses while completed opponent results remain",()=>{
 const {db,actor,p,a,b,event}=fixture();
 try {
  saveEvent(db,actor,event);
  saveManualRanking(db,actor,p.id,{enabled:true,ranks:{[a.id]:1,[b.id]:2},version:1});
  db.prepare("UPDATE teams SET data=json_set(data,'$.archived_at',?) WHERE id=?").run(new Date().toISOString(),a.id);
  const result=programStandings(db,actor.org_id,p.id);
  assert.deepEqual(result.groups.flatMap(g=>g.rows.map(r=>r.id)),[b.id]);
  assert.equal(result.groups[0].rows[0].losses,1);
  assert.deepEqual(result.manualRanking.ranks,{[b.id]:2});
  assert.throws(()=>saveManualRanking(db,actor,p.id,{enabled:true,ranks:{[a.id]:1},version:2}));
  saveManualRanking(db,actor,p.id,{enabled:false,ranks:{[b.id]:2},version:2});
  assert.equal(programStandings(db,actor.org_id,p.id).groups[0].rows[0].rank,1);
 }finally{db.close();}
});

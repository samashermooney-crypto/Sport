import { id, now, passwordHash } from "./db.mjs";
import {
  saveProgram,
  createTeam,
  register,
  recordPayment,
  saveEvent,
} from "./domain.mjs";
// Demo records exist only for local development or an explicit demo request;
// production startup must never create known demo credentials accidentally.
export function shouldSeedDemo(env = process.env) {
  return (
    env.SEED_DEMO === "true" ||
    (env.NODE_ENV !== "production" && env.SEED_DEMO !== "false")
  );
}
export function seed(db) {
  if (db.prepare("SELECT id FROM organizations LIMIT 1").get()) return;
  const org = "fieldhouse-demo",
    actor = { org_id: org, id: "demo-admin" };
  db.prepare("INSERT INTO organizations VALUES(?,?,?,?)").run(
    org,
    "Northstar Youth Sports",
    "America/Chicago",
    "USD",
  );
  db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
    actor.id,
    org,
    "Alex Morgan",
    "admin@athlentry.local",
    passwordHash(process.env.DEMO_PASSWORD ?? "AthlentryDemo!2026"),
    "owner",
  );
  for (const [i, name] of [
    "Riverside Sports Complex",
    "North Park Fields",
    "Community Recreation Center",
  ].entries())
    db.prepare("INSERT INTO locations VALUES(?,?,?,?,?,?)").run(
      "location-" + i,
      org,
      null,
      name,
      ["100 Riverside Drive", "2400 Park Avenue", "800 Community Way"][i],
      JSON.stringify({ sport: "Soccer" }),
    );
  const configs = [
    ["Fall Recreational Soccer", "Club team", true, 0],
    ["U10 Fall Soccer", "Club team", false, 9500],
    ["U12 Fall Soccer", "Club team", false, 12500],
    ["Winter Skills Academy", "Class", false, 7500],
    ["Fall Coach Registration", "Event", false, 0],
    ["Community Soccer League", "League", false, 9500],
    ["Summer Development Camp", "Camp", false, 18000],
  ];
  const programs = [];
  for (const [index, [name, type, grouped, fee_cents]] of configs.entries()) {
    const p = saveProgram(db, actor, {
      name,
      type,
      sport: "Soccer",
      gender: "Co-Ed",
      level: "Recreational",
      season: index === 6 ? "Summer" : index === 3 ? "Winter" : "Fall",
      grouped,
      status: index === 6 ? "Completed" : index === 3 ? "Unpublished" : "Live",
      parent_id: index === 1 || index === 2 ? programs[0].id : null,
      start_date:
        index === 6 ? "2026-06-08" : index === 3 ? "2026-12-01" : "2026-09-12",
      end_date:
        index === 6 ? "2026-07-20" : index === 3 ? "2027-02-01" : "2026-11-14",
      registration_start: "2026-06-01",
      registration_end: "2026-09-15",
      fee_cents,
      capacity: 60,
      location_id: "location-0",
      description:
        "A welcoming season of soccer, teamwork, and player development. All experience levels are welcome.",
      days: ["Sat"],
      start_time: "09:00",
      end_time: "12:00",
    });
    programs.push(p);
  }
  const teams = [];
  for (const [i, name] of [
    "Riverside United",
    "North Park Falcons",
    "Lakeside FC",
    "Cedar Grove Stars",
  ].entries())
    teams.push(
      createTeam(db, actor, {
        program_id: programs[5].id,
        name,
        division: "Open Division",
      }),
    );
  for (const p of [programs[1], programs[2]])
    for (const name of ["Bluebirds", "Lions", "Comets"])
      createTeam(db, actor, {
        program_id: p.id,
        name: p.name.split(" ")[0] + " " + name,
        division: p.name.split(" ")[0],
      });
  const first = [
    "Avery",
    "Jordan",
    "Riley",
    "Cameron",
    "Morgan",
    "Parker",
    "Taylor",
    "Casey",
    "Quinn",
    "Reese",
    "Jamie",
    "Skyler",
    "Rowan",
    "Emerson",
    "Dakota",
    "Finley",
  ];
  const last = [
    "Bennett",
    "Chen",
    "Patel",
    "Rivera",
    "Wilson",
    "Brooks",
    "Kim",
    "Garcia",
  ];
  first.forEach((name, i) => {
    const personId = id(),
      house = id();
    db.prepare("INSERT INTO households VALUES(?,?,?)").run(
      house,
      org,
      last[i % 8] + " Family",
    );
    db.prepare("INSERT INTO people VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      personId,
      org,
      house,
      name,
      last[i % 8],
      `family${i + 1}@example.com`,
      `2015-${String((i % 9) + 1).padStart(2, "0")}-15`,
      i % 2 ? "Female" : "Male",
      "player",
      "{}",
      now(),
    );
    const reg = register(db, actor, {
      program_id: programs[5].id,
      person_id: personId,
      team_id: teams[i % 4].id,
      role: "Team Player",
      waiver_accepted: i % 5 !== 0,
    });
    if (i < 12)
      recordPayment(db, actor, reg.invoice_id, {
        amount_cents: 9500,
        method: "Check",
        reference: "Sample receipt " + (i + 1),
        idempotency_key: "seed-payment-" + i,
      });
    if (i < 8)
      register(db, actor, { program_id: programs[1].id, person_id: personId });
  });
  for (let week = 0; week < 4; week++)
    for (let match = 0; match < 2; match++) {
      const day = new Date(Date.UTC(2026, 8, 12 + week * 7, 14 + match * 2)),
        end = new Date(day.getTime() + 90 * 60000);
      saveEvent(db, actor, {
        program_id: programs[5].id,
        type: "Game",
        title: teams[match * 2].name + " vs " + teams[match * 2 + 1].name,
        home_team_id: teams[match * 2].id,
        away_team_id: teams[match * 2 + 1].id,
        location_id: "location-0",
        start_at: day.toISOString(),
        end_at: end.toISOString(),
        published: true,
      });
    }
}

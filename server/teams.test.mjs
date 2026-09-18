import { listProgramStaff } from "./program-staff.mjs";
import { listRegistrations } from "./registration-list.mjs";
import { teamPermissions } from "./team-permissions.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { savePerson } from "./directory.mjs";
import { saveProgram, createTeam, register } from "./domain.mjs";
import {
  copyTeam,
  assignRoster,
  assignStaff,
  teamProfile,
  updateTeam,
  listTeams,
  setPrimaryStaff,
  saveRosterSettings,
} from "./teams.mjs";
function fixture() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "org",
    "Club",
  );
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "other",
    "Other",
  );
  const actor = { id: "admin", org_id: "org" },
    other = { id: "admin2", org_id: "other" };
  const program = saveProgram(db, actor, {
    name: "League",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "All",
    season: "Fall",
    start_date: "2026-10-01",
    fee_cents: 1000,
    capacity: 2,
  });
  const person = (name) =>
    savePerson(db, actor, { first_name: name, last_name: "Example" });
  const one = createTeam(db, actor, { name: "One", program_id: program.id }),
    two = createTeam(db, actor, { name: "Two", program_id: program.id });
  return { db, actor, other, program, person, one, two };
}
test("primary staff is a single active assignment scoped to the team and organization", () => {
  const { db, actor, other, person, one, two } = fixture();
  const coach = person("Coach"), volunteer = person("Volunteer"), outsider = person("Unassigned");
  assignStaff(db, actor, one.id, {person_id: coach.id, role: "Coach"});
  assignStaff(db, actor, one.id, {person_id: volunteer.id, role: "Volunteer"});
  setPrimaryStaff(db, actor, one.id, {person_id: coach.id});
  assert.equal(listTeams(db, actor.org_id).find(t => t.id === one.id).primary_staff.person_id, coach.id);
  const changed = setPrimaryStaff(db, actor, one.id, {person_id: volunteer.id});
  assert.deepEqual(changed.staff.filter(s => s.is_primary).map(s => s.person_id), [volunteer.id]);
  assert.throws(() => setPrimaryStaff(db, actor, two.id, {person_id: coach.id}), /assigned/);
  assert.throws(() => setPrimaryStaff(db, actor, one.id, {person_id: outsider.id}), /assigned/);
  assert.throws(() => setPrimaryStaff(db, other, one.id, {person_id: coach.id}));
  db.prepare("UPDATE people SET data=json_set(data,'$.archived_at','2026-09-08') WHERE id=?").run(volunteer.id);
  assert.equal(listTeams(db, actor.org_id).find(t => t.id === one.id).primary_staff, null);
  assert.throws(() => setPrimaryStaff(db, actor, one.id, {person_id: volunteer.id}), /active/);
  db.prepare("UPDATE people SET data=json_remove(data,'$.archived_at') WHERE id=?").run(volunteer.id);
  assert.equal(listTeams(db, actor.org_id).find(t => t.id === one.id).primary_staff, null,
    "restoring a person must not restore an old primary designation");
  assert.equal(setPrimaryStaff(db, actor, one.id, {person_id: null}).staff.some(s => s.is_primary), false);
  db.close();
});
test("primary designation clears on assignment loss and does not return on reassignment", () => {
  const {db, actor, person, program, one, two} = fixture();
  const coach = person("Lifecycle");
  const registration = register(db, actor, {person_id: coach.id, program_id: program.id, team_id: one.id, role: "Coach"});
  db.prepare("UPDATE registrations SET status='Confirmed' WHERE id=?").run(registration.id);
  const primary = () => listTeams(db, actor.org_id).find(t => t.id === one.id).primary_staff;
  setPrimaryStaff(db, actor, one.id, {person_id: coach.id});
  db.prepare("UPDATE registrations SET team_id=? WHERE id=?").run(two.id, registration.id);
  db.prepare("UPDATE registrations SET team_id=? WHERE id=?").run(one.id, registration.id);
  assert.equal(primary(), null);
  setPrimaryStaff(db, actor, one.id, {person_id: coach.id});
  assignStaff(db, actor, one.id, {person_id: coach.id, role: "Coach"});
  db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(registration.id);
  assert.equal(primary().person_id, coach.id, "direct assignment retains designation");
  db.prepare("DELETE FROM team_staff WHERE team_id=?").run(one.id);
  assert.equal(primary(), null);
  db.prepare("UPDATE registrations SET status='Confirmed' WHERE id=?").run(registration.id);
  assert.equal(primary(), null);
  setPrimaryStaff(db, actor, one.id, {person_id: coach.id});
  db.prepare("UPDATE registrations SET role='Team Player' WHERE id=?").run(registration.id);
  assert.equal(primary(), null);
  db.close();
});
test("roster settings reject stale saves without overwriting visibility", () => {
  const {db,actor,other,program}=fixture();
  const input={version:1,fields:['name'],parent_contacts:false,allow_staff_print:false,foreground:'#ffffff',background:'#206334',website:{audience:'Primary Staff Only',fields:[{key:'name',visibility:'Primary Staff Only'}]}};
  const saved=saveRosterSettings(db,actor,program.id,input);
  assert.equal(saved.version,2);
  assert.throws(()=>saveRosterSettings(db,actor,program.id,{...input,website:{audience:'Public',fields:[]}}),/changed/);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE scope=? AND key='roster'").get('program:'+program.id).value).website.audience,'Primary Staff Only');
  assert.throws(()=>saveRosterSettings(db,other,program.id,saved));
  assert.equal(saveRosterSettings(db,actor,program.id,saved).version,3);
  db.close();
});
test("global teams includes live and upcoming programs while program views retain history", () => {
  const {db,actor,program,one}=fixture();
  for (const status of ['Live','Upcoming','Completed','Unpublished']) {
    db.prepare('UPDATE programs SET status=? WHERE id=?').run(status,program.id);
    assert.equal(listTeams(db,actor.org_id).some(t=>t.id===one.id),['Live','Upcoming'].includes(status));
    assert.equal(listTeams(db,actor.org_id,program.id).some(t=>t.id===one.id),true);
  }
  db.prepare("UPDATE programs SET archived_at='2026-09-08' WHERE id=?").run(program.id);
  assert.equal(listTeams(db,actor.org_id,program.id).length,0);
  db.close();
});
test("team listing includes scoped active staff and omits archived contacts", () => {
  const {db,actor,person,one} = fixture();
  try {
    const coach = person("Coach");
    assignStaff(db,actor,one.id,{person_id:coach.id,role:"Coach"});
    assert.equal(listTeams(db,actor.org_id).find(t=>t.id===one.id).staff[0].person_id,coach.id);
    assert.deepEqual(listTeams(db,"other"),[]);
    db.prepare("UPDATE people SET data=json_set(data,'$.archived_at','2026-09-08') WHERE id=?").run(coach.id);
    assert.deepEqual(listTeams(db,actor.org_id).find(t=>t.id===one.id).staff,[]);
  } finally { db.close(); }
});
test("roster movement is atomic, preserves invoices, and rejects stale or locked changes", () => {
  const { db, actor, other, program, person, one, two } = fixture();
  try {
    const a = register(db, actor, {
        person_id: person("A").id,
        program_id: program.id,
        team_id: one.id,
      }),
      b = register(db, actor, {
        person_id: person("B").id,
        program_id: program.id,
        team_id: one.id,
      });
    const move = (r) => ({
      registration_id: r.id,
      expected_team_id: one.id,
      team_id: two.id,
    });
    assert.throws(
      () =>
        assignRoster(db, actor, {
          changes: [move(a), { ...move(b), expected_team_id: null }],
        }),
      /roster changed/,
    );
    assert.equal(
      db.prepare("SELECT team_id FROM registrations WHERE id=?").get(a.id)
        .team_id,
      one.id,
    );
    assignRoster(db, actor, { changes: [move(a), move(b)] });
    assert.equal(teamProfile(db, actor, two.id).roster.length, 2);
    assert.equal(
      db.prepare("SELECT invoice_id FROM registrations WHERE id=?").get(a.id)
        .invoice_id,
      a.invoice_id,
    );
    db.prepare("UPDATE teams SET locked=1 WHERE id=?").run(two.id);
    assert.throws(
      () =>
        assignRoster(db, actor, {
          changes: [
            { registration_id: a.id, expected_team_id: two.id, team_id: null },
          ],
        }),
      /Unlock/,
    );
    assert.throws(
      () =>
        assignRoster(db, other, {
          changes: [
            { registration_id: a.id, expected_team_id: two.id, team_id: null },
          ],
        }),
      /not found/,
    );
  } finally {
    db.close();
  }
});
test("team payment totals count each active invoice once and exclude canceled or voided billing", () => {
  const { db, actor, program, person, one } = fixture();
  try {
    const a = register(db, actor, {
      person_id: person("A").id, program_id: program.id, team_id: one.id,
    });
    const b = register(db, actor, {
      person_id: person("B").id, program_id: program.id, team_id: one.id,
    });
    db.prepare("UPDATE invoices SET paid_cents=400 WHERE id=?").run(a.invoice_id);
    assert.equal(teamProfile(db, actor, one.id).invoiced, 2000);
    assert.equal(teamProfile(db, actor, one.id).paid, 400);
    db.prepare("UPDATE registrations SET invoice_id=? WHERE id=?").run(a.invoice_id, b.id);
    let profile = teamProfile(db, actor, one.id);
    assert.equal(profile.roster.length, 2);
    assert.equal(profile.invoiced, 1000);
    assert.equal(profile.paid, 400);
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(a.id);
    assert.equal(teamProfile(db, actor, one.id).invoiced, 1000);
    db.prepare("UPDATE invoices SET voided=1 WHERE id=?").run(a.invoice_id);
    profile = teamProfile(db, actor, one.id);
    assert.equal(profile.invoiced, 0);
    assert.equal(profile.paid, 0);
    db.prepare("UPDATE invoices SET voided=0 WHERE id=?").run(a.invoice_id);
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(b.id);
    assert.equal(teamProfile(db, actor, one.id).invoiced, 0);
  } finally {
    db.close();
  }
});
test("staff assignment does not consume player capacity or create an invoice", () => {
  const { db, actor, program, person, one } = fixture();
  try {
    const p = person("Coach");
    assignStaff(db, actor, one.id, { person_id: p.id, role: "Coach" });
    assert.equal(teamProfile(db, actor, one.id).staff.length, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM invoices").get().n, 0);
    register(db, actor, {
      person_id: person("Player1").id,
      program_id: program.id,
    });
    register(db, actor, {
      person_id: person("Player2").id,
      program_id: program.id,
    });
    const coach = register(db, actor, {
      person_id: p.id,
      program_id: program.id,
      role: "Coach",
    });
    assert.equal(coach.status, "Confirmed");
    assert.equal(coach.invoice_id, null);
    assert.equal(db.prepare("SELECT count(*) n FROM invoices").get().n, 2);
    const updated = updateTeam(db, actor, one.id, {
      name: "Renamed",
      description: "New description",
    });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.id, one.id);
  } finally {
    db.close();
  }
});

test("captain permissions inherit, detach, reattach and authorize only assigned captains", async () => {
  const {
    teamPermissions,
    saveTeamPermissions,
    renameMemberTeam,
    memberTeams,
  } = await import("./team-permissions.mjs");
  const { getRules, saveRules } = await import("./program-rules.mjs");
  const { db, actor, other, program, person, one, two } = fixture();
  try {
    const captain = person("Captain"),
      stranger = person("Stranger");
    assignStaff(db, actor, one.id, { person_id: captain.id, role: "Captain" });
    const account = {
      id: "member",
      org_id: actor.org_id,
      person_id: captain.id,
    };
    const changeProgram = (enabled) =>
      saveRules(
        db,
        actor,
        {
          ...getRules(db, actor.org_id, program),
          captain_permissions: { edit_name: enabled },
        },
        program.id,
      );
    assert.equal(
      teamPermissions(db, actor.org_id, one.id).permissions.edit_name,
      false,
    );
    assert.throws(
      () =>
        renameMemberTeam(db, account, one.id, {
          name: "Renamed",
          expected_name: "One",
        }),
      /not permitted/,
    );
    assert.deepEqual(
      memberTeams(db, { ...account, person_id: stranger.id }),
      [],
    );
    assert.equal(memberTeams(db, account).length, 1);
    changeProgram(true);
    assert.deepEqual(Object.keys(memberTeams(db, account)[0]).sort(), [
      "can_edit_name",
      "can_view_roster",
      "id",
      "name",
      "program_name",
    ]);
    assert.equal(memberTeams(db, account)[0].can_edit_name, true);
    assert.equal(
      teamPermissions(db, actor.org_id, one.id).permissions.edit_name,
      true,
    );
    assert.throws(
      () =>
        renameMemberTeam(db, { ...account, person_id: stranger.id }, one.id, {
          name: "Renamed",
          expected_name: "One",
        }),
      /not permitted/,
    );
    assert.throws(
      () =>
        renameMemberTeam(db, account, two.id, {
          name: "Renamed",
          expected_name: "Two",
        }),
      /not permitted/,
    );
    assert.throws(
      () => teamPermissions(db, other.org_id, one.id),
      /not found/i,
    );
    assert.throws(
      () =>
        renameMemberTeam(db, account, one.id, {
          name: "Renamed",
          expected_name: "Old",
        }),
      /changed/,
    );
    assert.equal(
      renameMemberTeam(db, account, one.id, {
        name: "Renamed",
        expected_name: "One",
      }).name,
      "Renamed",
    );
    const detached = saveTeamPermissions(db, actor, one.id, {
      version: 1,
      detached: true,
      permissions: { edit_name: true },
    });
    changeProgram(false);
    assert.equal(
      teamPermissions(db, actor.org_id, one.id).permissions.edit_name,
      true,
    );
    assert.equal(
      teamPermissions(db, actor.org_id, two.id).permissions.edit_name,
      false,
    );
    assert.throws(
      () =>
        saveTeamPermissions(db, actor, one.id, {
          version: 1,
          detached: false,
          permissions: {},
        }),
      /changed/,
    );
    db.prepare("UPDATE teams SET locked=1 WHERE id=?").run(one.id);
    assert.throws(
      () =>
        renameMemberTeam(db, account, one.id, {
          name: "Locked rename",
          expected_name: "Renamed",
        }),
      /locked/,
    );
    saveTeamPermissions(db, actor, one.id, {
      version: detached.version,
      detached: false,
      permissions: { edit_name: true },
    });
    assert.equal(
      teamPermissions(db, actor.org_id, one.id).permissions.edit_name,
      false,
    );
    changeProgram(true);
    assert.equal(
      teamPermissions(db, actor.org_id, one.id).permissions.edit_name,
      true,
    );
  } finally {
    db.close();
  }
});

test("team creation persists detached captain settings atomically", () => {
  const { db, actor, program } = fixture();
  try {
    const detached = createTeam(db, actor, {
      program_id: program.id,
      name: "Detached at creation",
      captain_settings: { detached: true, permissions: { edit_name: true } },
    });
    assert.equal(
      teamPermissions(db, actor.org_id, detached.id).permissions.edit_name,
      true,
    );
    const inherited = createTeam(db, actor, {
      program_id: program.id,
      name: "Inherited at creation",
      captain_settings: { detached: false, permissions: { edit_name: true } },
    });
    assert.equal(
      teamPermissions(db, actor.org_id, inherited.id).permissions.edit_name,
      false,
    );
    const count = () => db.prepare("SELECT count(*) AS n FROM teams").get().n;
    const before = count();
    assert.throws(() =>
      createTeam(db, actor, {
        program_id: program.id,
        name: "Invalid permission",
        captain_settings: { detached: true, permissions: { edit_name: "yes" } },
      }),
    );
    assert.equal(count(), before);
    db.exec(
      "CREATE TRIGGER reject_captain_settings BEFORE INSERT ON settings WHEN NEW.key='captain_permissions' BEGIN SELECT RAISE(ABORT,'simulated settings failure'); END",
    );
    assert.throws(
      () =>
        createTeam(db, actor, {
          program_id: program.id,
          name: "Rolled back team",
          captain_settings: {
            detached: true,
            permissions: { edit_name: true },
          },
        }),
      /simulated settings failure/,
    );
    assert.equal(count(), before);
  } finally {
    db.close();
  }
});

test("team copies choose a scoped destination and inherit its captain settings", () => {
  const { db, actor, other, program, one } = fixture();
  try {
    const source = createTeam(db, actor, {
      program_id: program.id,
      name: "Source override",
      captain_settings: { detached: true, permissions: { edit_name: true } },
    });
    const destination = saveProgram(db, actor, {
      name: "Destination",
      type: "League",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "All",
      season: "Fall",
      start_date: "2026-10-01",
      fee_cents: 1000,
      capacity: 2,
    });
    const copied = copyTeam(db, actor, source.id, {
      name: "Destination copy",
      program_id: destination.id,
    });
    assert.equal(copied.program_id, destination.id);
    assert.equal(teamPermissions(db, actor.org_id, copied.id).detached, false);
    assert.equal(
      teamPermissions(db, actor.org_id, copied.id).permissions.edit_name,
      false,
    );
    assert.equal(
      teamPermissions(db, actor.org_id, source.id).permissions.edit_name,
      true,
    );
    const foreign = saveProgram(db, other, {
      name: "Foreign",
      type: "League",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "All",
      season: "Fall",
      start_date: "2026-10-01",
      fee_cents: 1000,
      capacity: 2,
    });
    assert.throws(() =>
      copyTeam(db, actor, source.id, {
        name: "Forbidden",
        program_id: foreign.id,
      }),
    );
    assert.throws(() => copyTeam(db, other, source.id, { name: "Forbidden" }));
    db.prepare("UPDATE programs SET archived_at='2026-09-07' WHERE id=?").run(
      destination.id,
    );
    assert.throws(
      () =>
        copyTeam(db, actor, source.id, {
          name: "Archived destination",
          program_id: destination.id,
        }),
      /active/,
    );
    assert.equal(
      copyTeam(db, actor, one.id, { name: "Same program copy" }).program_id,
      program.id,
    );
  } finally {
    db.close();
  }
});

test("family team visibility excludes other supervisors and never grants their captain permission", async () => {
  const { memberTeams, renameMemberTeam, saveTeamPermissions } =
    await import("./team-permissions.mjs");
  const { db, actor, program, person, one, two } = fixture();
  try {
    const parent = person("Parent"),
      child = person("Child"),
      supervisor = person("Other supervisor");
    db.prepare("INSERT INTO households VALUES('family',?,'Family')").run(
      actor.org_id,
    );
    for (const [id, role] of [
      [parent.id, "Supervisor"],
      [child.id, "Member"],
      [supervisor.id, "Supervisor"],
    ])
      db.prepare("INSERT INTO household_members VALUES(?,?,?)").run(
        "family",
        id,
        role,
      );
    const account = {
      id: "account",
      org_id: actor.org_id,
      person_id: parent.id,
    };
    assignStaff(db, actor, one.id, { person_id: child.id, role: "Captain" });
    assignStaff(db, actor, two.id, {
      person_id: supervisor.id,
      role: "Captain",
    });
    saveTeamPermissions(db, actor, one.id, {
      version: 1,
      detached: true,
      permissions: { edit_name: true },
    });
    const teams = memberTeams(db, account);
    assert.deepEqual(
      teams.map((t) => t.id),
      [one.id],
    );
    assert.equal(teams[0].can_edit_name, false);
    assert.throws(
      () =>
        renameMemberTeam(db, account, one.id, {
          name: "Denied",
          expected_name: one.name,
        }),
      /not permitted/,
    );
    db.prepare("UPDATE programs SET archived_at='2026-09-07' WHERE id=?").run(
      program.id,
    );
    assert.deepEqual(memberTeams(db, account), []);
    db.prepare("UPDATE programs SET archived_at=NULL WHERE id=?").run(
      program.id,
    );
    db.prepare(
      "UPDATE people SET data=json_set(data,'$.archived_at','2026-09-07') WHERE id=?",
    ).run(child.id);
    assert.deepEqual(memberTeams(db, account), []);
  } finally {
    db.close();
  }
});

test("team gender totals count confirmed players separately from pending and staff", async () => {
  const { listTeams } = await import("./teams.mjs");
  const { db, actor, program, one, person } = fixture();
  try {
    for (const [index, gender] of [
      "Male",
      "Female",
      "Non-binary",
      "Unknown",
    ].entries()) {
      const p = person("Player" + index);
      db.prepare("UPDATE people SET gender=? WHERE id=?").run(gender, p.id);
      db.prepare(
        "INSERT INTO registrations(id,org_id,program_id,person_id,team_id,role,status,created_at) VALUES(?,?,?,?,?,'Team Player','Confirmed','2026-09-07')",
      ).run("reg" + index, actor.org_id, program.id, p.id, one.id);
    }
    const pending = person("Pending");
    register(db, actor, { person_id: pending.id, program_id: program.id });
    db.prepare(
      "UPDATE registrations SET team_id=?,status='Pending' WHERE person_id=?",
    ).run(one.id, pending.id);
    assignStaff(db, actor, one.id, {
      person_id: person("Coach").id,
      role: "Coach",
    });
    const row = listTeams(db, actor.org_id, program.id).find(
      (t) => t.id === one.id,
    );
    assert.deepEqual(
      [
        row.players,
        row.pending,
        row.players_male,
        row.players_female,
        row.players_nonbinary,
        row.players_unknown,
      ],
      [4, 1, 1, 1, 1, 1],
    );
  } finally {
    db.close();
  }
});

test("editing team details and captain permissions commits or rolls back together", () => {
  const {db,actor,one,two}=fixture();
  try {
    const settings={version:1,detached:true,permissions:{edit_name:true}};
    assert.throws(()=>updateTeam(db,actor,one.id,{name:two.name,captain_settings:settings}));
    assert.equal(teamPermissions(db,actor.org_id,one.id).version,1);
    assert.equal(teamPermissions(db,actor.org_id,one.id).detached,false);
    updateTeam(db,actor,one.id,{name:'Updated together',captain_settings:settings});
    assert.equal(teamPermissions(db,actor.org_id,one.id).permissions.edit_name,true);
    assert.throws(()=>updateTeam(db,actor,one.id,{name:'Stale overwrite',captain_settings:settings}),/changed/);
    assert.equal(teamProfile(db,actor,one.id).name,'Updated together');
    assert.equal(teamPermissions(db,actor.org_id,one.id).version,2);
    assert.equal(Object.hasOwn(teamProfile(db,actor,one.id),'captain_settings'),false);
  } finally {db.close();}
});

test("registration lists expose active scoped billing and retain voided registration history", () => {
  const {db, actor, other, program, person, one} = fixture();
  try {
    const registration = register(db, actor, {person_id: person("Registrant").id, program_id: program.id, team_id: one.id});
    let rows = listRegistrations(db, actor.org_id, program.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].invoice_id, registration.invoice_id);
    assert.equal(rows[0].total_cents, 1000);
    assert.equal(rows[0].team_name, one.name);
    const originalRole = rows[0].role;
    assert.equal(rows[0].original_role, originalRole);
    db.prepare("UPDATE registrations SET role='Captain' WHERE id=?").run(registration.id);
    assert.equal(listRegistrations(db, actor.org_id)[0].original_role, originalRole);
    db.prepare("UPDATE audit_log SET details=json_remove(details,'$.role') WHERE entity_id=? AND action='register'").run(registration.id);
    assert.equal(listRegistrations(db, actor.org_id)[0].original_role, null);
    assert.deepEqual(listRegistrations(db, other.org_id), []);
    assert.deepEqual(listRegistrations(db, actor.org_id, "unrelated"), []);
    db.prepare("UPDATE invoices SET voided=1 WHERE id=?").run(registration.invoice_id);
    rows = listRegistrations(db, actor.org_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].invoice_id, null);
    assert.equal(rows[0].total_cents, null);
    assert.equal(rows[0].paid_cents, null);
    assert.equal(db.prepare("SELECT invoice_id FROM registrations WHERE id=?").get(registration.id).invoice_id, registration.invoice_id);
  } finally {db.close();}
});

test("program staff combines assignments and registrations without duplicate contacts", () => {
  const {db,actor,other,program,person,one}=fixture();
  try {
    const coach=person("Coach");
    const registration=register(db,actor,{person_id:coach.id,program_id:program.id,role:"Coach"});
    assignStaff(db,actor,one.id,{person_id:coach.id,role:"Coach"});
    db.prepare("UPDATE registrations SET team_id=? WHERE id=?").run(one.id,registration.id);
    setPrimaryStaff(db,actor,one.id,{person_id:coach.id});
    let rows=listProgramStaff(db,actor,program.id);
    assert.equal(rows.length,1);
    assert.equal(rows[0].registration_id,registration.id);
    assert.equal(rows[0].is_primary,true);
    assert.equal(rows[0].team_name,one.name);
    assert.throws(()=>listProgramStaff(db,other,program.id),/not found/i);
    register(db,actor,{person_id:person("Player").id,program_id:program.id});
    register(db,actor,{person_id:person("Captain").id,program_id:program.id,role:"Captain"});
    assert.equal(listProgramStaff(db,actor,program.id).length,1);
    db.prepare("DELETE FROM team_staff WHERE team_id=? AND person_id=?").run(one.id,coach.id);
    db.prepare("UPDATE registrations SET status='Pending' WHERE id=?").run(registration.id);
    rows=listProgramStaff(db,actor,program.id);
    assert.equal(rows[0].status,"Pending");
    assert.equal(rows[0].is_primary,false);
    db.prepare("UPDATE people SET data=json_set(data,'$.archived_at','2026-09-08') WHERE id=?").run(coach.id);
    assert.equal(listProgramStaff(db,actor,program.id).length,0);
  } finally {db.close();}
});

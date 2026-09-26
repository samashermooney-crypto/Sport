import { savePerson } from "./directory.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { beginMemberSignup, verifyMemberSignup } from "./member-auth.mjs";
import { saveMemberProfile } from "./member-profile.mjs";
import { saveProgram, createTeam, register, saveEvent } from "./domain.mjs";
import { memberSchedule, scheduleCalendar } from "./member-schedule.mjs";
function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Example Club'),('other','Other Club')",
  ).run();
  const app = makeApp(db),
    actor = { id: "admin", org_id: "org" };
  const signup = {
    email: "guardian@example.com",
    password: "Example password 2026!",
    first_name: "Casey",
    last_name: "Example",
    birthdate: "1988-01-01",
  };
  const account = verifyMemberSignup(
    db,
    "org",
    beginMemberSignup(db, "org", signup).token,
  );
  const stranger = verifyMemberSignup(
    db,
    "org",
    beginMemberSignup(db, "org", { ...signup, email: "stranger@example.com" })
      .token,
  );
  const household = db
    .prepare("SELECT household_id FROM people WHERE id=?")
    .get(account.person_id).household_id;
  const child = saveMemberProfile(db, account, {
    first_name: "Riley",
    last_name: "Example",
    birthdate: "2015-04-10",
    gender: "Unknown",
    household_id: household,
    profile_form_version: 1,
    profile_record_version: 0,
    profile_answers: {},
  });
  const program = saveProgram(db, actor, {
    name: "Private League",
    type: "League",
    sport: "Soccer",
    level: "All",
    season: "Fall",
    gender: "Co-Ed",
    start_date: "2026-10-01",
    public: false,
  });
  const teams = ["Blue", "Gold", "Red"].map((name) =>
    createTeam(db, actor, { name, program_id: program.id }),
  );
  const registration = register(db, actor, {
    program_id: program.id,
    person_id: child.id,
    team_id: teams[0].id,
  });
  let hour = 10;
  const event = (title, extra = {}) => {
    const h = hour++;
    return saveEvent(db, actor, {
      title,
      program_id: program.id,
      type: "Event",
      start_at: `2026-09-07T${h}:00:00Z`,
      end_at: `2026-09-07T${h}:30:00Z`,
      published: true,
      ...extra,
    });
  };
  const wide = event("Everyone orientation", {
    notes: "Internal source notes",
  });
  const own = event("Blue vs Gold", {
    type: "Game",
    home_team_id: teams[0].id,
    away_team_id: teams[1].id,
  });
  const unrelated = event("Gold practice", { home_team_id: teams[1].id });
  const draft = event("Draft", { published: false });
  const canceled = event("Canceled meeting", { state: "Canceled" });
  return {
    db,
    app,
    actor,
    signup,
    account,
    stranger,
    child,
    program,
    teams,
    registration,
    wide,
    own,
    unrelated,
    draft,
    canceled,
  };
}
test("member schedules include published family program/team events and omit unrelated, draft and canceled enrollments", () => {
  const {
    db,
    account,
    stranger,
    child,
    registration,
    wide,
    own,
    unrelated,
    draft,
    canceled,
  } = fixture();
  try {
    const schedule = memberSchedule(db, account);
    assert.deepEqual(
      schedule.events.map((e) => e.id),
      [wide.id, own.id, canceled.id],
    );
    assert.equal(
      JSON.stringify(schedule).includes("Internal source notes"),
      false,
    );
    assert.equal(schedule.events[0].participants[0].id, child.id);
    assert.deepEqual(memberSchedule(db, stranger).events, []);
    assert.deepEqual(memberSchedule(db, account, account.person_id).events, []);
    assert.throws(() => memberSchedule(db, stranger, child.id), /not found/);
    const household = db
      .prepare("SELECT household_id FROM people WHERE id=?")
      .get(child.id).household_id;
    db.prepare("INSERT INTO household_members VALUES(?,?,'Supervisor')").run(
      household,
      stranger.person_id,
    );
    assert.throws(
      () => memberSchedule(db, account, stranger.person_id),
      /not found/,
    );

    db.prepare("UPDATE registrations SET status='Wait List' WHERE id=?").run(
      registration.id,
    );
    assert.deepEqual(memberSchedule(db, account).events, []);
    db.prepare("UPDATE registrations SET status='Pending' WHERE id=?").run(
      registration.id,
    );
    assert.equal(memberSchedule(db, account).events.length, 3);
    db.prepare("UPDATE registrations SET team_id=NULL WHERE id=?").run(
      registration.id,
    );
    assert.deepEqual(
      memberSchedule(db, account).events.map((e) => e.id),
      [wide.id, canceled.id],
    );
  } finally {
    db.close();
  }
});
test("team staff see assigned-team schedules and duplicate family participation does not duplicate events", () => {
  const { db, account, child, teams, program, wide, own } = fixture();
  try {
    db.prepare("INSERT INTO team_staff VALUES(?,?,?,?,?,?)").run(
      id(),
      "org",
      teams[0].id,
      account.person_id,
      "Coach",
      now(),
    );
    const event = memberSchedule(db, account).events.find(
      (e) => e.id === own.id,
    );
    assert.equal(event.participants.length, 2);
    assert.equal(
      memberSchedule(db, account).events.filter((e) => e.id === own.id).length,
      1,
    );
    assert.equal(
      memberSchedule(db, account, account.person_id).events.some(
        (e) => e.id === wide.id,
      ),
      true,
    );
    db.prepare(
      "UPDATE people SET data=json_set(data,'$.archived_at',?) WHERE id=?",
    ).run(now(), child.id);
    assert.equal(
      memberSchedule(db, account).events.find((e) => e.id === own.id)
        .participants.length,
      1,
    );
    db.prepare("UPDATE programs SET status='Unpublished' WHERE id=?").run(
      program.id,
    );
    assert.deepEqual(memberSchedule(db, account).events, []);
  } finally {
    db.close();
  }
});
test("calendar downloads preserve UTC times, cancellation and escaped UTF-8 text without injected properties", () => {
  const { db, account } = fixture();
  try {
    const schedule = memberSchedule(db, account);
    schedule.events[0].title = "🏀".repeat(40) + ";team,one\nBEGIN:VALARM";
    const text = scheduleCalendar(schedule);
    assert.match(text, /BEGIN:VCALENDAR\r\nVERSION:2.0/);
    assert.match(text, /DTSTART:20260907T100000Z/);
    assert.match(text, /STATUS:CANCELLED/);
    assert.equal(text.includes("\r\nBEGIN:VALARM"), false);
    assert.ok(
      text.replace(/\r\n /g, "").includes("\\;team\\,one\\nBEGIN:VALARM"),
    );
    assert.ok(
      text.split("\r\n").every((line) => Buffer.byteLength(line) <= 75),
    );
    assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 3);
  } finally {
    db.close();
  }
});
test("schedule JSON and calendar downloads require an organization-scoped member session", async () => {
  const { db, app, signup, child } = fixture();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/member`;
  try {
    const login = await fetch(root + "/org/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fieldhouse-Request": "1",
        },
        body: JSON.stringify(signup),
      }),
      cookie = login.headers.get("set-cookie").split(";")[0];
    for (const path of ["schedule", "schedule.ics"]) {
      assert.equal((await fetch(root + "/org/" + path)).status, 401);
      assert.equal(
        (await fetch(root + "/other/" + path, { headers: { cookie } })).status,
        401,
      );
      assert.equal(
        (
          await fetch(root + "/org/" + path + "?person_id=unrelated", {
            headers: { cookie },
          })
        ).status,
        404,
      );
      const response = await fetch(
        root + "/org/" + path + "?person_id=" + child.id,
        { headers: { cookie } },
      );
      assert.equal(response.status, 200);
      if (path.endsWith("ics")) {
        assert.match(response.headers.get("content-type"), /text\/calendar/);
        assert.match(response.headers.get("cache-control"), /no-store/);
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("attendance separates family RSVP from admin check-in and rejects stale or unrelated updates", async () => {
  const { activityAttendance, memberRsvp, recordAttendance, attendanceReport } =
    await import("./attendance.mjs");
  const {
    db,
    app,
    actor,
    account,
    stranger,
    child,
    signup,
    wide,
    own,
    unrelated,
    draft,
    canceled,
    registration,
  } = fixture();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(activityAttendance(db, "org", wide.id).rows[0].rsvp, "");
    assert.throws(
      () =>
        memberRsvp(db, stranger, wide.id, child.id, {
          version: 0,
          rsvp: "Yes",
        }),
      /not found/,
    );
    assert.throws(
      () =>
        memberRsvp(db, account, unrelated.id, child.id, {
          version: 0,
          rsvp: "Yes",
        }),
      /not found/,
    );
    assert.throws(
      () =>
        memberRsvp(db, account, draft.id, child.id, {
          version: 0,
          rsvp: "Yes",
        }),
      /not found/,
    );
    assert.throws(
      () =>
        memberRsvp(db, account, canceled.id, child.id, {
          version: 0,
          rsvp: "Yes",
        }),
      /canceled/,
    );
    const yes = memberRsvp(db, account, wide.id, child.id, {
      version: 0,
      rsvp: "Yes",
    });
    assert.equal(yes.rows[0].rsvp, "Yes");
    assert.throws(
      () =>
        recordAttendance(db, actor, wide.id, child.id, {
          version: 0,
          checked_in: true,
        }),
      /changed/,
    );
    const checked = recordAttendance(db, actor, wide.id, child.id, {
      version: 1,
      checked_in: true,
    });
    assert.ok(checked.rows[0].checked_in_at);
    assert.equal(checked.rows[0].rsvp, "Yes");
    const maybe = memberRsvp(db, account, wide.id, child.id, {
      version: 2,
      rsvp: "Maybe",
      checked_in: false,
    });
    assert.equal(maybe.rows[0].checked_in_at, checked.rows[0].checked_in_at);
    const report = attendanceReport(db, "org", {
      from: "2026-09-07",
      to: "2026-09-07",
    });
    assert.equal(report.summary.maybe, 1);
    assert.equal(report.summary.checked_in, 1);
    assert.equal(
      attendanceReport(db, "other", { from: "2026-09-07", to: "2026-09-07" })
        .rows.length,
      0,
    );
    assert.throws(() => activityAttendance(db, "other", wide.id), /not found/);
    const login = await fetch(root + "/api/member/org/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
      },
      body: JSON.stringify(signup),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const get = await fetch(
      root + `/api/member/org/activities/${wide.id}/attendance`,
      { headers: { cookie } },
    );
    assert.equal(get.status, 200);
    assert.equal((await get.json()).rows.length, 1);
    const denied = await fetch(
      root + `/api/activities/${wide.id}/attendance/${child.id}`,
      {
        method: "PUT",
        headers: {
          cookie,
          "Content-Type": "application/json",
          "X-Fieldhouse-Request": "1",
        },
        body: JSON.stringify({ version: 3, checked_in: false }),
      },
    );
    assert.equal(denied.status, 401);
    recordAttendance(db, actor, wide.id, child.id, {
      version: 3,
      checked_in: false,
    });
    assert.equal(
      activityAttendance(db, "org", wide.id).rows[0].checked_in_at,
      null,
    );
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(
      registration.id,
    );
    assert.throws(
      () =>
        memberRsvp(db, account, wide.id, child.id, { version: 4, rsvp: "Yes" }),
      /not found/,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("attendance exports match filtered summaries and use organization-local calendar weeks", async () => {
  const {
    attendanceReport,
    attendanceCsv,
    attendanceDefaults,
    recordAttendance,
  } = await import("./attendance.mjs");
  const { db, actor, child, wide, program } = fixture();
  try {
    db.prepare(
      "UPDATE organizations SET timezone='America/Chicago' WHERE id='org'",
    ).run();
    assert.deepEqual(
      attendanceDefaults(db, "org", new Date("2026-09-07T02:00:00Z")),
      { timezone: "America/Chicago", from: "2026-08-31", to: "2026-09-06" },
    );
    assert.deepEqual(
      attendanceDefaults(db, "org", new Date("2026-09-07T12:00:00Z")),
      { timezone: "America/Chicago", from: "2026-09-07", to: "2026-09-13" },
    );
    recordAttendance(db, actor, wide.id, child.id, {
      version: 0,
      checked_in: true,
    });
    const report = attendanceReport(db, "org", {
      from: "2026-09-07",
      to: "2026-09-07",
      event_type: "Event",
      title: "orientation",
      name: "Riley",
    });
    assert.equal(report.rows.length, 1);
    assert.equal(report.programs[0].id, program.id);
    assert.equal(report.programs[0].checked_in, 1);
    assert.equal(
      report.summary.participants,
      report.programs.reduce((n, p) => n + p.participants, 0),
    );
    assert.match(attendanceCsv(report, "summary"), /"Participants","RSVP Yes"/);
    assert.match(attendanceCsv(report, "programs"), /Private League/);
    assert.match(attendanceCsv(report, "players"), /America\/Chicago/);
    assert.equal(attendanceCsv(report, "checkins").split("\r\n").length, 3);
    const none = attendanceReport(db, "org", {
      from: "2026-09-07",
      to: "2026-09-07",
      event_type: "Game",
      title: "orientation",
    });
    assert.equal(none.rows.length, 0);
    report.rows[0].first_name = '=HYPERLINK("fictional")';
    assert.match(attendanceCsv(report), /"'=HYPERLINK/);
    assert.throws(() => attendanceCsv(report, "unknown"));
  } finally {
    db.close();
  }
});

test("staff check-in permissions are limited to assigned teams and revoked immediately", async () => {
  const { memberRoster, memberCheckin } = await import("./attendance.mjs");
  const { getStaffRoles, saveStaffRoles } = await import("./staff-roles.mjs");
  const { db, actor, account, stranger, child, program, teams, wide, own } =
    fixture();
  try {
    const other = savePerson(db, actor, {
      first_name: "Other",
      last_name: "Player",
      birthdate: "2015-04-10",
    });
    register(db, actor, {
      program_id: program.id,
      person_id: other.id,
      team_id: teams[1].id,
    });
    db.prepare("INSERT INTO team_staff VALUES(?,?,?,?,?,?)").run(
      "coach",
      "org",
      teams[0].id,
      stranger.person_id,
      "Coach",
      new Date().toISOString(),
    );
    assert.equal(memberRoster(db, stranger, own.id).staff_rows.length, 0);
    assert.throws(
      () =>
        memberCheckin(db, account, own.id, child.id, {
          version: 0,
          checked_in: true,
        }),
      /cannot check in/,
    );
    let settings = getStaffRoles(db, "org");
    saveStaffRoles(db, actor, {
      ...settings,
      roles: settings.roles.map((r) => ({
        ...r,
        can_check_in: r.name === "Coach",
      })),
    });
    const roster = memberRoster(db, stranger, own.id);
    assert.deepEqual(
      roster.staff_rows.map((r) => r.person_id),
      [child.id],
    );
    assert.equal(roster.rows.length, 0);
    assert.throws(
      () =>
        memberCheckin(db, stranger, own.id, other.id, {
          version: 0,
          checked_in: true,
        }),
      /cannot check in/,
    );
    assert.ok(
      memberCheckin(db, stranger, own.id, child.id, {
        version: 0,
        checked_in: true,
      }).staff_rows[0].checked_in_at,
    );
    assert.deepEqual(
      memberRoster(db, stranger, wide.id).staff_rows.map((r) => r.person_id),
      [child.id],
    );
    settings = getStaffRoles(db, "org");
    saveStaffRoles(db, actor, {
      ...settings,
      roles: settings.roles.map((r) => ({ ...r, can_check_in: false })),
    });
    assert.equal(memberRoster(db, stranger, own.id).staff_rows.length, 0);
    assert.throws(
      () =>
        memberCheckin(db, stranger, own.id, child.id, {
          version: 1,
          checked_in: false,
        }),
      /cannot check in/,
    );
    register(db, actor, {
      program_id: program.id,
      person_id: stranger.person_id,
      role: "Coach",
    });
    settings = getStaffRoles(db, "org");
    saveStaffRoles(db, actor, {
      ...settings,
      roles: settings.roles.map((r) => ({
        ...r,
        can_check_in: r.name === "Coach",
      })),
    });
    assert.equal(memberRoster(db, stranger, own.id).staff_rows.length, 2);
  } finally {
    db.close();
  }
});

test("recorded attendance survives departure and profile edits without restoring write eligibility", async () => {
  const {
    memberRsvp,
    recordAttendance,
    attendanceReport,
    activityAttendance,
    attendanceCsv,
  } = await import("./attendance.mjs");
  const { db, actor, account, child, wide, registration } = fixture();
  try {
    memberRsvp(db, account, wide.id, child.id, { version: 0, rsvp: "Yes" });
    recordAttendance(db, actor, wide.id, child.id, {
      version: 1,
      checked_in: true,
    });
    db.prepare(
      "UPDATE people SET first_name='Renamed',data=json_set(data,'$.archived_at','2026-09-08') WHERE id=?",
    ).run(child.id);
    db.prepare(
      "UPDATE registrations SET status='Canceled',team_id=NULL WHERE id=?",
    ).run(registration.id);
    assert.equal(activityAttendance(db, "org", wide.id).rows.length, 0);
    assert.throws(
      () =>
        recordAttendance(db, actor, wide.id, child.id, {
          version: 2,
          checked_in: false,
        }),
      /not found/,
    );
    const report = attendanceReport(db, "org", {
      from: "2026-09-07",
      to: "2026-09-07",
      title: "orientation",
    });
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].first_name, "Riley");
    assert.equal(report.rows[0].roster_status, "Former");
    assert.equal(report.summary.checked_in, 1);
    assert.equal(report.summary.yes, 1);
    assert.match(attendanceCsv(report), /"Former"/);
    assert.equal(
      attendanceReport(db, "other", { from: "2026-09-07", to: "2026-09-07" })
        .rows.length,
      0,
    );
    db.prepare("DELETE FROM registration_answers WHERE registration_id=?").run(
      registration.id,
    );
    db.prepare("DELETE FROM registrations WHERE id=?").run(registration.id);
    assert.equal(
      attendanceReport(db, "org", {
        from: "2026-09-07",
        to: "2026-09-07",
        title: "orientation",
      }).rows.length,
      1,
    );
  } finally {
    db.close();
  }
});

test('member calendar preserves an unknown end time and omits DTEND for that activity',()=>{
 const {db,actor,account,program,teams}=fixture();
 try {
  const event=saveEvent(db,actor,{program_id:program.id,type:'Event',title:'End time TBD',home_team_id:teams[0].id,start_at:'2026-09-08T10:00:00Z',end_at:'',published:true});
  const schedule=memberSchedule(db,account);
  assert.equal(schedule.events.find(e=>e.id===event.id).end_at,'');
  const entry=scheduleCalendar(schedule).split('BEGIN:VEVENT').find(text=>text.includes(event.id));
  assert.ok(entry.includes('DTSTART:20260908T100000Z'));
  assert.equal(entry.includes('DTEND:'),false);
 }finally{db.close();}
});

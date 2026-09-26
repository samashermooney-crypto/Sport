import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { getStaffRoles, saveStaffRoles } from "./staff-roles.mjs";
import { savePerson } from "./directory.mjs";
import { saveProgram, createTeam, register, programStats } from "./domain.mjs";
import { assignStaff, teamProfile } from "./teams.mjs";
import { beginMemberSignup, verifyMemberSignup } from "./member-auth.mjs";
import {
  memberEnrollmentContext,
  registerMember,
} from "./member-registration.mjs";
function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
  ).run();
  const app = makeApp(db),
    actor = { id: "admin", org_id: "org" };
  const program = saveProgram(db, actor, {
    name: "League",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "All",
    season: "Fall",
    start_date: "2026-10-01",
    fee_cents: 9500,
    capacity: 1,
  });
  const team = createTeam(db, actor, { name: "Blue", program_id: program.id });
  const people = ["Casey", "Jordan", "Morgan"].map((first_name) =>
    savePerson(db, actor, {
      first_name,
      last_name: "Example",
      birthdate: "1988-01-01",
    }),
  );
  return { db, app, actor, program, team, people };
}
test("staff role settings reject duplicates/stale writes and protect roles referenced by records", () => {
  const { db, actor, program, people } = fixture();
  try {
    const current = getStaffRoles(db, "org");
    assert.throws(
      () =>
        saveStaffRoles(db, actor, {
          ...current,
          roles: [...current.roles, { id: "bad", name: "coach" }],
        }),
      /unique/,
    );
    assert.throws(
      () =>
        saveStaffRoles(db, actor, {
          ...current,
          roles: [{ id: "bad", name: "Free Agent" }],
        }),
      /unique/,
    );
    assert.throws(
      () =>
        saveStaffRoles(db, actor, {
          ...current,
          roles: [{ id: "bad", name: "Assistant", can_join_team: true }],
        }),
      /self-registration/,
    );
    const next = saveStaffRoles(db, actor, {
      ...current,
      roles: [
        ...current.roles,
        {
          id: "assistant",
          name: "Assistant Coach",
          max_program: 2,
          max_team: 1,
        },
      ],
    });
    assert.throws(() => saveStaffRoles(db, actor, current), /changed/);
    register(db, actor, {
      program_id: program.id,
      person_id: people[0].id,
      role: "Assistant Coach",
    });
    assert.throws(
      () =>
        saveStaffRoles(db, actor, {
          ...next,
          roles: next.roles.filter((r) => r.id !== "assistant"),
        }),
      /in use/,
    );
    assert.equal(
      getStaffRoles(db, "other").roles.some((r) => r.id === "assistant"),
      false,
    );
  } finally {
    db.close();
  }
});
test("custom staff roles stay outside player capacity and enforce distinct-person program/team limits atomically", () => {
  const { db, actor, program, team, people } = fixture();
  try {
    const current = getStaffRoles(db, "org");
    saveStaffRoles(db, actor, {
      ...current,
      roles: [
        ...current.roles,
        {
          id: "assistant",
          name: "Assistant Coach",
          max_program: 2,
          max_team: 1,
        },
      ],
    });
    const registration = register(db, actor, {
      program_id: program.id,
      person_id: people[0].id,
      role: "Assistant Coach",
      team_id: team.id,
    });
    assert.equal(registration.invoice_id, null);
    assert.equal(registration.status, "Confirmed");
    assignStaff(db, actor, team.id, {
      person_id: people[0].id,
      role: "Assistant Coach",
    });
    assert.equal(teamProfile(db, actor, team.id).roster.length, 0);
    assert.throws(
      () =>
        assignStaff(db, actor, team.id, {
          person_id: people[1].id,
          role: "Assistant Coach",
        }),
      /team.*reached/,
    );
    register(db, actor, {
      program_id: program.id,
      person_id: people[1].id,
      role: "Assistant Coach",
    });
    assert.throws(
      () =>
        register(db, actor, {
          program_id: program.id,
          person_id: people[2].id,
          role: "Assistant Coach",
        }),
      /program.*reached/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registrations").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices").get().n, 0);
    const stats = programStats(db, "org")[0];
    assert.equal(stats.players, 0);
    assert.equal(stats.staff, 2);
    assert.throws(
      () =>
        assignStaff(db, actor, team.id, {
          person_id: people[2].id,
          role: "Unconfigured",
        }),
      /configured/,
    );
  } finally {
    db.close();
  }
});
test("member staff registration requires enabled self-registration and only applies to the signed-in adult", () => {
  const { db, actor, program, people } = fixture();
  try {
    const signup = {
      email: "staff@example.com",
      password: "Example password 2026!",
      first_name: "Staff",
      last_name: "Example",
      birthdate: "1988-01-01",
    };
    const account = verifyMemberSignup(
      db,
      "org",
      beginMemberSignup(db, "org", signup).token,
    );
    let settings = getStaffRoles(db, "org");
    settings = saveStaffRoles(db, actor, {
      ...settings,
      roles: [
        ...settings.roles,
        {
          id: "assistant",
          name: "Assistant Coach",
          can_register: true,
          max_program: 1,
        },
      ],
    });
    const input = {
      program_id: program.id,
      person_id: account.person_id,
      role: "Assistant Coach",
      expected_fee_cents: 0,
      form_version: 1,
    };
    assert.equal(
      memberEnrollmentContext(db, account, input).program.fee_cents,
      0,
    );
    assert.throws(
      () => registerMember(db, account, { ...input, person_id: people[0].id }),
      /self-registration/,
    );
    assert.throws(
      () => registerMember(db, account, { ...input, role: "Volunteer" }),
      /self-registration/,
    );
    assert.throws(
      () => registerMember(db, account, { ...input, role: "Team Player" }),
      /self-registration/,
    );
    const result = registerMember(db, account, input);
    assert.equal(result.status, "Confirmed");
    assert.equal(result.invoice, null);
    saveStaffRoles(db, actor, {
      ...settings,
      roles: settings.roles.map((r) => ({
        ...r,
        can_register: false,
        can_join_team: false,
        can_create_team: false,
      })),
    });
    assert.throws(
      () => memberEnrollmentContext(db, account, input),
      /self-registration/,
    );
  } finally {
    db.close();
  }
});

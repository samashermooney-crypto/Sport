import test from "node:test";
import assert from "node:assert/strict";
import { openDb, unpack } from "./db.mjs";
import {
  savePerson,
  saveHousehold,
  linkHouseholdMember,
} from "./directory.mjs";
import { saveProgram, register } from "./domain.mjs";
import {
  resolveRecipients,
  saveMessage,
  queueMessage,
  getMessage,
  cleanHtml,
} from "./messaging.mjs";
import { deliverQueued } from "./message-delivery.mjs";
function fixture() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "org",
    "Test Sports",
  );
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "other",
    "Other Sports",
  );
  const actor = { id: "owner", org_id: "org", email: "owner@example.com" },
    other = { id: "other", org_id: "other" };
  const person = (name, email, extra = {}) =>
    savePerson(db, actor, {
      first_name: name,
      last_name: "Example",
      email,
      ...extra,
    });
  const program = saveProgram(db, actor, {
    name: "League",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "All",
    season: "Fall",
    start_date: "2026-10-01",
    fee_cents: 1000,
  });
  return { db, actor, other, person, program };
}
test("recipients expand every family supervisor, deduplicate addresses, enforce filters and org isolation", () => {
  const { db, actor, other, person, program } = fixture();
  try {
    const family = saveHousehold(db, actor, { name: "Family" }),
      a = person("Parent A", "parenta@example.com", { kind: "parent" }),
      b = person("Parent B", "PARENTB@example.com", {
        kind: "parent",
        secondary_email: "parenta@example.com",
      }),
      child = person("Child", "child@example.com", {
        gender: "Female",
        birthdate: "2015-04-01",
      });
    for (const [p, role] of [
      [a, "Supervisor"],
      [b, "Supervisor"],
      [child, "Member"],
    ])
      linkHouseholdMember(db, actor, family.id, { person_id: p.id, role });
    register(db, actor, {
      program_id: program.id,
      person_id: child.id,
      waiver_accepted: true,
    });
    let result = resolveRecipients(db, actor, {
      group: "programs",
      program_ids: [program.id],
      gender: "Female",
      payment: "Owes",
      waiver: "Accepted",
    });
    assert.deepEqual(result.recipients.map((r) => r.address).sort(), [
      "parenta@example.com",
      "parentb@example.com",
    ]);
    assert.equal(result.matched_members, 1);
    assert.equal(
      resolveRecipients(db, actor, { group: "programs", roles: [] }).email,
      0,
    );
    assert.equal(
      resolveRecipients(db, actor, { group: "programs", program_states: [] })
        .email,
      0,
    );
    assert.equal(
      resolveRecipients(db, actor, { group: "programs", payment: "Paid" })
        .email,
      0,
    );
    const foreign = savePerson(db, other, {
      first_name: "Foreign",
      last_name: "Member",
      email: "foreign@example.com",
    });
    assert.throws(
      () => resolveRecipients(db, actor, { person_ids: [foreign.id] }),
      /not found/,
    );
    assert.equal(resolveRecipients(db, other, { group: "site" }).email, 1);
  } finally {
    db.close();
  }
});
test("newsletter opt-outs, bounced addresses and SMS consent affect previews", () => {
  const { db, actor, person } = fixture();
  try {
    person("Opted out", "out@example.com", { marketing_opt_in: false });
    person("Bounced", "bounce@example.com", {
      email_status: "Bounced",
      marketing_opt_in: true,
    });
    person("Consented", "yes@example.com", {
      marketing_opt_in: true,
      sms_opt_in: true,
      phone: "+15551234567",
    });
    person("No text consent", "text@example.com", { phone: "+15551234568" });
    assert.equal(resolveRecipients(db, actor, { newsletter: true }).email, 1);
    assert.equal(resolveRecipients(db, actor, {}, "sms").sms, 1);
    assert.equal(resolveRecipients(db, actor, {}).email, 3);
  } finally {
    db.close();
  }
});
const enabled = {
  MESSAGE_DELIVERY_ENABLED: "true",
  RESEND_API_KEY: "fake",
  MAIL_FROM: "sports@example.com",
};
test("outbox snapshots are idempotent and require manual release after configuration", async () => {
  const { db, actor, other, person } = fixture();
  try {
    person("Member", "one@example.com");
    const message = saveMessage(db, actor, {
      subject: "Practice",
      body: "<p>Monday <strong>6PM</strong></p>",
    });
    assert.equal(
      queueMessage(db, actor, message.id, {}).status,
      "Awaiting configuration",
    );
    queueMessage(db, actor, message.id, {});
    assert.equal(
      db.prepare("SELECT count(*) n FROM message_recipients").get().n,
      1,
    );
    assert.equal(
      (
        await deliverQueued(db, {
          env: enabled,
          send: async () => {
            throw Error("Should not deliver held message");
          },
        })
      ).processed,
      0,
    );
    person("Later member", "later@example.com");
    assert.equal(queueMessage(db, actor, message.id, enabled).status, "Queued");
    assert.equal(
      db.prepare("SELECT count(*) n FROM message_recipients").get().n,
      1,
    );
    assert.throws(
      () => saveMessage(db, actor, { body: "Changed" }, message.id),
      /Only drafts/,
    );
    assert.throws(() => getMessage(db, other, message.id), /not found/);
    let sends = 0;
    await deliverQueued(db, {
      send: async () => {
        sends++;
        return { id: "accepted-1" };
      },
    });
    await deliverQueued(db, {
      send: async () => {
        sends++;
        return { id: "again" };
      },
    });
    assert.equal(sends, 1);
    assert.equal(getMessage(db, actor, message.id).status, "Accepted");
  } finally {
    db.close();
  }
});
test("ambiguous delivery failures are retained for reconciliation without automatic duplicate sends", async () => {
  const { db, actor, person } = fixture();
  try {
    person("Member", "one@example.com");
    const m = saveMessage(db, actor, {
      subject: "Weather",
      body: "<p>Practice update</p>",
    });
    queueMessage(db, actor, m.id, enabled);
    let attempts = 0;
    const send = async () => {
      attempts++;
      throw Error("Connection dropped");
    };
    await deliverQueued(db, { send });
    await deliverQueued(db, { send });
    assert.equal(attempts, 1);
    assert.equal(getMessage(db, actor, m.id).status, "Needs attention");
    assert.equal(
      db.prepare("SELECT status FROM message_recipients").get().status,
      "Unknown",
    );
  } finally {
    db.close();
  }
});
test("HTML sanitization strips scripts, event handlers, unsafe links and remote tracking images", () => {
  const sanitized = cleanHtml(
    '<p onclick="evil()">Hi<script>evil()</script><img src="https://tracker.test/pixel"><a href="javascript:evil()">click</a><strong>Safe</strong></p>',
  );
  assert.equal(sanitized, "<p>Hi<a>click</a><strong>Safe</strong></p>");
});

test("delivery rechecks consent changes after the recipient snapshot", async () => {
  const { db, actor, person } = fixture();
  try {
    const p = person("Consenting", "consent@example.com", {
      marketing_opt_in: true,
    });
    const m = saveMessage(db, actor, {
      subject: "Newsletter",
      body: "<p>New season</p>",
      targets: { newsletter: true },
    });
    queueMessage(db, actor, m.id, enabled);
    savePerson(db, actor, { ...p, marketing_opt_in: false }, p.id);
    let sent = 0;
    await deliverQueued(db, {
      send: async () => {
        sent++;
        return { id: "unexpected" };
      },
    });
    assert.equal(sent, 0);
    assert.equal(
      db.prepare("SELECT status FROM message_recipients").get().status,
      "Suppressed",
    );
  } finally {
    db.close();
  }
});

test("team audiences include only selected rosters and staff, expand parents, and reject foreign teams", async () => {
  const { createTeam } = await import("./domain.mjs");
  const { assignStaff } = await import("./teams.mjs");
  const { db, actor, other, person, program } = fixture();
  try {
    const team = createTeam(db, actor, {
        program_id: program.id,
        name: "Selected",
      }),
      excluded = createTeam(db, actor, {
        program_id: program.id,
        name: "Other",
      });
    const parent = person("Parent", "parent@example.com"),
      child = person("Child", "child@example.com"),
      outsider = person("Outsider", "outside@example.com"),
      coach = person("Coach", "coach@example.com");
    const family = saveHousehold(db, actor, { name: "Family" });
    linkHouseholdMember(db, actor, family.id, {
      person_id: parent.id,
      role: "Supervisor",
    });
    linkHouseholdMember(db, actor, family.id, {
      person_id: child.id,
      role: "Member",
    });
    const registration = register(db, actor, {
      program_id: program.id,
      person_id: child.id,
      team_id: team.id,
    });
    register(db, actor, {
      program_id: program.id,
      person_id: outsider.id,
      team_id: excluded.id,
    });
    assignStaff(db, actor, team.id, { person_id: coach.id, role: "Coach" });
    assignStaff(db, actor, team.id, {
      person_id: parent.id,
      role: "Volunteer",
    });
    const input = {
      group: "teams",
      team_ids: [team.id],
      roles: [],
      statuses: ["Confirmed", "Pending"],
    };
    assert.deepEqual(
      resolveRecipients(db, actor, input)
        .recipients.map((r) => r.address)
        .sort(),
      ["coach@example.com", "parent@example.com"],
    );
    assert.deepEqual(
      resolveRecipients(db, actor, {
        ...input,
        roles: ["Team Player"],
      }).recipients.map((r) => r.address),
      ["parent@example.com"],
    );
    assert.throws(() =>
      resolveRecipients(db, actor, { group: "teams", team_ids: [] }),
    );
    assert.throws(() => resolveRecipients(db, other, input));
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(
      registration.id,
    );
    assert.equal(
      resolveRecipients(db, actor, { ...input, roles: ["Team Player"] })
        .recipients.length,
      0,
    );
    db.prepare(
      "UPDATE teams SET data=json_set(data,'$.archived_at','2026-09-07') WHERE id=?",
    ).run(team.id);
    assert.throws(() => resolveRecipients(db, actor, input), /active/);
  } finally {
    db.close();
  }
});

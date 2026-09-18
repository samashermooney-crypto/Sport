import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { initializeMemberAuth, memberFamily } from "./member-auth.mjs";
import {
  memberAccountAccess,
  inviteMemberAccount,
  resendMemberInvitation,
  revokeMemberInvitation,
  acceptMemberInvitation,
} from "./member-invitations.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
  ).run();
  initializeMemberAuth(db);
  return db;
}
const owner = { id: "owner", org_id: "org", role: "owner" };
const admin = { id: "admin", org_id: "org", role: "admin" };
function person(
  db,
  { email = "adult@example.com", birthdate = "1988-05-12", kind = "parent", household = null, org = "org", data = "{}" } = {},
) {
  const personId = id();
  db.prepare("INSERT INTO people VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    personId,
    org,
    household,
    "Sample",
    "Member",
    email,
    birthdate,
    "Unknown",
    kind,
    data,
    now(),
  );
  return personId;
}

test("member account invitations bind the exact person and record email", () => {
  const db = fixture();
  try {
    const adult = person(db);
    const access = memberAccountAccess(db, "org", adult);
    assert.equal(access.state, "none");
    assert.equal(access.eligible, true);
    assert.equal(access.account, null);

    const { invitation, token } = inviteMemberAccount(db, owner, adult, {});
    assert.equal(invitation.email, "adult@example.com");
    assert.equal("token_hash" in invitation, false);
    assert.equal(
      memberAccountAccess(db, "org", adult).state,
      "pending",
    );
    assert.equal(
      db
        .prepare("SELECT person_email FROM member_account_invitations")
        .get().person_email,
      "adult@example.com",
    );
    assert.throws(
      () => inviteMemberAccount(db, owner, adult, {}),
      (error) => error.status === 409 && /already pending/.test(error.message) && error.invitation_id === invitation.id,
    );
    // The invitation email must match the member record email.
    assert.throws(
      () =>
        inviteMemberAccount(db, owner, person(db, { email: "different@example.com" }), {
          email: "other@example.com",
        }),
      /must match the member record/,
    );

    const account = acceptMemberInvitation(db, "org", {
      token,
      password: "member password 2026",
    });
    assert.equal(account.person_id, adult);
    assert.equal(
      db
        .prepare("SELECT email,person_id FROM member_accounts WHERE id=?")
        .get(account.id).person_id,
      adult,
    );
    assert.equal(memberAccountAccess(db, "org", adult).state, "active");
    // One-time use; a second attempt cannot create a duplicate account.
    assert.throws(
      () =>
        acceptMemberInvitation(db, "org", {
          token,
          password: "member password 2026",
        }),
      /invalid or expired/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM member_accounts").get().n,
      1,
    );
  } finally {
    db.close();
  }
});

test("children, archived and conflicting members cannot be invited or activated", () => {
  const db = fixture();
  try {
    const child = person(db, { birthdate: "2015-01-01", kind: "player" });
    assert.equal(memberAccountAccess(db, "org", child).eligible, false);
    assert.match(memberAccountAccess(db, "org", child).reason, /adult/);
    assert.throws(
      () => inviteMemberAccount(db, owner, child, {}),
      /adult/,
    );
    const archived = person(db, { data: '{"archived_at":"2026-01-01"}' });
    assert.throws(
      () => inviteMemberAccount(db, owner, archived, {}),
      /archived/,
    );
    // An adult player participant is still invitable.
    const adultPlayer = person(db, { kind: "player", email: "p@example.com" });
    assert.equal(memberAccountAccess(db, "org", adultPlayer).eligible, true);

    // A member record without an email needs one supplied by the administrator.
    const noEmail = person(db, { email: "" });
    assert.throws(
      () => inviteMemberAccount(db, owner, noEmail, {}),
      /no email/,
    );
    const supplied = inviteMemberAccount(db, owner, noEmail, {
      email: "supplied@example.com",
    });
    acceptMemberInvitation(db, "org", {
      token: supplied.token,
      password: "member password 2026",
    });
    // The supplied email becomes the record's contact email at activation.
    assert.equal(
      db.prepare("SELECT email FROM people WHERE id=?").get(noEmail).email,
      "supplied@example.com",
    );

    // An email already on a member account or console user conflicts.
    const claimed = person(db, { email: "claimed@example.com" });
    db.prepare(
      "INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES('holder','org','H','H','2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO member_accounts VALUES('acct','org','holder','claimed@example.com',?,'2026-01-01','2026-01-01')",
    ).run(passwordHash("x"));
    assert.throws(
      () => inviteMemberAccount(db, owner, claimed, {}),
      /member account/,
    );
    db.prepare(
      "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES('u','org','U','console@example.com',?,'admin')",
    ).run(passwordHash("x"));
    assert.throws(
      () =>
        inviteMemberAccount(
          db,
          owner,
          person(db, { email: "console@example.com" }),
          {},
        ),
      /console account/,
    );
  } finally {
    db.close();
  }
});

test("resend rotates, revoke blocks, and record drift invalidates activation", () => {
  const db = fixture();
  try {
    const adult = person(db);
    const first = inviteMemberAccount(db, owner, adult, {});
    const rotated = resendMemberInvitation(db, owner, adult, first.invitation.id);
    assert.notEqual(rotated.token, first.token);
    assert.throws(
      () =>
        acceptMemberInvitation(db, "org", {
          token: first.token,
          password: "member password 2026",
        }),
      /invalid or expired/,
    );
    // The record email changing after issue blocks redemption.
    db.prepare("UPDATE people SET email='changed@example.com' WHERE id=?").run(
      adult,
    );
    assert.throws(
      () =>
        acceptMemberInvitation(db, "org", {
          token: rotated.token,
          password: "member password 2026",
        }),
      /record email changed/,
    );
    assert.throws(
      () => resendMemberInvitation(db, owner, adult, first.invitation.id),
      /record email changed/,
    );
    db.prepare("UPDATE people SET email='adult@example.com' WHERE id=?").run(
      adult,
    );
    // Archiving after issue blocks redemption too.
    db.prepare("UPDATE people SET data='{\"archived_at\":\"2026-01-01\"}' WHERE id=?").run(adult);
    assert.throws(
      () =>
        acceptMemberInvitation(db, "org", {
          token: rotated.token,
          password: "member password 2026",
        }),
      /archived/,
    );
    db.prepare("UPDATE people SET data='{}' WHERE id=?").run(adult);
    // Editing the birthdate to a child after issue also blocks.
    db.prepare("UPDATE people SET birthdate='2015-01-01' WHERE id=?").run(adult);
    assert.throws(
      () =>
        acceptMemberInvitation(db, "org", {
          token: rotated.token,
          password: "member password 2026",
        }),
      /adult/,
    );
    db.prepare("UPDATE people SET birthdate='1988-05-12' WHERE id=?").run(adult);
    revokeMemberInvitation(db, owner, adult, first.invitation.id);
    assert.throws(
      () =>
        acceptMemberInvitation(db, "org", {
          token: rotated.token,
          password: "member password 2026",
        }),
      /invalid or expired/,
    );
    // Expiry is enforced.
    const second = inviteMemberAccount(db, owner, adult, {});
    db.prepare(
      "UPDATE member_account_invitations SET expires_at='2000-01-01'",
    ).run();
    assert.throws(
      () =>
        acceptMemberInvitation(db, "org", {
          token: second.token,
          password: "member password 2026",
        }),
      /invalid or expired/,
    );
  } finally {
    db.close();
  }
});

test("activation preserves household membership without inventing supervision", () => {
  const db = fixture();
  try {
    const house = id();
    db.prepare("INSERT INTO households VALUES(?,?,'Family')").run(house, "org");
    const guardian = person(db, { household: house, email: "g@example.com" });
    const adultMember = person(db, {
      household: house,
      email: "m@example.com",
      birthdate: "1990-01-01",
      kind: "player",
    });
    db.prepare("INSERT INTO household_members VALUES(?,?,'Supervisor')").run(
      house,
      guardian,
    );
    db.prepare("INSERT INTO household_members VALUES(?,?,'Member')").run(
      house,
      adultMember,
    );
    const invite = inviteMemberAccount(db, admin, adultMember, {});
    const account = acceptMemberInvitation(db, "org", {
      token: invite.token,
      password: "member password 2026",
    });
    // No supervisor relationship is invented: the new account sees no family.
    assert.deepEqual(memberFamily(db, account), []);
    assert.equal(
      db
        .prepare(
          "SELECT role FROM household_members WHERE household_id=? AND person_id=?",
        )
        .get(house, adultMember).role,
      "Member",
    );
  } finally {
    db.close();
  }
});

test("member account-access HTTP routes require owner/admin and activate a working member session", async () => {
  const db = fixture();
  const adult = person(db);
  db.prepare(
    "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)",
  ).run("owner", "org", "Owner", "owner@example.com", passwordHash("owner-pass-123"), "owner");
  for (const role of ["admin", "manager", "reporter"])
    db.prepare(
      "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)",
    ).run(role, "org", role, `${role}@example.com`, passwordHash("test-password-123"), role);
  db.prepare(
    "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES('fo','other','Other','fo@example.com',?,'owner')",
  ).run(passwordHash("test-password-123"));
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (method, path, body, cookie = "") =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (email, password = "test-password-123") =>
    (
      await request("POST", "/api/auth/login", { email, password })
    ).headers
      .get("set-cookie")
      .split(";")[0];
  try {
    const ownerCookie = await login("owner@example.com", "owner-pass-123");
    const adminCookie = await login("admin@example.com");
    const managerCookie = await login("manager@example.com");
    const reporterCookie = await login("reporter@example.com");
    const foreignCookie = await login("fo@example.com");

    const view = await request(
      "GET",
      `/api/people/${adult}/account-access`,
      undefined,
      ownerCookie,
    );
    assert.equal(view.status, 200);
    assert.equal((await view.json()).eligible, true);
    assert.equal(
      (await request("GET", `/api/people/${adult}/account-access`, undefined, managerCookie)).status,
      403,
    );
    assert.equal(
      (await request("GET", `/api/people/${adult}/account-access`, undefined, reporterCookie)).status,
      403,
    );
    assert.equal(
      (await request("GET", `/api/people/${adult}/account-access`, undefined, foreignCookie)).status,
      404,
    );
    assert.equal(
      (await request("GET", `/api/people/${adult}/account-access`)).status,
      401,
    );

    const invite = await request(
      "POST",
      `/api/people/${adult}/account-invitations`,
      {},
      adminCookie,
    );
    assert.equal(invite.status, 201);
    const invitation = await invite.json();
    assert.equal(invitation.delivery, "preview");
    const landing = new URL(invitation.development_link, base);
    assert.equal(landing.pathname, "/site/org/account/accept-invitation");
    const token = landing.searchParams.get("token");

    // A member credential cannot be claimed by guessing the endpoint.
    assert.equal(
      (
        await request("POST", "/api/member/org/accept-invitation", {
          token: "0".repeat(64),
          password: "member password 2026",
        })
      ).status,
      400,
    );
    // Wrong organization cannot redeem the challenge.
    assert.equal(
      (
        await request("POST", "/api/member/other/accept-invitation", {
          token,
          password: "member password 2026",
        })
      ).status,
      400,
    );

    const accepted = await request("POST", "/api/member/org/accept-invitation", {
      token,
      password: "member password 2026",
    });
    assert.equal(accepted.status, 200);
    const memberCookie = accepted.headers.get("set-cookie").split(";")[0];
    const session = await (
      await request("GET", "/api/member/org/session", undefined, memberCookie)
    ).json();
    assert.equal(session.person_id, adult);
    assert.equal(session.email, "adult@example.com");
    // The member session is not a console session.
    assert.equal(
      (await request("GET", "/api/session", undefined, memberCookie)).status,
      401,
    );
    const after = await (
      await request(
        "GET",
        `/api/people/${adult}/account-access`,
        undefined,
        ownerCookie,
      )
    ).json();
    assert.equal(after.state, "active");
    assert.equal(after.account.email, "adult@example.com");
    assert.equal(
      after.invitations.find((i) => i.id === invitation.id).status,
      "Accepted",
    );
    // The member can now sign in normally.
    const memberLogin = await request("POST", "/api/member/org/login", {
      email: "adult@example.com",
      password: "member password 2026",
    });
    assert.equal(memberLogin.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("member invitation delivery failure persists honestly and resend recovers", async () => {
  const db = fixture();
  const adult = person(db);
  db.prepare(
    "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES('owner','org','O','o@e.com',?,'owner')",
  ).run(passwordHash("owner-pass-123"));
  const env = { NODE_ENV: "production", PUBLIC_URL: "https://club.example" };
  let calls = 0;
  const server = makeApp(db, {
    auth: {
      env,
      sendMemberInvitation: async () => {
        calls++;
        if (calls === 1) throw new Error("provider down");
      },
    },
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (cookie) => ({
    "Content-Type": "application/json",
    "X-Fieldhouse-Request": "1",
    Cookie: cookie,
  });
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: headers(""),
      body: JSON.stringify({ email: "o@e.com", password: "owner-pass-123" }),
    });
    const owner = login.headers.get("set-cookie").split(";")[0];
    const created = await fetch(
      `${base}/api/people/${adult}/account-invitations`,
      { method: "POST", headers: headers(owner), body: "{}" },
    );
    assert.equal(created.status, 503);
    const row = db
      .prepare("SELECT status,sent_at,delivery_error FROM member_account_invitations")
      .get();
    assert.equal(row.status, "Pending");
    assert.equal(row.sent_at, null);
    assert.match(row.delivery_error, /could not be sent|Delivery failed/i);
    // Resend rotates the token and records the successful delivery.
    const resent = await fetch(
      `${base}/api/people/${adult}/account-invitations/${db.prepare("SELECT id FROM member_account_invitations").get().id}/resend`,
      { method: "POST", headers: headers(owner), body: "{}" },
    );
    assert.equal(resent.status, 200);
    const invitation = await resent.json();
    assert.equal(invitation.delivery, "sent");
    assert.ok(invitation.sent_at);
    assert.equal(invitation.delivery_error, "");
    assert.equal(calls, 2);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("shared record emails are rejected at issue, resend and activation without changing family access", () => {
  const db = fixture();
  try {
    const adult = person(db);
    const duplicate = person(db, { email: " ADULT@example.com " });
    assert.throws(() => inviteMemberAccount(db, owner, adult, {}), /shared by another member/);
    db.prepare("UPDATE people SET email='separate@example.com' WHERE id=?").run(duplicate);
    const pending = inviteMemberAccount(db, owner, adult, {});
    db.prepare("UPDATE people SET email='ADULT@example.com' WHERE id=?").run(duplicate);
    assert.throws(() => resendMemberInvitation(db, owner, adult, pending.invitation.id), /shared by another member/);
    assert.throws(() => acceptMemberInvitation(db, "org", { token: pending.token, password: "member password 2026" }), /shared by another member/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM member_accounts").get().n, 0);
    assert.equal(db.prepare("SELECT status FROM member_account_invitations WHERE id=?").get(pending.invitation.id).status, "Pending");
    const blank = person(db, { email: "" });
    assert.throws(() => inviteMemberAccount(db, owner, blank, { email: "adult@example.com" }), /shared by another member/);
    db.prepare("UPDATE people SET email='separate@example.com' WHERE id=?").run(duplicate);
    person(db, { email: "adult@example.com", org: "other" });
    assert.equal(acceptMemberInvitation(db, "org", { token: pending.token, password: "member password 2026" }).person_id, adult);
  } finally { db.close(); }
});

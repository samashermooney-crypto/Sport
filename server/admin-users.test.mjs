import test from "node:test";
import assert from "node:assert/strict";
import {
  openDb,
  id,
  now,
  passwordHash,
  passwordMatches,
} from "./db.mjs";
import { makeApp } from "./app.mjs";
import {
  listConsoleAccess,
  inviteConsoleUser,
  resendConsoleInvitation,
  revokeConsoleInvitation,
  updateConsoleUser,
  acceptConsoleInvitation,
  beginConsoleRecovery,
  finishConsoleRecovery,
  changeConsolePassword,
} from "./admin-users.mjs";
import { initializeMemberAuth } from "./member-auth.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
  ).run();
  initializeMemberAuth(db);
  const owner = { id: "owner", org_id: "org", role: "owner" };
  db.prepare(
    "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)",
  ).run("owner", "org", "Owner One", "owner@example.com", passwordHash("owner-pass-123"), "owner");
  return { db, owner };
}
const addUser = (db, role, email = `${role}@example.com`, org = "org") => {
  db.prepare(
    "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)",
  ).run(id(), org, role + " user", email, passwordHash("test-password-123"), role);
  return db.prepare("SELECT * FROM users WHERE email=?").get(email);
};

test("invitation lifecycle binds organization, email and role server-side", () => {
  const { db, owner } = fixture();
  try {
    const { invitation, token } = inviteConsoleUser(db, owner, {
      email: "Manager@Example.com",
      name: "Manager One",
      role: "manager",
    });
    assert.equal(invitation.email, "manager@example.com");
    assert.equal(invitation.status, "Pending");
    assert.equal("token_hash" in invitation, false);
    const stored = db
      .prepare("SELECT * FROM admin_invitations WHERE id=?")
      .get(invitation.id);
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.invited_by, "owner");

    // Duplicate pending invitations for the same organization/email conflict.
    assert.throws(
      () =>
        inviteConsoleUser(db, owner, {
          email: "manager@example.com",
          name: "Again",
          role: "admin",
        }),
      /already pending/,
    );
    // An existing console email cannot be re-invited.
    assert.throws(
      () =>
        inviteConsoleUser(db, owner, {
          email: "owner@example.com",
          name: "Again",
          role: "admin",
        }),
      /already has console access/,
    );

    // Acceptance cannot choose a different role or organization.
    const user = acceptConsoleInvitation(db, {
      token,
      password: "new manager pass 2026",
      name: "Manager Corrected",
    });
    assert.equal(user.role, "manager");
    assert.equal(user.org_id, "org");
    assert.equal(user.email, "manager@example.com");
    assert.equal(user.name, "Manager Corrected");
    assert.equal(user.active, 1);
    assert.throws(
      () =>
        acceptConsoleInvitation(db, {
          token,
          password: "another password 123",
        }),
      /invalid or expired/,
    );
    assert.equal(
      db.prepare("SELECT status FROM admin_invitations WHERE id=?").get(
        invitation.id,
      ).status,
      "Accepted",
    );
  } finally {
    db.close();
  }
});

test("resend rotates the token and revoke blocks redemption", () => {
  const { db, owner } = fixture();
  try {
    const first = inviteConsoleUser(db, owner, {
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
    });
    const resent = resendConsoleInvitation(db, owner, first.invitation.id);
    assert.notEqual(resent.token, first.token);
    assert.throws(
      () =>
        acceptConsoleInvitation(db, {
          token: first.token,
          password: "password twelve plus",
        }),
      /invalid or expired/,
    );
    // Foreign organizations cannot touch the invitation.
    assert.throws(
      () =>
        resendConsoleInvitation(
          db,
          { id: "x", org_id: "other", role: "owner" },
          first.invitation.id,
        ),
      /not found/,
    );
    revokeConsoleInvitation(db, owner, first.invitation.id);
    assert.throws(
      () =>
        acceptConsoleInvitation(db, {
          token: resent.token,
          password: "password twelve plus",
        }),
      /invalid or expired/,
    );
    assert.throws(
      () => revokeConsoleInvitation(db, owner, first.invitation.id),
      /already revoked/,
    );
    // After revocation a fresh invitation may be issued.
    const again = inviteConsoleUser(db, owner, {
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
    });
    assert.equal(again.invitation.status, "Pending");
    // Expired invitations cannot be redeemed.
    db.prepare("UPDATE admin_invitations SET expires_at='2000-01-01'").run();
    assert.throws(
      () =>
        acceptConsoleInvitation(db, {
          token: again.token,
          password: "password twelve plus",
        }),
      /invalid or expired/,
    );
  } finally {
    db.close();
  }
});

test("acceptance cannot take over an existing or member identity", () => {
  const { db, owner } = fixture();
  try {
    const invite = inviteConsoleUser(db, owner, {
      email: "taken@example.com",
      name: "Taken",
      role: "reporter",
    });
    addUser(db, "manager", "taken@example.com");
    assert.throws(
      () =>
        acceptConsoleInvitation(db, {
          token: invite.token,
          password: "password twelve plus",
        }),
      /already exists/,
    );
    const memberInvite = inviteConsoleUser(db, owner, {
      email: "membercase@example.com",
      name: "Member Case",
      role: "reporter",
    });
    db.prepare(
      "INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES('mp','org','M','P','2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO member_accounts VALUES('ma','org','mp','membercase@example.com',?,'2026-01-01','2026-01-01')",
    ).run(passwordHash("x"));
    assert.throws(
      () =>
        acceptConsoleInvitation(db, {
          token: memberInvite.token,
          password: "password twelve plus",
        }),
      /member account/,
    );
    // Issuing to a member-account email conflicts up front too.
    assert.throws(
      () =>
        inviteConsoleUser(db, owner, {
          email: "membercase@example.com",
          name: "Again",
          role: "admin",
        }),
      /member account/,
    );
  } finally {
    db.close();
  }
});

test("role changes and deactivation enforce the last active owner transactionally", () => {
  const { db, owner } = fixture();
  try {
    // The only active owner cannot be demoted or deactivated.
    assert.throws(
      () =>
        updateConsoleUser(db, owner, "owner", {
          role: "admin",
          expected_revision: 1,
        }),
      /at least one active owner/,
    );
    assert.throws(
      () =>
        updateConsoleUser(db, owner, "owner", {
          active: false,
          expected_revision: 1,
        }),
      /at least one active owner/,
    );
    const second = addUser(db, "owner", "second@example.com");
    assert.equal(
      updateConsoleUser(db, owner, second.id, {
        active: false,
        expected_revision: 1,
      }).active,
      false,
    );
    // The deactivated owner no longer counts, so the remaining owner is protected again.
    assert.throws(
      () =>
        updateConsoleUser(db, { id: "x", org_id: "org", role: "owner" }, "owner", {
          role: "manager",
          expected_revision: 1,
        }),
      /at least one active owner/,
    );
    // Stale revisions are rejected.
    assert.throws(
      () =>
        updateConsoleUser(db, owner, second.id, {
          active: true,
          expected_revision: 1,
        }),
      /changed. Reload/,
    );
    const reactivated = updateConsoleUser(db, owner, second.id, {
      active: true,
      expected_revision: 2,
    });
    assert.equal(reactivated.active, true);
    assert.equal(reactivated.revision, 3);
    assert.equal(reactivated.deactivated_at, null);
    // Users in another organization are invisible.
    assert.throws(
      () =>
        updateConsoleUser(db, owner, "ghost", {
          role: "admin",
          expected_revision: 1,
        }),
      /not found/,
    );
  } finally {
    db.close();
  }
});

test("password recovery is one-use, expires, and rejects deactivated accounts", () => {
  const { db } = fixture();
  try {
    assert.equal(
      beginConsoleRecovery(db, { email: "missing@example.com" }),
      null,
    );
    const first = beginConsoleRecovery(db, { email: "OWNER@example.com" });
    const second = beginConsoleRecovery(db, { email: "owner@example.com" });
    assert.throws(
      () =>
        finishConsoleRecovery(db, {
          token: first.token,
          password: "new password 123",
        }),
      /invalid or expired/,
    );
    finishConsoleRecovery(db, {
      token: second.token,
      password: "new password 123",
    });
    assert.equal(
      passwordMatches(
        "new password 123",
        db.prepare("SELECT password_hash FROM users WHERE id='owner'").get()
          .password_hash,
      ),
      true,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM admin_reset_tokens").get().n,
      0,
    );
    // Deactivated accounts get no challenge and cannot redeem an old one.
    const dormant = addUser(db, "admin", "dormant@example.com");
    const challenge = beginConsoleRecovery(db, {
      email: "dormant@example.com",
    });
    db.prepare("UPDATE users SET active=0,deactivated_at=? WHERE id=?").run(
      now(),
      dormant.id,
    );
    assert.equal(
      beginConsoleRecovery(db, { email: "dormant@example.com" }),
      null,
    );
    assert.throws(
      () =>
        finishConsoleRecovery(db, {
          token: challenge.token,
          password: "new password 456",
        }),
      /invalid or expired/,
    );
    // Expired challenges are rejected.
    const expired = beginConsoleRecovery(db, { email: "owner@example.com" });
    db.prepare("UPDATE admin_reset_tokens SET expires_at='2000-01-01'").run();
    assert.throws(
      () =>
        finishConsoleRecovery(db, {
          token: expired.token,
          password: "new password 789",
        }),
      /invalid or expired/,
    );
  } finally {
    db.close();
  }
});

test("password change requires the current password and revokes sessions", () => {
  const { db, owner } = fixture();
  try {
    assert.throws(
      () =>
        changeConsolePassword(db, owner, {
          current_password: "wrong",
          new_password: "new password 123",
        }),
      /Current password is incorrect/,
    );
    db.prepare("INSERT INTO sessions VALUES('known','owner','2099-01-01')").run();
    changeConsolePassword(db, owner, {
      current_password: "owner-pass-123",
      new_password: "new password 123",
    });
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id='owner'").get()
        .n,
      0,
    );
    assert.equal(
      passwordMatches(
        "new password 123",
        db.prepare("SELECT password_hash FROM users WHERE id='owner'").get()
          .password_hash,
      ),
      true,
    );
  } finally {
    db.close();
  }
});

async function httpFixture(options = {}) {
  const { db } = fixture();
  const second = addUser(db, "admin", "admin@example.com");
  const reporter = addUser(db, "reporter", "reporter@example.com");
  const coach = addUser(db, "coach", "coach@example.com");
  const server = makeApp(db, options).listen(0, "127.0.0.1");
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
  const login = async (email, password = "test-password-123") => {
    const r = await request("POST", "/api/auth/login", { email, password });
    return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  return { db, server, base, request, login, second, reporter, coach };
}

test("console access HTTP lifecycle enforces owner-only management and session revocation", async () => {
  const { db, server, base, request, login } = await httpFixture();
  try {
    const ownerLogin = await login("owner@example.com", "owner-pass-123");
    assert.equal(ownerLogin.status, 200);
    const owner = ownerLogin.cookie;
    const admin = (await login("admin@example.com")).cookie;
    const reporter = (await login("reporter@example.com")).cookie;
    const coach = (await login("coach@example.com")).cookie;

    // Listing is owner-only and exposes no secrets.
    assert.equal((await request("GET", "/api/admin-users", undefined, "")).status, 401);
    assert.equal((await request("GET", "/api/admin-users", undefined, admin)).status, 403);
    assert.equal((await request("GET", "/api/admin-users", undefined, reporter)).status, 403);
    assert.equal((await request("GET", "/api/admin-users", undefined, coach)).status, 403);
    const list = await (
      await request("GET", "/api/admin-users", undefined, owner)
    ).json();
    assert.ok(list.users.length >= 4);
    assert.equal(JSON.stringify(list).includes("password_hash"), false);
    assert.equal(JSON.stringify(list).includes("token_hash"), false);

    // Non-owners cannot invite.
    assert.equal(
      (
        await request(
          "POST",
          "/api/admin-users/invitations",
          { email: "x@example.com", name: "X", role: "admin" },
          admin,
        )
      ).status,
      403,
    );
    const invite = await request(
      "POST",
      "/api/admin-users/invitations",
      { email: "staff@example.com", name: "Staff", role: "manager" },
      owner,
    );
    assert.equal(invite.status, 201);
    const invitation = await invite.json();
    assert.equal(invitation.delivery, "preview");
    const token = new URL(
      invitation.development_link,
      base,
    ).searchParams.get("token");
    assert.equal(
      new URL(invitation.development_link, base).pathname,
      "/accept-invitation",
    );

    // Acceptance establishes a console session.
    const accepted = await request("POST", "/api/auth/accept-invitation", {
      token,
      password: "Staff password 2026!",
    });
    assert.equal(accepted.status, 200);
    const staffCookie = accepted.headers.get("set-cookie").split(";")[0];
    const staff = await accepted.json();
    assert.equal(staff.role, "manager");
    assert.equal(
      (await request("GET", "/api/session", undefined, staffCookie)).status,
      200,
    );

    // Demotion revokes the target's sessions immediately.
    const row = (
      await (
        await request("GET", "/api/admin-users", undefined, owner)
      ).json()
    ).users.find((u) => u.email === "staff@example.com");
    const stale = await request("PATCH", `/api/admin-users/${row.id}`, {
      role: "reporter",
      expected_revision: row.revision + 5,
    }, owner);
    assert.equal(stale.status, 409);
    const demoted = await request("PATCH", `/api/admin-users/${row.id}`, {
      role: "reporter",
      expected_revision: row.revision,
    }, owner);
    assert.equal(demoted.status, 200);
    assert.equal(
      (await request("GET", "/api/session", undefined, staffCookie)).status,
      401,
    );

    // Deactivation blocks login and reset redemption; reactivation restores it.
    const deactivated = await request(
      "PATCH",
      `/api/admin-users/${row.id}`,
      { active: false, expected_revision: row.revision + 1 },
      owner,
    );
    assert.equal(deactivated.status, 200);
    assert.equal(
      (
        await request("POST", "/api/auth/login", {
          email: "staff@example.com",
          password: "Staff password 2026!",
        })
      ).status,
      403,
    );
    const forgot = await request("POST", "/api/auth/forgot-password", {
      email: "staff@example.com",
    });
    assert.equal(forgot.status, 202);
    assert.equal("development_link" in (await forgot.json()), false);
    const revived = await request(
      "PATCH",
      `/api/admin-users/${row.id}`,
      { active: true, expected_revision: row.revision + 2 },
      owner,
    );
    assert.equal(revived.status, 200);
    assert.equal(
      (
        await request("POST", "/api/auth/login", {
          email: "staff@example.com",
          password: "Staff password 2026!",
        })
      ).status,
      200,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("console recovery and password change over HTTP revoke prior sessions", async () => {
  const { db, server, base, request, login } = await httpFixture();
  try {
    const owner = (await login("owner@example.com", "owner-pass-123")).cookie;
    // Unknown and known emails return an indistinguishable response.
    const unknown = await (
      await request("POST", "/api/auth/forgot-password", {
        email: "nobody@example.com",
      })
    ).json();
    const known = await request("POST", "/api/auth/forgot-password", {
      email: "admin@example.com",
    });
    const knownBody = await known.json();
    assert.equal(known.status, 202);
    assert.equal(knownBody.message, unknown.message);
    const token = new URL(
      knownBody.development_link,
      base,
    ).searchParams.get("token");
    assert.equal(
      new URL(knownBody.development_link, base).pathname,
      "/reset-password",
    );
    assert.equal(
      (
        await request("POST", "/api/auth/reset-password", {
          token,
          password: "short",
        })
      ).status,
      400,
    );
    const adminCookie = (await login("admin@example.com")).cookie;
    assert.equal(
      (
        await request("POST", "/api/auth/reset-password", {
          token,
          password: "Recovered admin pass 2026",
        })
      ).status,
      200,
    );
    // Reset revoked the earlier admin session and is single-use.
    assert.equal(
      (await request("GET", "/api/session", undefined, adminCookie)).status,
      401,
    );
    assert.equal(
      (
        await request("POST", "/api/auth/reset-password", {
          token,
          password: "Recovered admin pass 2026",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("POST", "/api/auth/login", {
          email: "admin@example.com",
          password: "test-password-123",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request("POST", "/api/auth/login", {
          email: "admin@example.com",
          password: "Recovered admin pass 2026",
        })
      ).status,
      200,
    );

    // Authenticated password change keeps a fresh session and drops old ones.
    const change = await request(
      "POST",
      "/api/auth/change-password",
      {
        current_password: "owner-pass-123",
        new_password: "Owner new pass 2026!",
      },
      owner,
    );
    assert.equal(change.status, 200);
    const fresh = change.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (await request("GET", "/api/session", undefined, owner)).status,
      401,
    );
    assert.equal(
      (await request("GET", "/api/session", undefined, fresh)).status,
      200,
    );
    assert.equal(
      (
        await request(
          "POST",
          "/api/auth/change-password",
          { current_password: "wrong", new_password: "another pass 12345" },
          fresh,
        )
      ).status,
      400,
    );
    // A member-session cookie is not a console session.
    assert.equal(
      (await request("POST", "/api/auth/change-password", {
        current_password: "x",
        new_password: "twelve chars xx",
      })).status,
      401,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("production console delivery never exposes development links and failure persists honestly", async () => {
  const { db } = fixture();
  let delivered;
  const env = { NODE_ENV: "production", PUBLIC_URL: "https://club.example" };
  const server = makeApp(db, {
    auth: {
      env,
      sendInvitation: async (m) => {
        delivered = m;
      },
      sendRecovery: async (m) => {
        delivered = m;
      },
    },
  }).listen(0, "127.0.0.1");
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
  try {
    const login = await request("POST", "/api/auth/login", {
      email: "owner@example.com",
      password: "owner-pass-123",
    });
    const owner = login.headers.get("set-cookie").split(";")[0];
    const invite = await request(
      "POST",
      "/api/admin-users/invitations",
      { email: "prod@example.com", name: "Prod", role: "admin" },
      owner,
    );
    assert.equal(invite.status, 201);
    const body = await invite.json();
    assert.equal("development_link" in body, false);
    assert.equal(JSON.stringify(body).includes("token="), false);
    assert.equal(delivered.to, "prod@example.com");
    const url = new URL(delivered.url);
    assert.equal(url.origin, "https://club.example");
    assert.equal(url.pathname, "/accept-invitation");
    const sent = db
      .prepare("SELECT sent_at,delivery_error FROM admin_invitations WHERE id=?")
      .get(body.id);
    assert.ok(sent.sent_at);
    assert.equal(sent.delivery_error, "");

    // Without any configured provider the route refuses before creating rows.
    const bare = openDb(":memory:");
    bare
      .prepare("INSERT INTO organizations(id,name) VALUES('org','Club')")
      .run();
    bare
      .prepare(
        "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES('o','org','O','o@e.com',?,'owner')",
      )
      .run(passwordHash("owner-pass-123"));
    const strict = makeApp(bare, { auth: { env } }).listen(0, "127.0.0.1");
    await new Promise((r) => strict.once("listening", r));
    try {
      const bbase = `http://127.0.0.1:${strict.address().port}`;
      const login2 = await fetch(bbase + "/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fieldhouse-Request": "1",
        },
        body: JSON.stringify({ email: "o@e.com", password: "owner-pass-123" }),
      });
      const refused = await fetch(bbase + "/api/admin-users/invitations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fieldhouse-Request": "1",
          Cookie: login2.headers.get("set-cookie").split(";")[0],
        },
        body: JSON.stringify({
          email: "p@example.com",
          name: "P",
          role: "admin",
        }),
      });
      assert.equal(refused.status, 503);
      assert.equal(
        bare.prepare("SELECT COUNT(*) n FROM admin_invitations").get().n,
        0,
      );
    } finally {
      await new Promise((r) => strict.close(r));
      bare.close();
    }
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("public console auth endpoints are rate limited", async () => {
  const { db, server, request } = await httpFixture();
  try {
    for (let i = 0; i < 6; i++)
      assert.equal(
        (
          await request("POST", "/api/auth/forgot-password", {
            email: `n${i}@example.com`,
          })
        ).status,
        202,
      );
    assert.equal(
      (
        await request("POST", "/api/auth/forgot-password", {
          email: "n7@example.com",
        })
      ).status,
      429,
    );
    for (let i = 0; i < 6; i++)
      await request("POST", "/api/auth/accept-invitation", {
        token: "0".repeat(64),
        password: "twelve chars xx",
      });
    assert.equal(
      (
        await request("POST", "/api/auth/accept-invitation", {
          token: "0".repeat(64),
          password: "twelve chars xx",
        })
      ).status,
      429,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

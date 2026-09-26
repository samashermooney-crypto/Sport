import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
import {
  initializeMemberAuth,
  beginMemberSignup,
  verifyMemberSignup,
  memberFamily,
} from "./member-auth.mjs";

const signup = {
  email: "parent@example.com",
  password: "Example family pass 2026!",
  first_name: "Casey",
  last_name: "Example",
  birthdate: "1988-05-12",
};
function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
  ).run();
  initializeMemberAuth(db);
  return db;
}
function person(
  db,
  org,
  email,
  household = null,
  kind = "player",
  birthdate = "2015-01-01",
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
    "{}",
    now(),
  );
  return personId;
}
test("member signup creates no profile before verification, binds tokens to organizations, and never claims existing members", () => {
  const db = fixture();
  try {
    assert.throws(
      () =>
        beginMemberSignup(db, "org", { ...signup, birthdate: "2015-01-01" }),
      /parent or adult/,
    );
    const pending = beginMemberSignup(db, "org", signup);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, 0);
    const token = db.prepare("SELECT * FROM member_signup_tokens").get();
    assert.notEqual(token.token_hash, pending.token);
    assert.equal(token.data.includes(signup.password), false);
    assert.throws(
      () => verifyMemberSignup(db, "other", pending.token),
      /invalid or expired/,
    );
    const account = verifyMemberSignup(db, "org", pending.token);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM member_accounts").get().n,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM household_members WHERE role='Supervisor'",
        )
        .get().n,
      1,
    );
    assert.equal(memberFamily(db, account)[0].self, true);
    assert.throws(
      () => verifyMemberSignup(db, "org", pending.token),
      /invalid or expired/,
    );
    assert.throws(
      () =>
        beginMemberSignup(db, "org", {
          ...signup,
          email: signup.email.toUpperCase(),
        }),
      /already belongs/,
    );
    person(db, "org", "existing@example.com");
    assert.throws(
      () =>
        beginMemberSignup(db, "org", {
          ...signup,
          email: "existing@example.com",
        }),
      /already belongs/,
    );
    const other = beginMemberSignup(db, "other", signup);
    assert.equal(verifyMemberSignup(db, "other", other.token).org_id, "other");
  } finally {
    db.close();
  }
});
test("replacement, expiration and an intervening member creation cannot reuse a signup challenge", () => {
  const db = fixture();
  try {
    const old = beginMemberSignup(db, "org", signup),
      current = beginMemberSignup(db, "org", signup);
    assert.throws(
      () => verifyMemberSignup(db, "org", old.token),
      /invalid or expired/,
    );
    db.prepare(
      "UPDATE member_signup_tokens SET expires_at='2000-01-01T00:00:00.000Z'",
    ).run();
    assert.throws(
      () => verifyMemberSignup(db, "org", current.token),
      /invalid or expired/,
    );
    const later = beginMemberSignup(db, "org", signup);
    person(db, "org", signup.email);
    assert.throws(
      () => verifyMemberSignup(db, "org", later.token),
      /already in use/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM member_accounts").get().n,
      0,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM households").get().n, 0);
  } finally {
    db.close();
  }
});
test("family participant access includes self and children but not other guardians or foreign members", () => {
  const db = fixture();
  try {
    const account = verifyMemberSignup(
      db,
      "org",
      beginMemberSignup(db, "org", signup).token,
    );
    const house = db
      .prepare("SELECT household_id FROM people WHERE id=?")
      .get(account.person_id).household_id;
    const child = person(db, "org", "", house),
      guardian = person(
        db,
        "org",
        "guardian@example.com",
        house,
        "parent",
        "1980-01-01",
      ),
      outsider = person(db, "other", "outsider@example.com");
    for (const [personId, role] of [
      [child, "Member"],
      [guardian, "Supervisor"],
      [outsider, "Member"],
    ])
      db.prepare("INSERT INTO household_members VALUES(?,?,?)").run(
        house,
        personId,
        role,
      );
    const family = memberFamily(db, account);
    assert.equal(family.find((p) => p.id === child).can_register, true);
    assert.equal(family.find((p) => p.id === guardian).can_register, false);
    assert.equal(
      family.some((p) => p.id === outsider),
      false,
    );
    assert.equal(JSON.stringify(family).includes("password"), false);
  } finally {
    db.close();
  }
});
test("member HTTP sessions cannot access console APIs, and password changes revoke previous sessions", async () => {
  const db = fixture();
  db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
    "admin",
    "org",
    "Admin",
    "admin@example.com",
    passwordHash("test-password"),
    "owner",
  );
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = "") =>
    fetch(root + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
        cookie,
      },
      body: JSON.stringify(body),
    });
  const readCookie = (response) =>
    response.headers.get("set-cookie").split(";")[0];
  try {
    const response = await post("/api/member/org/signup", {
      ...signup,
      program: "program-123&other=value",
      return_page: "members-guide",
      return_team: "team/example?test=1",
    });
    assert.equal(response.status, 202);
    const pending = await response.json();
    assert.ok(pending.development_link);
    const verificationUrl = new URL(pending.development_link, root);
    assert.equal(verificationUrl.origin, root);
    assert.equal(verificationUrl.pathname, "/site/org/account/verify");
    assert.equal(
      verificationUrl.searchParams.get("program"),
      "program-123&other=value",
    );
    assert.equal(
      verificationUrl.searchParams.get("return_page"),
      "members-guide",
    );
    assert.equal(verificationUrl.searchParams.has("other"), false);
    assert.equal(verificationUrl.searchParams.get("return_team"), "team/example?test=1");
    const token = new URL(pending.development_link, root).searchParams.get(
      "token",
    );
    const verified = await post("/api/member/org/verify", { token });
    assert.equal(verified.status, 200);
    assert.match(verified.headers.get("set-cookie"), /HttpOnly/);
    assert.match(verified.headers.get("set-cookie"), /SameSite=Strict/);
    const firstCookie = readCookie(verified);
    const session = await (
      await fetch(root + "/api/member/org/session", {
        headers: { cookie: firstCookie },
      })
    ).json();
    assert.equal(session.email, signup.email);
    assert.equal("password_hash" in session, false);
    assert.equal(
      await (
        await fetch(root + "/api/member/other/session", {
          headers: { cookie: firstCookie },
        })
      ).json(),
      null,
    );
    assert.equal(
      (await fetch(root + "/api/people", { headers: { cookie: firstCookie } }))
        .status,
      401,
    );
    assert.equal(
      (await post("/api/registrations", {}, firstCookie)).status,
      401,
    );
    assert.equal(
      (
        await fetch(root + "/api/member/other/family", {
          headers: { cookie: firstCookie },
        })
      ).status,
      401,
    );
    const adminLogin = await post("/api/auth/login", {
      email: "admin@example.com",
      password: "test-password",
    });
    assert.equal(
      (
        await fetch(root + "/api/member/org/family", {
          headers: { cookie: readCookie(adminLogin) },
        })
      ).status,
      401,
    );
    const invalid = await post(
      "/api/member/org/password",
      {
        current_password: "wrong",
        new_password: "Changed secure password 2026!",
      },
      firstCookie,
    );
    assert.equal(invalid.status, 400);
    const changed = await post(
      "/api/member/org/password",
      {
        current_password: signup.password,
        new_password: "Changed secure password 2026!",
      },
      firstCookie,
    );
    assert.equal(changed.status, 200);
    const currentCookie = readCookie(changed);
    assert.equal(
      await (
        await fetch(root + "/api/member/org/session", {
          headers: { cookie: firstCookie },
        })
      ).json(),
      null,
    );
    assert.equal((await post("/api/member/org/login", signup)).status, 401);
    assert.equal(
      (
        await post("/api/member/org/login", {
          email: signup.email,
          password: "Changed secure password 2026!",
        })
      ).status,
      200,
    );
    assert.equal(
      (await post("/api/member/org/logout", {}, currentCookie)).status,
      200,
    );
    assert.equal(
      await (
        await fetch(root + "/api/member/org/session", {
          headers: { cookie: currentCookie },
        })
      ).json(),
      null,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("production signup never exposes a development token and requires configured email delivery", async () => {
  for (const configured of [false, true]) {
    const db = fixture();
    let delivered;
    const memberAuth = {
      env: { NODE_ENV: "production", PUBLIC_URL: "https://club.example.com" },
      ...(configured
        ? {
            sendVerification: async (message) => {
              delivered = message;
            },
          }
        : {}),
    };
    const server = makeApp(db, { memberAuth }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/member/org/signup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fieldhouse-Request": "1",
          },
          body: JSON.stringify(signup),
        },
      );
      assert.equal(response.status, configured ? 202 : 503);
      const result = await response.json();
      assert.equal("development_link" in result, false);
      assert.equal(JSON.stringify(result).includes("token="), false);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM member_signup_tokens").get().n,
        configured ? 1 : 0,
      );
      if (configured) {
        assert.equal(delivered.to, signup.email);
        assert.equal(new URL(delivered.url).origin, "https://club.example.com");
        assert.equal(
          db.prepare("SELECT COUNT(*) n FROM member_accounts").get().n,
          0,
        );
      }
    } finally {
      await new Promise((r) => server.close(r));
      db.close();
    }
  }
});

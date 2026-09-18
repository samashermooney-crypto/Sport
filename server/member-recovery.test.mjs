import test from "node:test";
import assert from "node:assert/strict";
import { openDb, passwordHash, passwordMatches } from "./db.mjs";
import { initializeMemberAuth } from "./member-auth.mjs";
import {
  beginMemberRecovery,
  finishMemberRecovery,
} from "./member-recovery.mjs";

test("member reset links are scoped, expire, rotate, and revoke sessions on one-time consumption", () => {
  const db = openDb(":memory:");
  try {
    initializeMemberAuth(db);
    db.exec(
      "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other'); INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES('p','org','Test','Adult','2026-09-09')",
    );
    db.prepare(
      "INSERT INTO member_accounts VALUES('a','org','p','test@example.com',?,'2026-09-09','2026-09-09')",
    ).run(passwordHash("old-password-123"));
    db.exec("INSERT INTO member_sessions VALUES('session','a','2099-01-01')");
    assert.equal(
      beginMemberRecovery(db, "org", { email: "missing@example.com" }),
      null,
    );
    const first = beginMemberRecovery(db, "org", { email: "TEST@example.com" });
    const next = beginMemberRecovery(db, "org", { email: "test@example.com" });
    assert.throws(
      () =>
        finishMemberRecovery(db, "org", {
          token: first.token,
          password: "new-password-123",
        }),
      /invalid or expired/,
    );
    assert.throws(
      () =>
        finishMemberRecovery(db, "other", {
          token: next.token,
          password: "new-password-123",
        }),
      /invalid or expired/,
    );
    finishMemberRecovery(db, "org", {
      token: next.token,
      password: "new-password-123",
    });
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM member_sessions").get().n,
      0,
    );
    assert.equal(
      passwordMatches(
        "new-password-123",
        db.prepare("SELECT password_hash FROM member_accounts").get()
          .password_hash,
      ),
      true,
    );
    assert.throws(
      () =>
        finishMemberRecovery(db, "org", {
          token: next.token,
          password: "another-password-123",
        }),
      /invalid or expired/,
    );
    const expired = beginMemberRecovery(db, "org", {
      email: "test@example.com",
    });
    db.exec("UPDATE member_reset_tokens SET expires_at='2000-01-01'");
    assert.throws(
      () =>
        finishMemberRecovery(db, "org", {
          token: expired.token,
          password: "another-password-123",
        }),
      /invalid or expired/,
    );
  } finally {
    db.close();
  }
});

test("recovery HTTP flow sends scoped links, hides unknown accounts, and invalidates the old login", async () => {
  const { makeApp } = await import("./app.mjs");
  const db = openDb(":memory:");
  initializeMemberAuth(db);
  db.exec(
    "INSERT INTO organizations(id,name) VALUES('org','Club'); INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES('p','org','Test','Adult','2026-09-09')",
  );
  db.prepare(
    "INSERT INTO member_accounts VALUES('a','org','p','test@example.com',?,'2026-09-09','2026-09-09')",
  ).run(passwordHash("old-password-123"));
  let delivered;
  const server = makeApp(db, {
    memberAuth: {
      env: { NODE_ENV: "production", PUBLIC_URL: "https://club.example" },
      sendRecovery: async (value) => {
        delivered = value;
      },
    },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const post = (action, body) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/api/member/org/${action}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fieldhouse-Request": "1",
        },
        body: JSON.stringify(body),
      },
    );
  try {
    const known = await post("forgot-password", { email: "test@example.com" });
    assert.equal(known.status, 202);
    const response = await known.json();
    assert.equal(response.development_link, undefined);
    assert.deepEqual(
      await (
        await post("forgot-password", { email: "unknown@example.com" })
      ).json(),
      response,
    );
    assert.equal(delivered.to, "test@example.com");
    const url = new URL(delivered.url);
    assert.equal(url.origin, "https://club.example");
    assert.equal(url.pathname, "/site/org/account/reset-password");
    const token = url.searchParams.get("token");
    assert.equal(
      (await post("reset-password", { token, password: "short" })).status,
      400,
    );
    assert.equal(
      (await post("reset-password", { token, password: "new-password-123" }))
        .status,
      200,
    );
    assert.equal(
      (
        await post("login", {
          email: "test@example.com",
          password: "old-password-123",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post("login", {
          email: "test@example.com",
          password: "new-password-123",
        })
      ).status,
      200,
    );
    assert.equal(
      (await post("reset-password", { token, password: "other-password-123" }))
        .status,
      400,
    );
    for (let i = 0; i < 4; i++)
      assert.equal(
        (await post("forgot-password", { email: "unknown@example.com" }))
          .status,
        202,
      );
    assert.equal(
      (await post("forgot-password", { email: "unknown@example.com" })).status,
      429,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

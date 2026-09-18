import test from "node:test";
import assert from "node:assert/strict";
import { openDb, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
test("API requires authentication, rejects foreign origins, and blocks reporter writes", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "org",
    "Test",
  );
  db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
    "owner",
    "org",
    "Admin",
    "owner@example.com",
    passwordHash("test-password"),
    "owner",
  );
  db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
    "reporter",
    "org",
    "Reporter",
    "reporter@example.com",
    passwordHash("test-password"),
    "reporter",
  );
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const login = (email, origin = base) =>
    fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
        Origin: origin,
      },
      body: JSON.stringify({ email, password: "test-password" }),
    });
  try {
    assert.equal((await fetch(base + "/api/programs")).status, 401);
    assert.equal((await fetch(base + "/api/session")).status, 401);
    const anonymousMember = await fetch(base + "/api/member/org/session");
    assert.equal(anonymousMember.status, 200);
    assert.equal(await anonymousMember.json(), null);
    assert.equal((await fetch(base + "/api/search?q=Test")).status, 401);
    assert.equal(
      (await login("owner@example.com", "https://untrusted.example")).status,
      403,
    );
    const response = await login("owner@example.com", "http://127.0.0.1:5173");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const sessionResponse = await fetch(base + "/api/session", { headers: { Cookie: cookie } });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.user.id, "owner");
    assert.equal(session.organization.id, "org");
    assert.equal("password_hash" in session.user, false);
    assert.equal("token_hash" in session.user, false);
    const searchResponse = await fetch(base + "/api/search?q=Test", { headers: { Cookie: cookie } });
    assert.equal(searchResponse.status, 200);
    assert.deepEqual(await searchResponse.json(), { results: [] });
    assert.equal(
      (await fetch(base + "/api/programs", { headers: { Cookie: cookie } }))
        .status,
      200,
    );
    const reporter = await login("reporter@example.com");
    const preview = (body, authCookie = cookie) => fetch(base + "/api/schedule/import/preview", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Fieldhouse-Request": "1", Cookie: authCookie },
      body: JSON.stringify(body),
    });
    assert.equal((await preview({}, "")).status, 401);
    assert.equal((await preview({})).status, 400);
    assert.equal((await preview({ csv: "NAME,TYPE,START_DATE,START_TIME\nPractice,PRACTICE,09/12/2026,09:00", mappings: null })).status, 400);
    const previewResponse = await preview({ csv: "NAME,TYPE,START_DATE,START_TIME\nPractice,PRACTICE,09/12/2026,09:00" });
    assert.equal(previewResponse.status, 200);
    assert.equal((await previewResponse.json()).ready, false);
    assert.equal((await preview({}, reporter.headers.get("set-cookie").split(";")[0])).status, 403);
    assert.equal(
      (
        await fetch(base + "/api/people", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fieldhouse-Request": "1",
            Cookie: reporter.headers.get("set-cookie").split(";")[0],
          },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("product image uploads validate file types and remain scoped to the organization", async () => {
  const db = openDb(":memory:");
  for (const org of ["one", "two"]) {
    db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(org, org);
    db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
      org,
      org,
      "Admin",
      org + "@example.com",
      passwordHash("test-password"),
      "owner",
    );
  }
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const login = async (org) => {
    const r = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
      },
      body: JSON.stringify({
        email: org + "@example.com",
        password: "test-password",
      }),
    });
    return r.headers.get("set-cookie").split(";")[0];
  };
  try {
    const cookie = await login("one"),
      foreign = await login("two"),
      headers = {
        "Content-Type": "image/png",
        "X-Fieldhouse-Request": "1",
        Cookie: cookie,
      };
    const invalid = await fetch(base + "/api/assets", {
      method: "POST",
      headers,
      body: '<svg onload="alert(1)"></svg>',
    });
    assert.equal(invalid.status, 400);
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9xkAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = await fetch(base + "/api/assets", {
      method: "POST",
      headers,
      body: bytes,
    });
    assert.equal(upload.status, 201);
    const asset = await upload.json();
    const image = await fetch(base + "/api/assets/" + asset.id, {
      headers: { Cookie: cookie },
    });
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type"), /image\/png/);
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    assert.equal((await fetch(base + "/api/assets/" + asset.id)).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/assets/" + asset.id, {
          headers: { Cookie: foreign },
        })
      ).status,
      404,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

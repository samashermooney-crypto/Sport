import test from "node:test";
import assert from "node:assert/strict";
import { openDb, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProgram } from "./domain.mjs";

test("HTTP import preview and accept enforce access, preserve content, and support safe retries", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club')").run();
  for (const role of ["owner", "reporter"])
    db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(role, "org", role, `${role}@example.com`, passwordHash("test-password"), role);
  const p = saveProgram(db, { id: "owner", org_id: "org" }, { name: "Import League", type: "League", sport: "Soccer", gender: "Co-Ed", level: "All", season: "Fall", start_date: "2026-09-12", fee_cents: 0, capacity: 100 });
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, cookie = "", origin = base) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Fieldhouse-Request": "1", Cookie: cookie, Origin: origin }, body: JSON.stringify(body),
  });
  try {
    const login = async (role) => {
      const response = await request("/api/auth/login", { email: `${role}@example.com`, password: "test-password" });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const owner = await login("owner"), reporter = await login("reporter");
    const body = { program_id: p.id, request_key: "http-import-test-0001", csv: "NAME,TYPE,START_DATE,START_TIME,DESCRIPTION,LOCATION_NOTE\nOrientation,MEETING,09/12/2026,09:00,Bring water,Gate B" };
    const endpoint = "/api/schedule/import/accept";
    assert.equal((await request(endpoint, body)).status, 401);
    assert.equal((await request(endpoint, body, reporter)).status, 403);
    assert.equal((await request(endpoint, body, owner, "https://foreign.example")).status, 403);
    const preview = await request("/api/schedule/import/preview", body, owner);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).ready, true);
    assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 0);
    const accepted = await request(endpoint, body, owner);
    assert.equal(accepted.status, 200);
    const result = await accepted.json();
    assert.equal(result.count, 1);
    const retry = await request(endpoint, body, owner);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), result);
    const saved = db.prepare("SELECT * FROM events").all();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].published, 0);
    assert.equal(saved[0].start_at, "2026-09-12T14:00:00.000Z");
    assert.equal(saved[0].end_at, "");
    assert.equal(JSON.parse(saved[0].data).description, "Bring water");
    assert.equal(JSON.parse(saved[0].data).location_note, "Gate B");
    assert.equal((await request(endpoint, { ...body, published: true }, owner)).status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

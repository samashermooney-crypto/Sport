import test from "node:test";
import assert from "node:assert/strict";
import { openDb, passwordHash, unpack } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProgram } from "./domain.mjs";
import { getTerminology, saveTerminology } from "./terminology.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('foreign','Other')",
  ).run();
  const actor = { id: "admin", org_id: "org" };
  const base = {
    name: "Season",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "All",
    season: "Fall",
    start_date: "2026-10-01",
    description: "Keep this description",
    accounting_codes: ["Original code"],
  };
  const program = saveProgram(db, actor, base);
  return { db, actor, base, program };
}
const read = (db, id) =>
  unpack(db.prepare("SELECT * FROM programs WHERE id=?").get(id));

test("terminology renames update existing program values atomically without changing other organizations or details", () => {
  const { db, actor, base, program } = fixture();
  try {
    const foreign = saveProgram(db, { ...actor, org_id: "foreign" }, base);
    const settings = getTerminology(db, "org");
    const season = settings.fields[0];
    season.label = "Session";
    season.options.find((o) => o.label === "Fall").label = "Autumn";
    settings.fields[2].label = "Department";
    settings.fields[2].enabled = true;
    settings.fields[2].options[0].label = "Youth recreation";
    const saved = saveTerminology(db, actor, settings);
    assert.equal(saved.version, 2);
    assert.equal(read(db, program.id).season, "Autumn");
    assert.deepEqual(read(db, program.id).accounting_codes, [
      "Youth recreation",
    ]);
    assert.equal(read(db, program.id).description, base.description);
    assert.equal(read(db, foreign.id).season, "Fall");
    assert.deepEqual(read(db, foreign.id).accounting_codes, ["Original code"]);
    assert.equal(getTerminology(db, "foreign").version, 1);
    assert.throws(() => saveTerminology(db, actor, settings), /changed/);
    const bad = structuredClone(saved);
    bad.fields[0].options.find((o) => o.label === "Autumn").label =
      "Later rename";
    bad.fields[2].options = [];
    assert.throws(() => saveTerminology(db, actor, bad), /used by a program/);
    assert.equal(read(db, program.id).season, "Autumn");
    assert.equal(getTerminology(db, "org").version, 2);
    const removeUnused = structuredClone(saved);
    removeUnused.fields[0].options = removeUnused.fields[0].options.filter(
      (o) => o.label !== "Winter",
    );
    assert.equal(saveTerminology(db, actor, removeUnused).version, 3);
    const duplicates = getTerminology(db, "org");
    duplicates.fields[0].options.push({ id: "new", label: "autumn" });
    assert.throws(
      () => saveTerminology(db, actor, duplicates),
      /duplicate options/,
    );
    assert.equal(getTerminology(db, "org").version, 3);
  } finally {
    db.close();
  }
});

test("program creation enforces configured requirements, valid choices and stale terminology versions", () => {
  const { db, actor, base, program } = fixture();
  try {
    const settings = getTerminology(db, "org");
    settings.fields[0].required_types = ["League"];
    settings.fields[1].required_types = ["League", "Tournament"];
    const saved = saveTerminology(db, actor, settings);
    const event = saveProgram(db, actor, {
      ...base,
      type: "Event",
      season: "",
      level: "",
      terminology_version: saved.version,
    });
    assert.equal(event.season, "");
    assert.equal(event.level, "");
    assert.throws(
      () =>
        saveProgram(db, actor, {
          ...base,
          season: "",
          terminology_version: saved.version,
        }),
      /Season is required/,
    );
    assert.throws(
      () =>
        saveProgram(db, actor, {
          ...base,
          type: "Tournament",
          season: "",
          level: "",
          terminology_version: saved.version,
        }),
      /Level is required/,
    );
    assert.throws(
      () =>
        saveProgram(db, actor, {
          ...base,
          season: "Unknown season",
          terminology_version: saved.version,
        }),
      /available Season/,
    );
    assert.throws(
      () =>
        saveProgram(db, actor, { ...base, terminology_version: 1 }, program.id),
      /Terminology changed/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM programs WHERE org_id='org'").get().n,
      2,
    );
    assert.equal(read(db, program.id).season, "Fall");
    const enabled = structuredClone(saved);
    enabled.fields[2].enabled = true;
    const next = saveTerminology(db, actor, enabled);
    assert.throws(
      () =>
        saveProgram(db, actor, {
          ...base,
          accounting_codes: ["Unknown"],
          terminology_version: next.version,
        }),
      /available Accounting Code 1/,
    );
    const allowed = saveProgram(db, actor, {
      ...base,
      terminology_version: next.version,
    });
    assert.deepEqual(allowed.accounting_codes, ["Original code"]);
  } finally {
    db.close();
  }
});

test("terminology HTTP routes require console access and scope changes to the signed-in organization", async () => {
  const { db } = fixture();
  for (const [id, org, role] of [
    ["owner", "org", "owner"],
    ["reporter", "org", "reporter"],
    ["other", "foreign", "owner"],
  ])
    db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
      id,
      org,
      id,
      `${id}@example.com`,
      passwordHash("test-password"),
      role,
    );
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  const login = async (name) => {
    const response = await fetch(root + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
      },
      body: JSON.stringify({
        email: `${name}@example.com`,
        password: "test-password",
      }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  try {
    assert.equal((await fetch(root + "/api/terminology")).status, 401);
    const owner = await login("owner"),
      reporter = await login("reporter"),
      other = await login("other");
    const settings = await (
      await fetch(root + "/api/terminology", { headers: { cookie: owner } })
    ).json();
    settings.fields[0].label = "Session";
    const write = (cookie) =>
      fetch(root + "/api/terminology", {
        method: "PUT",
        headers: {
          cookie,
          "Content-Type": "application/json",
          "X-Fieldhouse-Request": "1",
        },
        body: JSON.stringify(settings),
      });
    assert.equal((await write(reporter)).status, 403);
    assert.equal((await write(owner)).status, 200);
    assert.equal((await write(owner)).status, 409);
    const foreign = await (
      await fetch(root + "/api/terminology", { headers: { cookie: other } })
    ).json();
    assert.equal(foreign.fields[0].label, "Season");
    assert.equal(foreign.version, 1);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

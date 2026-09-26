import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, passwordHash } from "./db.mjs";
import { seed, shouldSeedDemo } from "./seed.mjs";
import { makeApp } from "./app.mjs";
import { organizationId, initializeOrganization } from "./initialize.mjs";

const CLI = new URL("./initialize.mjs", import.meta.url).pathname;
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    input: "",
  });
}
const initArgs = (db) => [
  "--db",
  db,
  "--org-name",
  "River City Athletics",
  "--timezone",
  "America/Chicago",
  "--owner-name",
  "Jordan Owner",
  "--owner-email",
  "Owner@Example.com",
];

test("clean initialization creates a real organization and owner that can sign in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-init-"));
  const file = join(dir, "fieldhouse.sqlite");
  try {
    const first = runCli(initArgs(file), {
      FIELDHOUSE_OWNER_PASSWORD: "Owner secret 2026!",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /River City Athletics/);
    assert.equal(first.stdout.includes("Owner secret"), false);
    assert.equal(first.stderr.includes("Owner secret"), false);

    const db = openDb(file);
    const org = db.prepare("SELECT * FROM organizations").get();
    assert.equal(org.id, "river-city-athletics");
    assert.equal(org.currency, "USD");
    const owner = db.prepare("SELECT * FROM users").get();
    assert.equal(owner.role, "owner");
    assert.equal(owner.active, 1);
    // No demo records are created.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM programs").get().n, 0);

    // The created owner can sign in through the real HTTP stack.
    const server = makeApp(db).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const login = await fetch(
        `http://127.0.0.1:${server.address().port}/api/auth/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fieldhouse-Request": "1",
          },
          body: JSON.stringify({
            email: "owner@example.com",
            password: "Owner secret 2026!",
          }),
        },
      );
      assert.equal(login.status, 200);
      const session = await login.json();
      assert.equal(session.org_id, "river-city-athletics");
      assert.equal(session.role, "owner");
    } finally {
      await new Promise((r) => server.close(r));
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated initialization refuses an occupied database without touching it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-init-"));
  const file = join(dir, "fieldhouse.sqlite");
  try {
    assert.equal(
      runCli(initArgs(file), { FIELDHOUSE_OWNER_PASSWORD: "Owner secret 2026!" })
        .status,
      0,
    );
    const again = runCli(
      initArgs(file).map((a) => (a === "River City Athletics" ? "Other" : a)),
      { FIELDHOUSE_OWNER_PASSWORD: "Different pass 2026" },
    );
    assert.equal(again.status, 2);
    assert.match(again.stderr, /refused|already contains/);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT name FROM organizations").get().name,
        "River City Athletics",
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM users").get().n,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid input rolls back without leaving a partial organization", () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-init-"));
  const file = join(dir, "fieldhouse.sqlite");
  try {
    const bad = runCli(
      initArgs(file).map((a) =>
        a === "America/Chicago" ? "Not/AZone" : a,
      ),
      { FIELDHOUSE_OWNER_PASSWORD: "Owner secret 2026!" },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /time zone/i);
    const short = runCli(initArgs(file).map((a) =>
        a === "fieldhouse.sqlite" ? "second.sqlite" : a,
      ), { FIELDHOUSE_OWNER_PASSWORD: "short" });
    assert.equal(short.status, 1);
    const db = openDb(file);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM organizations").get().n,
        0,
      );
      assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
    } finally {
      db.close();
    }
    // A later valid initialization still succeeds on the same file.
    const retry = runCli(initArgs(file), {
      FIELDHOUSE_OWNER_PASSWORD: "Owner secret 2026!",
    });
    assert.equal(retry.status, 0, retry.stderr);
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing demo database is refused and keeps operating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-init-"));
  const file = join(dir, "demo.sqlite");
  try {
    const db = openDb(file);
    const originalPassword = process.env.DEMO_PASSWORD;
    process.env.DEMO_PASSWORD = "Demo fixture pass 2026";
    try {
      seed(db);
    } finally {
      process.env.DEMO_PASSWORD = originalPassword;
    }
    const before = db.prepare("SELECT COUNT(*) n FROM people").get().n;
    const refused = runCli(initArgs(file), {
      FIELDHOUSE_OWNER_PASSWORD: "Owner secret 2026!",
    });
    assert.equal(refused.status, 2);
    assert.equal(
      db.prepare("SELECT name FROM organizations").get().name,
      "Northstar Youth Sports",
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, before);
    // The demo owner still signs in on the existing database.
    const server = makeApp(db).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const login = await fetch(
        `http://127.0.0.1:${server.address().port}/api/auth/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fieldhouse-Request": "1",
          },
          body: JSON.stringify({
            email: "admin@athlentry.local",
            password: "Demo fixture pass 2026",
          }),
        },
      );
      assert.equal(login.status, 200);
    } finally {
      await new Promise((r) => server.close(r));
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrations extend a legacy users table without disturbing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-init-"));
  const file = join(dir, "legacy.sqlite");
  try {
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,timezone TEXT NOT NULL DEFAULT 'America/Chicago',currency TEXT NOT NULL DEFAULT 'USD');
      INSERT INTO organizations VALUES('org','Club','America/Chicago','USD');
      CREATE TABLE users(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','manager','coach','parent','reporter')));
      INSERT INTO users VALUES('legacy','org','Legacy','legacy@example.com','hash','admin');
    `);
    raw.close();
    const db = openDb(file);
    try {
      const columns = db
        .prepare("PRAGMA table_info(users)")
        .all()
        .map((c) => c.name);
      for (const column of ["active", "revision", "deactivated_at"])
        assert.ok(columns.includes(column), column);
      const user = db.prepare("SELECT * FROM users WHERE id='legacy'").get();
      assert.equal(user.role, "admin");
      assert.equal(user.active, 1);
      for (const table of [
        "admin_invitations",
        "admin_reset_tokens",
        "member_account_invitations",
      ])
        assert.ok(
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table),
          table,
        );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("demo seeding is gated for production startup", () => {
  assert.equal(shouldSeedDemo({ NODE_ENV: "production" }), false);
  assert.equal(shouldSeedDemo({ NODE_ENV: "production", SEED_DEMO: "true" }), true);
  assert.equal(shouldSeedDemo({}), true);
  assert.equal(shouldSeedDemo({ SEED_DEMO: "false" }), false);
  assert.equal(organizationId("River City Athletics!"), "river-city-athletics");
  assert.equal(organizationId("  "), "organization");
  // Direct domain initialization enforces the same refusal.
  const db = openDb(":memory:");
  try {
    initializeOrganization(db, {
      orgName: "Club",
      orgId: "club",
      timezone: "UTC",
      ownerName: "Owner",
      ownerEmail: "o@example.com",
      ownerPassword: "twelve chars plus",
    });
    assert.throws(
      () =>
        initializeOrganization(db, {
          orgName: "Club",
          orgId: "club",
          timezone: "UTC",
          ownerName: "Owner",
          ownerEmail: "o@example.com",
          ownerPassword: "twelve chars plus",
        }),
      /refused/,
    );
  } finally {
    db.close();
  }
});

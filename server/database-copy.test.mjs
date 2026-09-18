import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.mjs";
import { copyDatabase } from "../scripts/database-copy.mjs";

test("backup and restore preserve committed WAL records and embedded files without overwriting data", () => {
  const dir = mkdtempSync(join(tmpdir(), "fieldhouse-backup-"));
  const source = join(dir, "live.sqlite"), backup = join(dir, "backup.sqlite"), restored = join(dir, "restored.sqlite");
  const db = openDb(source);
  try {
    db.exec("INSERT INTO organizations(id,name) VALUES('org','Backup Club')");
    db.prepare("INSERT INTO assets VALUES('asset','org','image/png',?,'2026-09-09')").run(Buffer.from([1,2,3,4]));
    copyDatabase(source, backup);
    db.exec("UPDATE organizations SET name='Changed after backup'");
    copyDatabase(backup, restored);
    const check = openDb(restored);
    try {
      assert.equal(check.prepare("SELECT name FROM organizations").get().name, "Backup Club");
      assert.deepEqual(Buffer.from(check.prepare("SELECT bytes FROM assets").get().bytes), Buffer.from([1,2,3,4]));
      assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { check.close(); }
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.throws(() => copyDatabase(source, backup), /already exists/);
    assert.equal(db.prepare("SELECT name FROM organizations").get().name, "Changed after backup");
    assert.throws(() => copyDatabase(join(dir,"missing"), restored), /does not exist/);
  } finally { db.close(); rmSync(dir, {recursive:true, force:true}); }
});

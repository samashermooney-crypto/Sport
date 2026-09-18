import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { migrateRegistrationHistory } from "./registration-migration.mjs";
import { saveProgram, register } from "./domain.mjs";

test("registration migration preserves historical links and triggers while enforcing one active enrollment", () => {
  const db = legacyDb();
  try {
    db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club')").run();
    const actor={id:"admin",org_id:"org"};
    const program=saveProgram(db,actor,{name:"League",type:"League",sport:"Soccer",gender:"Co-Ed",level:"All",season:"Fall",start_date:"2026-09-12",fee_cents:100});
    db.prepare("INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES('person','org','Test','Player','2026-09-09')").run();
    const old=register(db,actor,{program_id:program.id,person_id:"person"});
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(old.id);
    const triggerCount=db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n;
    migrateRegistrationHistory(db);
    migrateRegistrationHistory(db);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n,triggerCount);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.equal(db.prepare("SELECT invoice_id FROM registrations WHERE id=?").get(old.id).invoice_id,old.invoice_id);
    const replacement=register(db,actor,{program_id:program.id,person_id:"person"});
    assert.notEqual(replacement.id,old.id);
    assert.notEqual(replacement.invoice_id,old.invoice_id);
    assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(old.id).status,"Canceled");
    assert.throws(()=>register(db,actor,{program_id:program.id,person_id:"person"}),/already registered/);
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=?").run(replacement.id);
    const insert=db.prepare("INSERT INTO registrations SELECT ?,org_id,program_id,person_id,team_id,NULL,role,?,NULL,created_at FROM registrations WHERE id=?");
    insert.run('new','Pending',old.id);
    assert.throws(()=>insert.run('duplicate','Confirmed',old.id),/UNIQUE/);
    insert.run('another-history','Canceled',old.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registrations").get().n,4);
  } finally {db.close();}
});

test("failed migration restores the original schema, rows, triggers and foreign-key enforcement", () => {
  const db=legacyDb();
  try {
    // A pre-existing orphan must cause verification to reject the migration.
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("INSERT INTO registrations VALUES('legacy','missing-org','missing-program','missing-person',NULL,NULL,'Free Agent','Canceled',NULL,'2026-09-09')").run();
    db.exec("PRAGMA foreign_keys=ON");
    const schema=db.prepare("SELECT sql FROM sqlite_master WHERE name='registrations'").get().sql;
    const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    assert.throws(()=>migrateRegistrationHistory(db),/foreign-key verification/);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='registrations'").get().sql,schema);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registrations").get().n,1);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),triggers);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='registrations_history_migration'").get().n,0);
    db.exec("BEGIN IMMEDIATE; ROLLBACK");
  } finally {db.close();}
});

function legacyDb() {
 const db=openDb(":memory:");
 const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='registrations'").get().sql;
 const triggers=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='registrations'").all();
 db.exec("PRAGMA foreign_keys=OFF; DROP TABLE registrations");
 db.exec(sql.replace(/\)$/,",UNIQUE(program_id,person_id))"));
 for(const trigger of triggers) db.exec(trigger.sql);
 db.exec("PRAGMA foreign_keys=ON");
 return db;
}

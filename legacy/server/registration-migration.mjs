// Rebuild the legacy table because SQLite cannot drop an inline UNIQUE constraint.
// Run only during database initialization, outside any application transaction.
export function migrateRegistrationHistory(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='registrations'").get();
  if (!table || !/UNIQUE\s*\(\s*program_id\s*,\s*person_id\s*\)/i.test(table.sql)) return;
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='registrations' AND sql IS NOT NULL").all();
  const create = table.sql
    .replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?registrations["`]?/i, 'CREATE TABLE registrations_history_migration')
    .replace(/,\s*UNIQUE\s*\(\s*program_id\s*,\s*person_id\s*\)/i, '');
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  db.exec("PRAGMA foreign_keys=OFF");
  let started = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    started = true;
    // Temporarily remove triggers so references remain valid while swapping tables.
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    db.exec(create);
    db.exec("INSERT INTO registrations_history_migration SELECT * FROM registrations");
    db.exec("DROP TABLE registrations");
    db.exec("ALTER TABLE registrations_history_migration RENAME TO registrations");
    for (const index of indexes) db.exec(index.sql);
    db.exec("CREATE UNIQUE INDEX registrations_one_active_enrollment ON registrations(program_id,person_id) WHERE status!='Canceled'");
    for (const trigger of triggers) db.exec(trigger.sql);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Registration migration failed foreign-key verification.");
    db.exec("COMMIT");
  } catch (error) {
    if (started) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

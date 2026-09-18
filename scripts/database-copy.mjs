import { DatabaseSync } from "node:sqlite";
import { existsSync, chmodSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// VACUUM INTO takes a consistent SQLite snapshot, including committed WAL data.
// Restores deliberately target a new file; never overwrite a running database.
export function copyDatabase(source, destination) {
  const input = resolve(source), output = resolve(destination);
  if (!existsSync(input)) throw new Error("Source database does not exist.");
  if (existsSync(output)) throw new Error("Destination already exists. Choose a new file.");
  const db = new DatabaseSync(input, { readOnly: true });
  let created = false;
  try {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Source database failed integrity validation.");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Source database has invalid foreign keys.");
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='organizations'").get())
      throw new Error("Source is not a Athlentry database.");
    db.prepare("VACUUM INTO ?").run(output);
    created = true;
    chmodSync(output, 0o600);
    const check = new DatabaseSync(output, { readOnly: true });
    try {
      if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || check.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Copied database failed validation.");
    } finally { check.close(); }
    return output;
  } catch (error) {
    if (created) rmSync(output, { force: true });
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination || process.argv.length !== 4) {
    console.error("Usage: npm run db:copy -- SOURCE.sqlite NEW_DESTINATION.sqlite");
    process.exitCode = 1;
  } else {
    try { console.log(`Validated database copy: ${copyDatabase(source, destination)}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

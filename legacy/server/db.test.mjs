import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.mjs";

test("nested transactions preserve atomic rollback and recover after errors", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries(value TEXT)");
  const add = (value) => db.prepare("INSERT INTO entries VALUES(?)").run(value);
  const values = () => db.prepare("SELECT value FROM entries").all().map(r => r.value);
  try {
    assert.throws(() => transaction(db, () => {
      transaction(db, () => add("first"));
      transaction(db, () => { add("second"); throw new Error("failed item"); });
    }), /failed item/);
    assert.deepEqual(values(), []);
    transaction(db, () => {
      add("kept");
      assert.throws(() => transaction(db, () => {
        add("discarded");
        throw new Error("recoverable");
      }), /recoverable/);
      transaction(db, () => add("also kept"));
    });
    assert.deepEqual(values(), ["kept", "also kept"]);
  } finally { db.close(); }
});

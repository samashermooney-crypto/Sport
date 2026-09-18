import test from "node:test";
import assert from "node:assert/strict";
import { scheduleImportInstant as instant } from "./schedule-import-time.mjs";

test("CSV wall times use the specified organization timezone and seasonal offset", () => {
  assert.equal(instant("2026-09-12", "09:00", "America/Chicago"), "2026-09-12T14:00:00.000Z");
  assert.equal(instant("2026-01-12", "09:00", "America/Chicago"), "2026-01-12T15:00:00.000Z");
  assert.equal(instant("2026-09-12", "00:00", "Asia/Kathmandu"), "2026-09-11T18:15:00.000Z");
});
test("imports reject nonexistent and ambiguous DST times instead of silently shifting games", () => {
  assert.throws(() => instant("2026-03-08", "02:30", "America/Chicago"), /does not exist/);
  assert.throws(() => instant("2026-11-01", "01:30", "America/Chicago"), /occurs twice/);
  assert.equal(instant("2026-03-08", "03:00", "America/Chicago"), "2026-03-08T08:00:00.000Z");
  assert.throws(() => instant("2026-10-04", "02:15", "Australia/Lord_Howe"), /does not exist/);
});
test("invalid dates and timezone configuration fail explicitly", () => {
  assert.throws(() => instant("2026-02-30", "09:00", "UTC"), /Invalid/);
  assert.throws(() => instant("2026-02-01", "24:00", "UTC"), /Invalid/);
  assert.throws(() => instant("2026-02-01", "09:00", "invalid-zone"), /timezone is invalid/);
});

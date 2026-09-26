import test from "node:test";
import assert from "node:assert/strict";
import { registrationAvailability as availability } from "./registration-availability.mjs";

test("registration dates use organization day and include opening and closing dates", () => {
  const program = { status: "Live", registration_start: "2026-09-08", registration_end: "2026-09-08" };
  assert.equal(availability(program, "America/Chicago", new Date("2026-09-08T04:00:00Z")).open, false);
  assert.equal(availability(program, "America/Chicago", new Date("2026-09-08T05:00:00Z")).open, true);
  assert.equal(availability(program, "America/Chicago", new Date("2026-09-09T04:59:59Z")).open, true);
  assert.equal(availability(program, "America/Chicago", new Date("2026-09-09T05:00:00Z")).open, false);
  for (const registration_status of ["Closed", "Coming Soon", "Sold Out"])
    assert.equal(availability({registration_status}, "UTC").open, false);
  assert.equal(availability({status: "Completed"}, "UTC").open, false);
  assert.equal(availability({status: "Live"}, "UTC").open, true);
});

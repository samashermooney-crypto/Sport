import test from "node:test";
import assert from "node:assert/strict";
import {
  parseScheduleCsv,
  gameScheduleHeaders,
  eventScheduleHeaders,
} from "./schedule-csv.mjs";
const game = gameScheduleHeaders.join(",");
const event = eventScheduleHeaders.join(",");
test("game template preserves quoted commas, multiline notes, escapes, BOM and source lines", () => {
  const parsed = parseScheduleCsv(
    "\uFEFF" +
      game +
      '\r\n,Team 1,Team 2,09/12/2026,09:00,10:00,"Park, East",,REGULAR_SEASON,"Bring \"\"blue\"\" jerseys\r\nand water"\r\n,Team 3,Team 4,09/13/2026,11:00,12:00,,,PLAYOFF,\r\n',
  );
  assert.equal(parsed.issue_count, 0);
  assert.equal(parsed.rows[0].notes, 'Bring "blue" jerseys\nand water');
  assert.equal(parsed.rows[0].location, "Park, East");
  assert.equal(parsed.rows[1].line, 4);
  assert.equal(parsed.rows[0].start_date, "2026-09-12");
});
test("event template keeps subtype, multi-day dates, descriptions and unknown end times", () => {
  const parsed = parseScheduleCsv(
    event +
      '\nU10,Training,PRACTICE,09/12/2026,9:00,,,Blue,Park,Field 1,Gate B,"<b>Bring water</b>"\n,Camp,CAMP,09/12/2026,09:00,09/14/2026,17:00,,,,,\n',
  );
  assert.equal(parsed.issue_count, 0);
  assert.equal(parsed.rows[0].activity_type, "PRACTICE");
  assert.equal(parsed.rows[0].end_time, null);
  assert.equal(parsed.rows[0].end_date, "2026-09-12");
  assert.equal(parsed.rows[0].location_note, "Gate B");
  assert.equal(parsed.rows[0].description, "<b>Bring water</b>");
  assert.equal(parsed.rows[1].end_date, "2026-09-14");
});
test("invalid spreadsheet dates, times, types and widths are reported without accepting partial import", () => {
  const parsed = parseScheduleCsv(
    game +
      "\n,A,B,02/30/2026,25:00,26:00,,,INVALID,\n,A,B,09/12/26,09:00,08:00,,,REGULAR_SEASON,\n,A,B,09/12/2026,09:00,08:00,,,REGULAR_SEASON,\nwrong,columns\n",
  );
  assert.equal(parsed.row_count, 4);
  assert.equal(parsed.rows.length, 0);
  assert.ok(parsed.issues.some((i) => i.column === "DATE" && i.line === 2));
  assert.ok(parsed.issues.some((i) => i.column === "START_TIME"));
  assert.ok(parsed.issues.some((i) => i.column === "TYPE"));
  assert.ok(parsed.issues.some((i) => i.column === "END_TIME" && i.line === 4));
  assert.ok(
    parsed.issues.some((i) => i.line === 5 && i.message.includes("columns")),
  );
});
test("ambiguous CSV and incompatible headers fail clearly", () => {
  for (const csv of [game + '\n"unclosed', game + '\n"a"x,b', game + '\na"b,c'])
    assert.throws(() => parseScheduleCsv(csv), /quote|quoted/);
  assert.throws(
    () =>
      parseScheduleCsv(
        "NAME,NAME,TYPE,START_DATE,START_TIME\nA,A,PRACTICE,09/12/2026,09:00",
      ),
    /duplicate/,
  );
  assert.throws(
    () => parseScheduleCsv("NAME,TYPE,START_DATE\nA,PRACTICE,09/12/2026"),
    /START_TIME/,
  );
  assert.throws(
    () => parseScheduleCsv(game + ",UNKNOWN\n" + ",".repeat(10)),
    /header|activity|Unrecognized/,
  );
  assert.throws(
    () => parseScheduleCsv("x".repeat(2 * 1024 * 1024 + 1)),
    /2 MB/,
  );
});
test("validation retains valid rows for mapping but reports all errors and never fabricates end times", () => {
  const parsed = parseScheduleCsv(
    game +
      "\n,A,B,09/12/2026,09:00,,,,REGULAR_SEASON,\n,A,,09/13/2026,10:00,11:00,,,PLAYOFF,\n",
  );
  assert.equal(parsed.row_count, 2);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].end_time, null);
  assert.equal(parsed.issue_count, 1);
  assert.equal(parsed.issues[0].column, "AWAY_TEAM");
});

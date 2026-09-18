import { DomainError } from "./domain.mjs";
import { scheduleImportInstant } from "./schedule-import-time.mjs";

export const gameScheduleHeaders = [
  "SUB_PROGRAM",
  "HOME_TEAM",
  "AWAY_TEAM",
  "DATE",
  "START_TIME",
  "END_TIME",
  "LOCATION",
  "SUB_LOCATION",
  "TYPE",
  "NOTES",
];
export const eventScheduleHeaders = [
  "SUB_PROGRAM",
  "NAME",
  "TYPE",
  "START_DATE",
  "START_TIME",
  "END_DATE",
  "END_TIME",
  "TEAM",
  "LOCATION",
  "SUB_LOCATION",
  "LOCATION_NOTE",
  "DESCRIPTION",
];
const required = {
  Game: ["HOME_TEAM", "AWAY_TEAM", "DATE", "START_TIME", "TYPE"],
  Event: ["NAME", "TYPE", "START_DATE", "START_TIME"],
};
const types = {
  Game: new Set([
    "REGULAR_SEASON",
    "PLAYOFF",
    "CHAMPIONSHIP",
    "TEAM_PRACTICE",
    "SCRIMMAGE",
    "QUARTERFINAL",
    "SEMIFINAL",
    "FINAL",
    "FRIENDLY",
    "TOURNAMENT",
    "POOL_PLAY",
  ]),
  Event: new Set([
    "GAME",
    "TOURNAMENT",
    "SCRIMMAGE",
    "PRACTICE",
    "MEETING",
    "CLASS",
    "CAMP",
    "LEAGUE",
    "TRAINING",
    "OTHER",
  ]),
};

// Preserve quoted commas, newlines and escaped quotes; retain source line numbers
// so validation messages point back to the spreadsheet rather than parsed indexes.
function readCsv(text) {
  const records = [];
  let values = [],
    cell = "",
    quoted = false,
    closedQuote = false,
    line = 1,
    recordLine = 1;
  function field() {
    values.push(cell);
    cell = "";
    closedQuote = false;
  }
  function record() {
    field();
    if (values.some((value) => value.trim() !== ""))
      records.push({ line: recordLine, values });
    values = [];
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (c === "\r" || c === "\n") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        cell += "\n";
        line++;
      } else cell += c;
      continue;
    }
    if (c === ",") field();
    else if (c === "\r" || c === "\n") {
      record();
      if (c === "\r" && text[i + 1] === "\n") i++;
      line++;
      recordLine = line;
    } else if (c === '"') {
      if (cell || closedQuote)
        throw new DomainError(
          `Line ${line}: unexpected quote in an unquoted CSV field.`,
        );
      quoted = true;
    } else if (closedQuote) {
      if (c !== " " && c !== "\t")
        throw new DomainError(
          `Line ${line}: expected a comma after a closing quote.`,
        );
    } else cell += c;
  }
  if (quoted)
    throw new DomainError(
      `Line ${recordLine}: quoted CSV field is not closed.`,
    );
  if (cell || values.length || closedQuote) record();
  return records;
}
function dateValue(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, m, d, y] = match,
    date = new Date(Date.UTC(+y, +m - 1, +d));
  if (
    +y < 1000 ||
    date.getUTCFullYear() !== +y ||
    date.getUTCMonth() !== +m - 1 ||
    date.getUTCDate() !== +d
  )
    return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}
function timeValue(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match && +match[1] < 24 && +match[2] < 60
    ? `${match[1].padStart(2, "0")}:${match[2]}`
    : null;
}
export function parseScheduleCsv(input, { timezone } = {}) {
  if (typeof input !== "string")
    throw new DomainError("Choose a CSV schedule file.");
  if (Buffer.byteLength(input, "utf8") > 2 * 1024 * 1024)
    throw new DomainError("The CSV file must be 2 MB or smaller.");
  const records = readCsv(input.replace(/^\uFEFF/, ""));
  if (records.length < 2)
    throw new DomainError(
      "The CSV file must contain a header and at least one activity.",
    );
  const headers = records
    .shift()
    .values.map((value) => value.trim().toUpperCase());
  if (new Set(headers).size !== headers.length)
    throw new DomainError("The CSV file contains duplicate column headers.");
  const kind =
    headers.includes("HOME_TEAM") || headers.includes("AWAY_TEAM")
      ? "Game"
      : "Event";
  const allowed = kind === "Game" ? gameScheduleHeaders : eventScheduleHeaders;
  const unknown = headers.filter((header) => !allowed.includes(header));
  const missing = required[kind].filter((header) => !headers.includes(header));
  if (unknown.length)
    throw new DomainError(
      `Unrecognized ${kind.toLowerCase()} schedule columns: ${unknown.join(", ")}.`,
    );
  if (missing.length)
    throw new DomainError(`Missing required columns: ${missing.join(", ")}.`);
  const rows = [],
    issues = [];
  let issueCount = 0;
  const issue = (line, column, message) => {
    issueCount++;
    if (issues.length < 200) issues.push({ line, column, message });
  };
  for (const record of records) {
    const before = issueCount;
    if (record.values.length !== headers.length) {
      issue(
        record.line,
        "",
        `Expected ${headers.length} columns but found ${record.values.length}. Quote text that contains commas.`,
      );
      continue;
    }
    const raw = Object.fromEntries(
      headers.map((header, index) => [header, record.values[index].trim()]),
    );
    for (const header of required[kind])
      if (!raw[header]) issue(record.line, header, "A value is required.");
    const startColumn = kind === "Game" ? "DATE" : "START_DATE";
    const startDate = dateValue(raw[startColumn]);
    const endDate = raw.END_DATE ? dateValue(raw.END_DATE) : startDate;
    const startTime = timeValue(raw.START_TIME);
    const endTime = raw.END_TIME ? timeValue(raw.END_TIME) : null;
    if (raw[startColumn] && !startDate)
      issue(
        record.line,
        startColumn,
        "Use a real date in MM/DD/YYYY format with a four-digit year.",
      );
    if (raw.END_DATE && !endDate)
      issue(
        record.line,
        "END_DATE",
        "Use a real date in MM/DD/YYYY format with a four-digit year.",
      );
    if (raw.START_TIME && !startTime)
      issue(record.line, "START_TIME", "Use 24-hour time in HH:MM format.");
    if (raw.END_TIME && !endTime)
      issue(record.line, "END_TIME", "Use 24-hour time in HH:MM format.");
    const activityType = (raw.TYPE || "").toUpperCase();
    if (raw.TYPE && !types[kind].has(activityType))
      issue(record.line, "TYPE", `Unsupported activity type: ${raw.TYPE}.`);
    if (startDate && endDate && endDate < startDate)
      issue(
        record.line,
        "END_DATE",
        "The end date cannot precede the start date.",
      );
    if (
      startDate &&
      endDate &&
      startTime &&
      endTime &&
      `${endDate}T${endTime}` <= `${startDate}T${startTime}`
    )
      issue(
        record.line,
        "END_TIME",
        "The end must be after the start; use END_DATE for multi-day events.",
      );
    if ((raw.NOTES || "").length > 500)
      issue(record.line, "NOTES", "Notes cannot exceed 500 characters.");
    if ((raw.DESCRIPTION || "").length > 10000)
      issue(record.line, "DESCRIPTION", "Description cannot exceed 10000 characters.");
    if ((raw.LOCATION_NOTE || "").length > 1000)
      issue(record.line, "LOCATION_NOTE", "Location note cannot exceed 1000 characters.");
    if ((raw.NAME || "").length > 150)
      issue(record.line, "NAME", "Activity name cannot exceed 150 characters.");
    let instants = {};
    if (issueCount === before && timezone) {
      for (const [key, date, time, column] of [
        ["start_at", startDate, startTime, "START_TIME"],
        ["end_at", endDate, endTime, "END_TIME"],
      ]) {
        try {
          instants[key] = time ? scheduleImportInstant(date, time, timezone) : "";
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          issue(record.line, column, error.message);
        }
      }
    }
    if (issueCount === before)
      rows.push({
        ...instants,
        line: record.line,
        kind,
        activity_type: activityType,
        sub_program: raw.SUB_PROGRAM || "",
        title: raw.NAME || "",
        home_team: raw.HOME_TEAM || raw.TEAM || "",
        away_team: raw.AWAY_TEAM || "",
        start_date: startDate,
        start_time: startTime,
        end_date: endDate,
        end_time: endTime,
        location: raw.LOCATION || "",
        sub_location: raw.SUB_LOCATION || "",
        location_note: raw.LOCATION_NOTE || "",
        notes: raw.NOTES || "",
        description: raw.DESCRIPTION || "",
      });
  }
  return {
    kind,
    headers,
    row_count: records.length,
    rows,
    issues,
    issue_count: issueCount,
  };
}

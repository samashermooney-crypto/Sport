import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, now, transaction, unpack } from "./db.mjs";

export const programTypes = [
  "League",
  "Event",
  "Tournament",
  "Camp",
  "Club team",
  "Class",
];
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const normalize = (value) => value.trim().toLowerCase();
const option = z.object({
  id: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(100),
});
const field = z.object({
  key: z.string(),
  label: z.string().trim().min(1).max(80),
  required_types: z.array(z.enum(programTypes)).default([]),
  enabled: z.boolean().default(true),
  options: z.array(option).max(300),
});
const keys = [
  "season",
  "level",
  "accounting_1",
  "accounting_2",
  "accounting_3",
  "accounting_4",
  "accounting_5",
];
export const terminologySchema = z
  .object({
    version: z.number().int().positive(),
    fields: z.array(field).length(7),
  })
  .superRefine((value, ctx) => {
    if (value.fields.some((f, i) => f.key !== keys[i]))
      ctx.addIssue({
        code: "custom",
        message:
          "Terminology fields must retain their original keys and order.",
      });
    for (const f of value.fields) {
      if (
        new Set(f.options.map((o) => normalize(o.label))).size !==
          f.options.length ||
        new Set(f.options.map((o) => o.id)).size !== f.options.length
      )
        ctx.addIssue({
          code: "custom",
          message: `${f.label} contains duplicate options.`,
        });
      if (
        ["season", "level"].includes(f.key) &&
        (!f.enabled || (f.required_types.length && !f.options.length))
      )
        ctx.addIssue({
          code: "custom",
          message: `${f.label} must be enabled and have an option when required.`,
        });
      if (f.key.startsWith("accounting_") && f.required_types.length)
        ctx.addIssue({
          code: "custom",
          message: "Accounting codes are optional.",
        });
    }
  });
function valuesFor(program, key) {
  return key === "season" || key === "level"
    ? program[key]
    : (program.accounting_codes || [])[Number(key.slice(-1)) - 1] || "";
}
function defaults(db, org) {
  const programs = db
    .prepare("SELECT * FROM programs WHERE org_id=?")
    .all(org)
    .map(unpack);
  const values = {
    season: ["Spring", "Summer", "Fall", "Winter", "Year-round"],
    level: [
      "Recreational",
      "Novice",
      "Intermediate",
      "Advanced",
      "Competitive",
      "All levels",
      "All",
    ],
  };
  return {
    version: 1,
    fields: keys.map((key, index) => {
      const options = [
        ...(values[key] || []),
        ...programs.map((p) => valuesFor(p, key)),
      ].filter(Boolean);
      const labels = [
        ...new Map(options.map((label) => [normalize(label), label])).values(),
      ];
      return {
        key,
        label:
          key === "season"
            ? "Season"
            : key === "level"
              ? "Level"
              : `Accounting Code ${index - 1}`,
        required_types: index < 2 ? [...programTypes] : [],
        enabled: index < 2,
        options: labels.map((label) => ({
          id: createHash("sha256")
            .update(key + normalize(label))
            .digest("hex")
            .slice(0, 24),
          label,
        })),
      };
    }),
  };
}
export function getTerminology(db, org) {
  if (!db.prepare("SELECT 1 FROM organizations WHERE id=?").get(org))
    throw fail("Organization not found", 404);
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope='site' AND key='terminology'",
    )
    .get(org);
  return row
    ? terminologySchema.parse(JSON.parse(row.value))
    : defaults(db, org);
}
export function saveTerminology(db, actor, input) {
  const next = terminologySchema.parse(input);
  return transaction(db, () => {
    const previous = getTerminology(db, actor.org_id);
    if (previous.version !== next.version)
      throw fail("Terminology changed. Reload before saving.", 409);
    const programs = db
      .prepare("SELECT * FROM programs WHERE org_id=?")
      .all(actor.org_id)
      .map(unpack);
    for (const field of previous.fields) {
      const removed = field.options.filter(
        (o) =>
          !next.fields
            .find((f) => f.key === field.key)
            .options.some((n) => n.id === o.id),
      );
      for (const option of removed)
        if (
          programs.some(
            (p) =>
              normalize(valuesFor(p, field.key)) === normalize(option.label),
          )
        )
          throw fail(
            `“${option.label}” is used by a program. Choose another value in those programs before removing it.`,
            409,
          );
    }
    let updatedPrograms = 0;
    for (const program of programs) {
      let changed = false;
      const codes = [...(program.accounting_codes || [])];
      for (const field of previous.fields) {
        const old = field.options.find(
          (o) =>
            normalize(o.label) === normalize(valuesFor(program, field.key)),
        );
        const renamed =
          old &&
          next.fields
            .find((f) => f.key === field.key)
            .options.find((o) => o.id === old.id);
        if (renamed && renamed.label !== valuesFor(program, field.key)) {
          if (field.key === "season" || field.key === "level")
            program[field.key] = renamed.label;
          else codes[Number(field.key.slice(-1)) - 1] = renamed.label;
          changed = true;
        }
      }
      if (changed) {
        const data = JSON.parse(
          db.prepare("SELECT data FROM programs WHERE id=?").get(program.id)
            .data,
        );
        db.prepare(
          "UPDATE programs SET season=?,level=?,data=?,updated_at=? WHERE id=? AND org_id=?",
        ).run(
          program.season,
          program.level,
          JSON.stringify({ ...data, accounting_codes: codes }),
          now(),
          program.id,
          actor.org_id,
        );
        updatedPrograms++;
      }
    }
    const saved = { ...next, version: next.version + 1 };
    db.prepare(
      "INSERT INTO settings VALUES(?,'site','terminology',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(actor.org_id, JSON.stringify(saved));
    audit(db, actor, "terminology.updated", "settings", "terminology", {
      version: saved.version,
      updated_programs: updatedPrograms,
    });
    return saved;
  });
}
export function validateProgramTerminology(db, org, program) {
  const settings = getTerminology(db, org);
  if (
    program.terminology_version !== undefined &&
    program.terminology_version !== settings.version
  )
    throw fail(
      "Terminology changed. Reload the program editor before saving.",
      409,
    );
  for (const f of settings.fields) {
    if (!f.enabled) continue;
    const value = valuesFor(program, f.key);
    if (!value && f.required_types.includes(program.type))
      throw fail(`${f.label} is required for ${program.type} programs.`);
    if (
      value &&
      !f.options.some((o) => normalize(o.label) === normalize(value))
    )
      throw fail(`Choose an available ${f.label} option.`);
  }
}
export function installTerminologyRoutes(app, db) {
  app.get("/api/terminology", (req, res) =>
    res.json(getTerminology(db, req.actor.org_id)),
  );
  app.put("/api/terminology", (req, res) =>
    res.json(saveTerminology(db, req.actor, req.body)),
  );
}

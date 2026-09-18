import { z } from "zod";
import { audit, transaction } from "./db.mjs";
const keys = [
  "code",
  "start_date",
  "registration_start",
  "registration_end",
  "invoiced",
  "paid",
  "outstanding",
  "paid_invoices",
  "partial_invoices",
  "unpaid_invoices",
  "overdue",
  "players",
  "capacity",
  "free_agents",
  "staff",
  "teams",
  "status",
  "type",
  "sport",
];
const defaults = [
  "paid",
  "outstanding",
  "players",
  "free_agents",
  "staff",
  "teams",
];
const schema = z.object({
  version: z.number().int().positive(),
  columns: z.array(z.enum(keys)).max(keys.length),
});
export function summaryView(db, actor) {
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope=? AND key='program-summary-columns'",
    )
    .get(actor.org_id, "user:" + actor.id);
  return row ? JSON.parse(row.value) : { version: 1, columns: defaults };
}
export function saveSummaryView(db, actor, input) {
  const value = schema.parse(input);
  return transaction(db, () => {
    if (summaryView(db, actor).version !== value.version)
      throw Object.assign(
        new Error("Column choices changed. Reload before saving."),
        { status: 409 },
      );
    const next = {
      version: value.version + 1,
      columns: [...new Set(value.columns)],
    };
    db.prepare(
      "INSERT INTO settings(org_id,scope,key,value) VALUES(?,?,'program-summary-columns',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(actor.org_id, "user:" + actor.id, JSON.stringify(next));
    audit(db, actor, "update", "report-view", "program-summary", next);
    return next;
  });
}
export function installProgramSummaryRoutes(app, db) {
  app.get("/api/reports/program-summary/view", (req, res) =>
    res.json(summaryView(db, req.actor)),
  );
  app.put("/api/reports/program-summary/view", (req, res) =>
    res.json(saveSummaryView(db, req.actor, req.body)),
  );
}

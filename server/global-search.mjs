export function searchRecords(db, actor, input) {
  const query = typeof input === "string" ? input.trim().slice(0, 150) : "";
  if (query.length < 2) return { results: [] };
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const programs = db.prepare("SELECT id,name,type,season FROM programs WHERE org_id=? AND archived_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name,id LIMIT 8").all(actor.org_id, pattern)
    .map((p) => ({ kind: "Program", id: p.id, label: p.name, detail: [p.type, p.season].filter(Boolean).join(" · "), path: `/programs/${p.id}` }));
  const members = db.prepare("SELECT id,first_name,last_name,email FROM people WHERE org_id=? AND json_extract(data,'$.archived_at') IS NULL AND (first_name || ' ' || last_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY last_name,first_name,id LIMIT 8").all(actor.org_id, pattern, pattern)
    .map((p) => ({ kind: "Member", id: p.id, label: `${p.first_name} ${p.last_name}`.trim(), detail: p.email || "", path: `/members/${p.id}` }));
  const invoicePattern = `%${query.replace(/^#/, "").replace(/[\\%_]/g, "\\$&")}%`;
  const invoices = db.prepare("SELECT i.id,i.number,i.description,p.first_name,p.last_name FROM invoices i JOIN people p ON p.id=i.person_id AND p.org_id=i.org_id WHERE i.org_id=? AND (CAST(i.number AS TEXT) LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\') ORDER BY i.number DESC LIMIT 8").all(actor.org_id, invoicePattern, pattern)
    .map((i) => ({ kind: "Invoice", id: i.id, label: `Invoice #${i.number}`, detail: `${i.first_name} ${i.last_name} · ${i.description}`, path: `/invoices/${i.id}` }));
  return { results: [...programs, ...members, ...invoices] };
}
export function installGlobalSearchRoutes(app, db) {
  app.get("/api/search", (req, res) => res.json(searchRecords(db, req.actor, req.query.q)));
}

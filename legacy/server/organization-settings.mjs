import { z } from "zod";
import { audit, transaction } from "./db.mjs";
import { DomainError } from "./domain.mjs";
const schema = z.object({ name: z.string().trim().min(1).max(150), timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", {timeZone:value}); return true; } catch { return false; } }, "Choose a valid time zone"), previous: z.object({name:z.string(),timezone:z.string()}) });
export function saveOrganization(db, actor, input) {
  if (!["owner","admin"].includes(actor.role)) throw new DomainError("Only owners and administrators can change organization settings",403);
  const value = schema.parse(input);
  return transaction(db, () => {
    const current = db.prepare("SELECT id,name,timezone,currency FROM organizations WHERE id=?").get(actor.org_id);
    if (!current) throw new DomainError("Organization not found",404);
    if (current.name !== value.previous.name || current.timezone !== value.previous.timezone) throw new DomainError("Settings changed since you opened this page. Reload before saving.",409);
    db.prepare("UPDATE organizations SET name=?,timezone=? WHERE id=?").run(value.name,value.timezone,actor.org_id);
    audit(db,actor,"update","organization",actor.org_id,{previous:{name:current.name,timezone:current.timezone},name:value.name,timezone:value.timezone});
    return {...current,name:value.name,timezone:value.timezone};
  });
}
export function installOrganizationSettings(app,db) {
  app.get("/api/organization-settings",(req,res)=>res.json(db.prepare("SELECT id,name,timezone,currency FROM organizations WHERE id=?").get(req.actor.org_id)));
  app.put("/api/organization-settings",(req,res)=>res.json(saveOrganization(db,req.actor,req.body)));
}

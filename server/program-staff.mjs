import { listRegistrations } from './registration-list.mjs';
import { isStaffRole } from './staff-roles.mjs';
import { requireEntity } from './domain.mjs';
export function listProgramStaff(db, actor, programId) {
  requireEntity(db, 'programs', programId, actor.org_id);
  const people = new Set(db.prepare("SELECT id FROM people WHERE org_id=? AND json_extract(data,'$.archived_at') IS NULL").all(actor.org_id).map(p=>p.id));
  const teams = new Map(db.prepare("SELECT id,name,json_extract(data,'$.primary_staff_person_id') primary_person FROM teams WHERE org_id=? AND program_id=? AND json_extract(data,'$.archived_at') IS NULL").all(actor.org_id,programId).map(t=>[t.id,t]));
  const rows = new Map();
  const allowed = role => role !== 'Captain' && isStaffRole(role);
  for (const r of listRegistrations(db, actor.org_id, programId)) {
    if (!allowed(r.role) || r.status === 'Canceled' || !people.has(r.person_id) || (r.team_id && !teams.has(r.team_id))) continue;
    rows.set(`${r.person_id}:${r.team_id || ''}`, {...r,registration_id:r.id,is_primary:r.status==='Confirmed' && teams.get(r.team_id)?.primary_person===r.person_id});
  }
  for (const s of db.prepare(`SELECT s.*,p.first_name,p.last_name,p.email,p.gender FROM team_staff s
    JOIN people p ON p.id=s.person_id AND p.org_id=s.org_id
    JOIN teams t ON t.id=s.team_id AND t.org_id=s.org_id
    WHERE s.org_id=? AND t.program_id=?`).all(actor.org_id,programId)) {
    if (!allowed(s.role) || !people.has(s.person_id) || !teams.has(s.team_id)) continue;
    const key=`${s.person_id}:${s.team_id}`, previous=rows.get(key);
    rows.set(key,{...previous,id:previous?.id || s.id,registration_id:previous?.registration_id || null,person_id:s.person_id,
      first_name:s.first_name,last_name:s.last_name,email:s.email,gender:s.gender,role:s.role,team_id:s.team_id,team_name:teams.get(s.team_id).name,
      created_at:previous?.created_at || s.created_at,status:'Confirmed',invoice_id:previous?.invoice_id || null,
      invoice_number:previous?.invoice_number || null,paid_cents:previous?.paid_cents ?? null,total_cents:previous?.total_cents ?? null,
      waiver_accepted_at:previous?.waiver_accepted_at || null,is_primary:teams.get(s.team_id).primary_person===s.person_id});
  }
  return [...rows.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at));
}
export function installProgramStaffRoutes(app,db) {
  app.get('/api/programs/:id/staff',(req,res)=>res.json(listProgramStaff(db,req.actor,req.params.id)));
}

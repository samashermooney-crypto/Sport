import { z } from 'zod';
import { DomainError, requireEntity } from './domain.mjs';
import { unpack } from './db.mjs';
import { memberFamily } from './member-auth.mjs';
import { isStaffRole } from './staff-roles.mjs';

export const rosterAudience = z.enum(['Public', 'Logged in users', 'Team Members', 'Staff Only', 'Primary Staff Only']);
export const websiteRosterSchema = z.object({
  parent_contacts: z.boolean().default(false),
  staff_fields: z.array(z.object({key:z.enum(['name','email','phone']),visibility:rosterAudience})).max(3)
    .refine(fields=>new Set(fields.map(f=>f.key)).size===fields.length,'Choose each staff field only once').default([]),
  audience: rosterAudience.default('Team Members'),
  fields: z.array(z.object({
    key: z.enum(['name', 'gender', 'birthdate', 'email', 'phone', 'address', 'member_id', 'invoice', 'balance', 'due_date']),
    visibility: rosterAudience,
  })).max(10).refine(fields => new Set(fields.map(f => f.key)).size === fields.length, 'Choose each roster field only once'),
});

export function canViewWebsiteRoster(db, org, teamId, account) {
  try { return websiteTeamRoster(db, org, teamId, account, true); }
  catch (error) {
    if (error instanceof DomainError && error.status === 404) return false;
    throw error;
  }
}

export function websiteTeamRoster(db, org, teamId, account = null, accessOnly = false) {
  const team = unpack(requireEntity(db, 'teams', teamId, org));
  const program = unpack(requireEntity(db, 'programs', team.program_id, org));
  if (team.archived_at || program.archived_at || !program.public || program.status === 'Unpublished')
    throw new DomainError('Team roster not found', 404);
  if (program.parent_id) {
    const parent = unpack(requireEntity(db, 'programs', program.parent_id, org));
    if (parent.archived_at || !parent.public || parent.status === 'Unpublished')
      throw new DomainError('Team roster not found', 404);
  }
  const saved = db.prepare("SELECT value FROM settings WHERE org_id=? AND scope=? AND key='roster'").get(org, 'program:' + program.id);
  const config = saved && JSON.parse(saved.value).website;
  if (!config) throw new DomainError('Team roster not found', 404);
  const settings = websiteRosterSchema.parse(config);
  const viewer = account?.org_id === org && account.person_id
    ? unpack(requireEntity(db, 'people', account.person_id, org)) : null;
  const loggedIn = !!viewer && !viewer.archived_at;
  const assignments = loggedIn ? db.prepare(`SELECT role FROM team_staff WHERE org_id=? AND team_id=? AND person_id=?
    UNION SELECT role FROM registrations WHERE org_id=? AND team_id=? AND person_id=? AND status='Confirmed'`)
    .all(org, teamId, viewer.id, org, teamId, viewer.id) : [];
  const staff = assignments.some(a => isStaffRole(a.role) && a.role !== 'Captain');
  const primary = staff && team.primary_staff_person_id === viewer?.id;
  const familyIds = loggedIn ? memberFamily(db, account).filter(p => p.self || p.household_role === 'Member').map(p => p.id) : [];
  const familyMember = loggedIn && !!db.prepare(`SELECT 1 FROM registrations WHERE org_id=? AND team_id=? AND status='Confirmed'
    AND person_id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(org, teamId, JSON.stringify([viewer.id, ...familyIds]));
  const allowed = audience => audience === 'Public' || (audience === 'Logged in users' && loggedIn)
    || (audience === 'Team Members' && (assignments.length > 0 || familyMember))
    || (audience === 'Staff Only' && staff) || (audience === 'Primary Staff Only' && primary);
  if (!allowed(settings.audience)) throw new DomainError('Team roster not found', 404);
  if (accessOnly) return true;
  const fields = settings.fields.filter(f => allowed(f.visibility)).map(f => f.key);
  const staffFields=settings.staff_fields.filter(f=>allowed(f.visibility)).map(f=>f.key);
  const staffPeople=staffFields.length ? db.prepare(`SELECT p.*,s.role FROM team_staff s JOIN people p ON p.id=s.person_id AND p.org_id=s.org_id
    WHERE s.org_id=? AND s.team_id=? UNION SELECT p.*,r.role FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id
    WHERE r.org_id=? AND r.team_id=? AND r.status='Confirmed' ORDER BY last_name,first_name`)
    .all(org,teamId,org,teamId).map(unpack).filter(p=>!p.archived_at && isStaffRole(p.role)) : [];
  const staffRows=[...new Map(staffPeople.map(p=>[p.id,p])).values()].map(p=>Object.fromEntries(staffFields.map(key=>[key,key==='name'?`${p.first_name} ${p.last_name}`:p[key]||''])));
  const players = db.prepare(`SELECT p.* FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id
    WHERE r.org_id=? AND r.team_id=? AND r.status='Confirmed' AND r.role IN ('Free Agent','Team Player') ORDER BY p.last_name,p.first_name`)
    .all(org, teamId).map(unpack).filter(p => !p.archived_at);
  const financial = new Map();
  if (fields.some(key => ['invoice','balance','due_date'].includes(key))) {
    const currency=db.prepare('SELECT currency FROM organizations WHERE id=?').get(org).currency;
    const money=new Intl.NumberFormat('en-US',{style:'currency',currency});
    for (const invoice of db.prepare(`SELECT r.person_id,i.total_cents,i.paid_cents,i.due_date FROM registrations r
      JOIN invoices i ON i.id=r.invoice_id AND i.org_id=r.org_id AND i.voided=0
      WHERE r.org_id=? AND r.team_id=? AND r.status='Confirmed'`).all(org,teamId)) {
      financial.set(invoice.person_id,{invoice:money.format(invoice.total_cents/100),balance:money.format((invoice.total_cents-invoice.paid_cents)/100),due_date:invoice.due_date});
    }
  }
  const contactFields = ['email', 'phone', 'address'];
  const parents = new Map();
  if (settings.parent_contacts && fields.some(key => contactFields.includes(key))) {
    for (const row of db.prepare(`SELECT child.person_id child_id,p.* FROM household_members child
      JOIN households h ON h.id=child.household_id AND h.org_id=?
      JOIN household_members parent ON parent.household_id=h.id AND parent.role='Supervisor'
      JOIN people p ON p.id=parent.person_id AND p.org_id=h.org_id
      WHERE child.role='Member' AND child.person_id IN (SELECT value FROM json_each(?))
      ORDER BY p.last_name,p.first_name,p.id`).all(org,JSON.stringify(players.map(p=>p.id)))) {
      const person=unpack(row);
      if (person.archived_at) continue;
      const contacts=parents.get(row.child_id)||[];
      if (!contacts.some(p=>p.id===person.id)) contacts.push(person);
      parents.set(row.child_id,contacts);
    }
  }
  const value=(person,key)=>key==='address' ? [person.address,person.city,person.state,person.postal_code].filter(Boolean).join(', ') : person[key]||'';
  return {team_name: team.name, fields, staff_fields:staffFields, staff_rows:staffRows, rows: fields.length ? players.map(p => Object.fromEntries(fields.map(key => {
    const contacts=settings.parent_contacts && contactFields.includes(key) ? parents.get(p.id) : null;
    return [key, ['invoice','balance','due_date'].includes(key) ? financial.get(p.id)?.[key] || '' : key==='name' ? `${p.first_name} ${p.last_name}` : key==='member_id' ? p.id
      : contacts?.length ? [...new Set(contacts.map(person=>value(person,key)).filter(Boolean))].join('; ') : value(p,key)];
  }))) : []};
}

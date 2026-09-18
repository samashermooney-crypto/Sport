import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from './db.mjs';
import {savePerson} from './directory.mjs';
import {saveProgram,createTeam,register} from './domain.mjs';
import {assignStaff,setPrimaryStaff} from './teams.mjs';
import {websiteTeamRoster} from './roster-visibility.mjs';
import {makeApp} from './app.mjs';
import {memberTeams} from './team-permissions.mjs';
import {beginMemberSignup,verifyMemberSignup} from './member-auth.mjs';

test('website roster omits restricted fields and honors the current primary assignment', async () => {
  const db=openDb(':memory:');
  db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club')").run();
  const actor={id:'admin',org_id:'org'};
  const program=saveProgram(db,actor,{name:'League',type:'League',sport:'Soccer',gender:'Co-Ed',level:'All',season:'Fall',start_date:'2026-10-01',fee_cents:0,capacity:10,public:true});
  const team=createTeam(db,actor,{name:'Team',program_id:program.id});
  const player=savePerson(db,actor,{first_name:'Player',last_name:'Example',email:'player@example.com',address:'10 Example Lane',city:'Example City',state:'LA',postal_code:'70000'});
  const coach=savePerson(db,actor,{first_name:'Coach',last_name:'Example'});
  const other=savePerson(db,actor,{first_name:'Other',last_name:'Coach'});
  register(db,actor,{person_id:player.id,program_id:program.id,team_id:team.id});
  assignStaff(db,actor,team.id,{person_id:coach.id,role:'Coach'});
  assignStaff(db,actor,team.id,{person_id:other.id,role:'Volunteer'});
  setPrimaryStaff(db,actor,team.id,{person_id:coach.id});
  const settings={website:{audience:'Public',fields:[{key:'name',visibility:'Public'},{key:'email',visibility:'Primary Staff Only'},{key:'address',visibility:'Primary Staff Only'}]}};
  db.prepare("INSERT INTO settings VALUES(?,?,'roster',?)").run('org','program:'+program.id,JSON.stringify(settings));
  const read=person_id=>websiteTeamRoster(db,'org',team.id,person_id ? {org_id:'org',person_id} : null);
  assert.deepEqual(read().rows,[{name:'Player Example'}]);
  assert.equal(read(coach.id).rows[0].email,'player@example.com');
  assert.equal(read(coach.id).rows[0].address,'10 Example Lane, Example City, LA, 70000');
  assert.equal('address' in read().rows[0],false);
  db.prepare("INSERT INTO invoices(id,number,org_id,program_id,person_id,description,total_cents,paid_cents,due_date,created_at) VALUES('roster-invoice',9999,'org',?,?,'Test invoice',12000,3000,'2026-10-01','2026-09-08')").run(program.id,player.id);
  db.prepare("UPDATE registrations SET invoice_id='roster-invoice' WHERE person_id=?").run(player.id);
  settings.website.fields.push(...['invoice','balance','due_date'].map(key=>({key,visibility:'Primary Staff Only'})));
  db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
  assert.equal(read(coach.id).rows[0].invoice,'$120.00');
  assert.equal(read(coach.id).rows[0].balance,'$90.00');
  assert.equal(read(coach.id).rows[0].due_date,'2026-10-01');
  assert.equal('balance' in read().rows[0],false);
  db.prepare("UPDATE invoices SET voided=1 WHERE id='roster-invoice'").run();
  assert.equal(read(coach.id).rows[0].balance,'');
  db.prepare("UPDATE invoices SET voided=0 WHERE id='roster-invoice'").run();
  settings.website.staff_fields=[{key:'name',visibility:'Public'},{key:'email',visibility:'Primary Staff Only'}];
  db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
  assert.equal(read().staff_rows.length,2);
  assert.deepEqual(read().staff_fields,['name']);
  assert.equal(read().staff_rows.some(row=>'email' in row),false);
  assert.deepEqual(read(coach.id).staff_fields,['name','email']);
  const staffRegistration=register(db,actor,{person_id:coach.id,program_id:program.id,team_id:team.id,role:'Coach'});
  assert.equal(read().staff_rows.length,2,'direct and registered staff must be deduplicated');
  db.prepare("DELETE FROM team_staff WHERE person_id=? AND team_id=?").run(coach.id,team.id);
  assert.equal(read().staff_rows.length,2,'confirmed staff registration remains visible');
  db.prepare("UPDATE registrations SET status='Pending' WHERE id=?").run(staffRegistration.id);
  assert.equal(read().staff_rows.length,1,'pending staff must not appear on the website');
  db.prepare("UPDATE registrations SET status='Confirmed' WHERE id=?").run(staffRegistration.id);
  setPrimaryStaff(db,actor,team.id,{person_id:coach.id});
  assert.equal('email' in read(other.id).rows[0],false);
  setPrimaryStaff(db,actor,team.id,{person_id:other.id});
  assert.equal('email' in read(coach.id).rows[0],false);
  assert.equal(read(other.id).rows[0].email,'player@example.com');
  settings.website.audience='Primary Staff Only';
  db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
  assert.throws(()=>read(),/not found/);
  assert.throws(()=>read(coach.id),/not found/);
  assert.equal(read(other.id).rows.length,1);
  assert.equal(memberTeams(db,{org_id:'org',person_id:other.id}).find(t=>t.id===team.id).can_view_roster,true);
  assert.equal(memberTeams(db,{org_id:'org',person_id:coach.id}).find(t=>t.id===team.id).can_view_roster,false);
  const outsider=savePerson(db,actor,{first_name:'Unrelated',last_name:'Member'});
  const captain=savePerson(db,actor,{first_name:'Captain',last_name:'Example'});
  assignStaff(db,actor,team.id,{person_id:captain.id,role:'Captain'});
  for (const [audience, permitted] of [
    ['Public',[true,true,true,true,true]],
    ['Logged in users',[false,true,true,true,true]],
    ['Team Members',[false,false,true,true,true]],
    ['Staff Only',[false,false,false,false,true]],
    ['Primary Staff Only',[false,false,false,false,true]],
  ]) {
    settings.website.audience=audience;
    db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
    [null,outsider.id,player.id,captain.id,other.id].forEach((viewer,i)=>{
      if(permitted[i]) assert.equal(read(viewer).rows.length,1,`${audience}: ${viewer}`);
      else assert.throws(()=>read(viewer),/not found/,`${audience}: ${viewer}`);
    });
  }
  settings.website.audience='Team Members';
  db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
  db.prepare("INSERT INTO households VALUES('family','org','Family')").run();
  db.prepare("INSERT INTO household_members VALUES('family',?,'Supervisor')").run(outsider.id);
  db.prepare("INSERT INTO household_members VALUES('family',?,'Member')").run(player.id);
  assert.equal(read(outsider.id).rows.length,1,'guardian sees registered child team');
  assert.equal('email' in read(outsider.id).rows[0],false,'guardian does not inherit primary staff access');
  db.prepare("UPDATE people SET email='guardian@example.com' WHERE id=?").run(outsider.id);
  settings.website.parent_contacts=true;
  db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
  assert.equal(read(other.id).rows[0].email,'guardian@example.com');
  assert.equal('email' in read(outsider.id).rows[0],false,'parent substitution must preserve field visibility');
  assert.equal(read(other.id).rows[0].name,'Player Example','player identity must remain unchanged');
  settings.website.parent_contacts=false;
  db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
  assert.equal(read(other.id).rows[0].email,'player@example.com');
  db.prepare("UPDATE registrations SET status='Pending' WHERE person_id=?").run(player.id);
  assert.throws(()=>read(player.id),/not found/);
  assert.throws(()=>read(outsider.id),/not found/);
  assert.equal(read(other.id).rows.length,0,'pending players are omitted');
  db.prepare("UPDATE registrations SET status='Confirmed' WHERE person_id=?").run(player.id);
  assert.throws(()=>websiteTeamRoster(db,'org',team.id,{org_id:'foreign',person_id:other.id}),/not found/);
  db.prepare("UPDATE people SET data=json_set(data,'$.archived_at','2026-09-08') WHERE id=?").run(other.id);
  assert.throws(()=>read(other.id),/not found/);
  db.prepare("UPDATE programs SET public=0 WHERE id=?").run(program.id);
  assert.throws(()=>read(player.id),/not found/);
  db.prepare("UPDATE programs SET public=1 WHERE id=?").run(program.id);
  settings.website.audience='Logged in users';
  db.prepare("UPDATE settings SET value=? WHERE key='roster'").run(JSON.stringify(settings));
  const app=makeApp(db);
  const signup={email:'http-viewer@example.com',password:'Example password 2026!',first_name:'HTTP',last_name:'Viewer',birthdate:'1980-01-01'};
  verifyMemberSignup(db,'org',beginMemberSignup(db,'org',signup).token);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const root=`http://127.0.0.1:${server.address().port}/api`;
  const path=`/public/sites/org/teams/${team.id}/roster`;
  try {
    const anonymous=await fetch(root+path);
    assert.equal(anonymous.status,404);
    assert.equal(anonymous.headers.get('cache-control'),'no-store');
    const login=await fetch(root+'/member/org/login',{method:'POST',headers:{'content-type':'application/json','X-Fieldhouse-Request':'1'},body:JSON.stringify(signup)});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(root+path,{headers:{cookie}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual((await response.json()).rows,[{name:'Player Example'}]);
    assert.equal((await fetch(root+'/teams/'+team.id,{headers:{cookie}})).status,401,'member cookie must not grant console access');
    assert.equal((await fetch(root+path,{headers:{cookie:'fieldhouse_member=invalid'}})).status,404);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
  db.close();
});

test('grouped program roster follows parent publication and archive state', () => {
  const db=openDb(':memory:');
  db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club')").run();
  const actor={id:'admin',org_id:'org'};
  const base={type:'League',sport:'Soccer',gender:'Co-Ed',level:'All',season:'Fall',start_date:'2026-10-01',fee_cents:0,capacity:10,public:true};
  const parent=saveProgram(db,actor,{...base,name:'Parent',grouped:true});
  const child=saveProgram(db,actor,{...base,name:'Child',parent_id:parent.id});
  const team=createTeam(db,actor,{name:'Child Team',program_id:child.id});
  db.prepare("INSERT INTO settings VALUES(?,?,'roster',?)").run('org','program:'+child.id,JSON.stringify({website:{audience:'Public',fields:[{key:'name',visibility:'Public'}]}}));
  const read=()=>websiteTeamRoster(db,'org',team.id);
  assert.equal(read().team_name,'Child Team');
  for (const mutation of ["public=0", "status='Unpublished'", "archived_at='2026-09-08'"]) {
    db.prepare(`UPDATE programs SET ${mutation} WHERE id=?`).run(parent.id);
    assert.throws(read,/not found/,mutation);
    db.prepare("UPDATE programs SET public=1,status='Upcoming',archived_at=NULL WHERE id=?").run(parent.id);
    assert.equal(read().team_name,'Child Team');
  }
  db.prepare("UPDATE teams SET data=json_set(data,'$.archived_at','2026-09-08') WHERE id=?").run(team.id);
  assert.throws(read,/not found/);
  db.close();
});

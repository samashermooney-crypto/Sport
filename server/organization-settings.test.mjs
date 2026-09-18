import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { saveOrganization } from "./organization-settings.mjs";
test("organization edits enforce role, scope, valid zones and stale-write protection",()=>{
 const db=openDb(":memory:");
 try{
 db.exec("INSERT INTO organizations(id,name) VALUES('one','First'),('two','Second')");
 const actor={org_id:'one',role:'owner'}, value={name:'Updated',timezone:'America/New_York',previous:{name:'First',timezone:'America/Chicago'}};
 assert.throws(()=>saveOrganization(db,{...actor,role:'manager'},value),/Only owners/);
 assert.throws(()=>saveOrganization(db,actor,{...value,timezone:'Invalid/Zone'}),/valid time zone/);
 saveOrganization(db,actor,value);
 assert.equal(db.prepare("SELECT name FROM organizations WHERE id='two'").get().name,'Second');
 assert.equal(db.prepare("SELECT timezone FROM organizations WHERE id='one'").get().timezone,'America/New_York');
 assert.throws(()=>saveOrganization(db,actor,{...value,name:'Stale'}),/changed since/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log").get().n,1);
 }finally{db.close();}
});

test("organization settings HTTP routes enforce session roles and retain newer edits", async () => {
 const {makeApp}=await import("./app.mjs");
 const {createHash}=await import("node:crypto");
 const db=openDb(":memory:");
 db.exec("INSERT INTO organizations(id,name) VALUES('one','First'),('two','Second')");
 for(const role of ['owner','manager','reporter']) {
  db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(role,'one',role,`${role}@example.com`,'unused',role);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(createHash('sha256').update(role).digest('hex'),role,'2099-01-01');
 }
 const server=makeApp(db).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const request=(role,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}/api/organization-settings`,{method,headers:{'Content-Type':'application/json','X-Fieldhouse-Request':'1',cookie:`fieldhouse_session=${role}`},body:body?JSON.stringify(body):undefined});
 try {
  assert.equal((await request('missing')).status,401);
  const initial=await (await request('reporter')).json();
  assert.equal(initial.name,'First');
  const change={name:'Revised',timezone:'America/Denver',previous:{name:initial.name,timezone:initial.timezone}};
  for(const role of ['manager','reporter']) assert.equal((await request(role,'PUT',change)).status,403);
  assert.equal((await request('owner','PUT',change)).status,200);
  assert.equal((await request('owner','PUT',{...change,name:'Stale'})).status,409);
  assert.equal((await (await request('owner')).json()).name,'Revised');
  assert.equal(db.prepare("SELECT name FROM organizations WHERE id='two'").get().name,'Second');
 } finally {await new Promise(resolve=>server.close(resolve));db.close();}
});

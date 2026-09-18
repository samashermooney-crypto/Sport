import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProgram, register } from "./domain.mjs";

test("HTTP cancellation enforces authorization and persists unpaid invoice voiding", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club')").run();
  for (const role of ["owner", "reporter"])
    db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(role, "org", role, `${role}@example.com`, passwordHash("test-password"), role);
  const p = saveProgram(db, { id: "owner", org_id: "org" }, { name: "Import League", type: "League", sport: "Soccer", gender: "Co-Ed", level: "All", season: "Fall", start_date: "2026-09-12", fee_cents: 10000, capacity: 100 });
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, cookie = "", origin = base) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Fieldhouse-Request": "1", Cookie: cookie, Origin: origin }, body: JSON.stringify(body),
  });
  try {
    const login = async (role) => {
      const response = await request("/api/auth/login", { email: `${role}@example.com`, password: "test-password" });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const owner = await login("owner"), reporter = await login("reporter");
    db.prepare("INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES('person','org','Test','Player','2026-09-09')").run();
    const registration = register(db, {id:"owner",org_id:"org"}, {program_id:p.id,person_id:"person"});
    const endpoint = `/api/registrations/${registration.id}/cancel`;
    const previewUrl = base + `/api/registrations/${registration.id}/cancellation`;
    assert.equal((await fetch(previewUrl)).status, 401);
    const response = await fetch(previewUrl, {headers:{Cookie:owner}});
    assert.equal(response.status,200);
    const preview = await response.json();
    assert.equal(preview.can_void_invoice,true);
    const body={revision:preview.revision,invoice_action:"void_unpaid",reason:"Requested cancellation"};
    assert.equal((await request(endpoint,body)).status,401);
    assert.equal((await request(endpoint,body,reporter)).status,403);
    assert.equal((await request(endpoint,body,owner,"https://foreign.example")).status,403);
    assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(registration.id).status,"Pending");
    assert.equal((await request(endpoint,body,owner)).status,200);
    assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(registration.id).status,"Canceled");
    assert.equal(db.prepare("SELECT voided FROM invoices WHERE id=?").get(registration.invoice_id).voided,1);
    assert.equal((await request(endpoint,body,owner)).status,200);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='cancel_registration'").get().n,1);

    const actor={id:"owner",org_id:"org"};
    const source=register(db,actor,{program_id:p.id,person_id:"person"});
    const target=saveProgram(db,actor,{name:"Transfer destination",type:"League",sport:"Soccer",gender:"Co-Ed",level:"All",season:"Fall",start_date:"2026-09-12",fee_cents:15000,capacity:100});
    const current=await (await fetch(base+`/api/registrations/${source.id}/cancellation`,{headers:{Cookie:owner}})).json();
    const transfer={request_key:randomUUID(),revision:current.revision,invoice_action:"void_unpaid",reason:"Requested transfer",destination:{program_id:target.id}};
    const transferPath=`/api/registrations/${source.id}/transfer`;
    assert.equal((await request(transferPath+"/preview",transfer)).status,401);
    assert.equal((await request(transferPath+"/preview",transfer,reporter)).status,403);
    const quoteResponse=await request(transferPath+"/preview",transfer,owner);
    assert.equal(quoteResponse.status,200);
    const quote=await quoteResponse.json();
    assert.equal(quote.outcome.total_cents,15000);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registration_transfers").get().n,0);
    assert.equal((await request(transferPath,transfer,owner)).status,400,"confirmation requires reviewed outcome");
    const confirmed={...transfer,expected_outcome:quote.outcome};
    assert.equal((await request(transferPath,confirmed,reporter)).status,403);
    assert.equal((await request(transferPath,confirmed,owner,"https://foreign.example")).status,403);
    db.prepare("UPDATE programs SET fee_cents=16000 WHERE id=?").run(target.id);
    const rejected=await request(transferPath,confirmed,owner);
    assert.equal(rejected.status,409);
    assert.equal((await rejected.json()).transfer_not_saved,true);
    assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(source.id).status,"Pending");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registration_transfers").get().n,0);
    db.prepare("UPDATE programs SET fee_cents=15000 WHERE id=?").run(target.id);
    const accepted=await request(transferPath,confirmed,owner);
    assert.equal(accepted.status,200);
    const saved=await accepted.json();
    assert.equal(saved.destination.program_id,target.id);
    assert.deepEqual(await (await request(transferPath,confirmed,owner)).json(),saved);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registration_transfers").get().n,1);

  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

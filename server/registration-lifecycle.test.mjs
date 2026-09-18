import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now } from "./db.mjs";
import {
  saveProgram,
  createTeam,
  register,
  recordPayment,
  saveEvent,
  programStats,
} from "./domain.mjs";
function fixture() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(
    "org",
    "Test club",
  );
  const actor = { id: "admin", org_id: "org" };
  const p = saveProgram(db, actor, {
    name: "Test League",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "Recreational",
    season: "Fall",
    start_date: "2026-09-12",
    fee_cents: 9500,
    capacity: 1,
  });
  function person() {
    const pid = id();
    db.prepare(
      "INSERT INTO people(id,org_id,first_name,last_name,created_at) VALUES(?,?,?,?,?)",
    ).run(pid, "org", "Test", "Player", now());
    return pid;
  }
  return { db, actor, p, person };
}

import { registrationTransferResult, cancellationPreview, cancelRegistration, transferRegistration, previewRegistrationTransfer } from "./registration-lifecycle.mjs";
test("cancellation rejects stale billing, preserves paid invoices, and releases capacity", () => {
 const {db,actor,p,person}=fixture();
 try {
  const reg=register(db,actor,{program_id:p.id,person_id:person()});
  const preview=cancellationPreview(db,actor,reg.id);
  assert.equal(preview.can_void_invoice,true);
  recordPayment(db,actor,reg.invoice_id,{amount_cents:1000,method:"Cash",idempotency_key:"cancel-payment"});
  assert.throws(()=>cancelRegistration(db,actor,reg.id,{revision:preview.revision,invoice_action:"keep",reason:"Requested"}), /changed/);
  const current=cancellationPreview(db,actor,reg.id);
  assert.equal(current.can_void_invoice,false);
  assert.throws(()=>cancelRegistration(db,actor,reg.id,{revision:current.revision,invoice_action:"void_unpaid",reason:"Requested"}), /unpaid/);
  assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(reg.id).status,"Pending");
  cancelRegistration(db,actor,reg.id,{revision:current.revision,invoice_action:"keep",reason:"Requested"});
  assert.equal(db.prepare("SELECT paid_cents FROM invoices WHERE id=?").get(reg.invoice_id).paid_cents,1000);
  assert.equal(register(db,actor,{program_id:p.id,person_id:person()}).status,"Pending");
  assert.equal(cancelRegistration(db,actor,reg.id,{revision:current.revision,invoice_action:"keep",reason:"Requested"}).already_canceled,true);
  assert.throws(()=>cancellationPreview(db,{...actor,org_id:"foreign"},reg.id), /not found/);
 } finally {db.close();}
});
test("unpaid cancellation voids invoice atomically and keeps historical registration", () => {
 const {db,actor,p,person}=fixture();
 try {
  const reg=register(db,actor,{program_id:p.id,person_id:person()});
  const preview=cancellationPreview(db,actor,reg.id);
  cancelRegistration(db,actor,reg.id,{revision:preview.revision,invoice_action:"void_unpaid",reason:"Duplicate signup"});
  assert.equal(db.prepare("SELECT voided FROM invoices WHERE id=?").get(reg.invoice_id).voided,1);
  assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(reg.id).status,"Canceled");
  assert.throws(()=>recordPayment(db,actor,reg.invoice_id,{amount_cents:1000,method:"Cash",idempotency_key:"voided-payment"}));
 } finally {db.close();}
});


test("program transfer rolls back cancellation on destination failure and preserves both records on success", () => {
 const {db,actor,p,person}=fixture();
 try {
  const source=register(db,actor,{program_id:p.id,person_id:person()});
  const target=saveProgram(db,actor,{name:"Destination",type:"League",sport:"Soccer",gender:"Co-Ed",level:"All",season:"Fall",start_date:"2026-09-12",fee_cents:12000,capacity:1});
  register(db,actor,{program_id:target.id,person_id:person()});
  const input={request_key:id(),revision:cancellationPreview(db,actor,source.id).revision,invoice_action:"void_unpaid",reason:"Requested move",destination:{program_id:target.id}};
  const count=db.prepare("SELECT COUNT(*) n FROM registrations").get().n;
  const audits=db.prepare("SELECT COUNT(*) n FROM audit_log").get().n;
  assert.throws(()=>transferRegistration(db,actor,source.id,input),/waiting list/);
  assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(source.id).status,"Pending");
  assert.equal(db.prepare("SELECT voided FROM invoices WHERE id=?").get(source.invoice_id).voided,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM registrations").get().n,count);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log").get().n,audits);
  db.prepare("UPDATE programs SET capacity=2 WHERE id=?").run(target.id);
  const quote=previewRegistrationTransfer(db,actor,source.id,input);
  assert.equal(quote.outcome.total_cents,12000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM registration_transfers").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log").get().n,audits);
  assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(source.id).status,"Pending");
  input.expected_outcome=quote.outcome;
  db.prepare("UPDATE programs SET fee_cents=13000 WHERE id=?").run(target.id);
  assert.throws(()=>transferRegistration(db,actor,source.id,input),error => error.transfer_not_saved === true && /destination price/.test(error.message));
  assert.equal(db.prepare("SELECT voided FROM invoices WHERE id=?").get(source.invoice_id).voided,0);
  db.prepare("UPDATE programs SET fee_cents=12000 WHERE id=?").run(target.id);
  assert.deepEqual(registrationTransferResult(db,actor,source.id,input.request_key),{completed:false});
  const result=transferRegistration(db,actor,source.id,input);
  assert.deepEqual(registrationTransferResult(db,actor,source.id,input.request_key),{completed:true,result:JSON.parse(JSON.stringify(result))});
  assert.deepEqual(registrationTransferResult(db,actor,result.destination.id,input.request_key),{completed:false});
  assert.throws(()=>registrationTransferResult(db,{...actor,org_id:"other"},source.id,input.request_key),/not found/);
  assert.deepEqual(transferRegistration(db,actor,source.id,input), JSON.parse(JSON.stringify(result)));
  assert.throws(()=>transferRegistration(db,actor,source.id,{...input,reason:"Changed"}),error=>error.status===409 && !error.transfer_not_saved);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM registration_transfers").get().n,1);
  assert.equal(result.destination.person_id,source.person_id);
  assert.equal(result.destination.program_id,target.id);
  assert.equal(result.destination.status,"Pending");
  assert.equal(db.prepare("SELECT total_cents FROM invoices WHERE id=?").get(result.destination.invoice_id).total_cents,12000);
  assert.equal(db.prepare("SELECT voided FROM invoices WHERE id=?").get(source.invoice_id).voided,1);
  assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(source.id).status,"Canceled");
 } finally {db.close();}
});

test("canceling a registration cannot void an invoice shared with another active registration", () => {
  const {db,actor,p,person}=fixture();
  try {
    db.prepare("UPDATE programs SET capacity=5 WHERE id=?").run(p.id);
    const first=register(db,actor,{program_id:p.id,person_id:person()});
    const second=register(db,actor,{program_id:p.id,person_id:person()});
    db.prepare("UPDATE registrations SET invoice_id=? WHERE id=?").run(first.invoice_id,second.id);
    const preview=cancellationPreview(db,actor,first.id);
    assert.equal(preview.can_void_invoice,false);
    assert.throws(()=>cancelRegistration(db,actor,first.id,{revision:preview.revision,invoice_action:"void_unpaid",reason:"Cancel one participant"}),/unpaid/);
    cancelRegistration(db,actor,first.id,{revision:preview.revision,invoice_action:"keep",reason:"Cancel one participant"});
    assert.equal(db.prepare("SELECT voided FROM invoices WHERE id=?").get(first.invoice_id).voided,0);
    assert.equal(db.prepare("SELECT status FROM registrations WHERE id=?").get(second.id).status,"Pending");
  } finally {db.close();}
});

test("registration cancellation preserves an invoice backing a product order and its stock reservation", async () => {
  const {saveProduct,createOrder,productDetail}=await import("./commerce.mjs");
  const {db,actor,p,person}=fixture();
  try {
    const personId=person();
    const product=saveProduct(db,actor,{name:"Test jersey",price_cents:2500,inventory:2});
    const order=createOrder(db,actor,{product_id:product.id,person_id:personId,quantity:1,quoted_total_cents:2500,idempotency_key:id()});
    const registration=register(db,actor,{program_id:p.id,person_id:personId});
    db.prepare("UPDATE registrations SET invoice_id=? WHERE id=?").run(order.invoice_id,registration.id);
    const preview=cancellationPreview(db,actor,registration.id);
    assert.equal(preview.can_void_invoice,false);
    assert.throws(()=>cancelRegistration(db,actor,registration.id,{revision:preview.revision,invoice_action:"void_unpaid",reason:"Withdraw"}),/unpaid/);
    cancelRegistration(db,actor,registration.id,{revision:preview.revision,invoice_action:"keep",reason:"Withdraw"});
    assert.equal(db.prepare("SELECT voided FROM invoices WHERE id=?").get(order.invoice_id).voided,0);
    assert.equal(db.prepare("SELECT status FROM product_orders WHERE id=?").get(order.id).status,"Open");
    assert.equal(productDetail(db,actor,product.id).inventory,1);
  } finally {db.close();}
});

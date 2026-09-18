import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now } from "./db.mjs";
import {
  saveProgram,
  register,
  recordPayment,
} from "./domain.mjs";
import { getForm, saveForm } from "./forms.mjs";
import {
  cancellationPreview,
  transferRegistration,
  previewRegistrationTransfer,
  registrationTransferResult,
} from "./registration-lifecycle.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES('org','Club')").run();
  const actor = { id: "admin", org_id: "org" };
  const personId = id();
  // An adult participant can sign their own waivers.
  db.prepare(
    "INSERT INTO people(id,org_id,first_name,last_name,birthdate,created_at) VALUES(?,?,?,?,?,?)",
  ).run(personId, "org", "Test", "Player", "1990-05-01", now());
  const program = (name, fee = 0) =>
    saveProgram(db, actor, {
      name,
      type: "League",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "Recreational",
      season: "Fall",
      start_date: "2026-09-12",
      fee_cents: fee,
      capacity: 5,
    });
  const setForm = (programId, fields, waivers) =>
    saveForm(db, actor, `program:${programId}`, {
      version: getForm(db, "org", `program:${programId}`).version,
      fields,
      waivers,
    });
  const requiredField = () => ({
    id: id(),
    name: "Emergency contact",
    type: "Single Text",
    required: true,
    apply: "Always",
    roles: ["Team Player", "Free Agent", "Program Staff"],
  });
  const requiredWaiver = (name = "Liability release") => ({
    id: id(),
    name,
    content: "<p>Release statement</p>",
    enabled: true,
    required: true,
    apply: "Always",
    roles: ["Team Player", "Free Agent", "Program Staff"],
  });
  return { db, actor, personId, program, setForm, requiredField, requiredWaiver };
}

const accept = (waiver, personId) => ({
  waiver_id: waiver.id,
  waiver_version: waiver.version,
  signer_id: personId,
});

test("missing destination answers and waivers roll back source cancellation and billing", () => {
  const { db, actor, personId, program, setForm, requiredField, requiredWaiver } =
    fixture();
  try {
    const source = program("Source", 8000);
    const destination = program("Destination", 12000);
    const field = requiredField();
    const waiver = requiredWaiver();
    setForm(destination.id, [field], [waiver]);

    const registration = register(db, actor, {
      program_id: source.id,
      person_id: personId,
    });
    recordPayment(db, actor, registration.invoice_id, {
      amount_cents: 500,
      method: "Cash",
      idempotency_key: id(),
    });
    const revision = cancellationPreview(db, actor, registration.id).revision;
    const input = {
      request_key: id(),
      revision,
      invoice_action: "keep",
      reason: "Move",
      destination: { program_id: destination.id },
    };
    const counts = () => ({
      registrations: db.prepare("SELECT COUNT(*) n FROM registrations").get().n,
      transfers: db
        .prepare("SELECT COUNT(*) n FROM registration_transfers")
        .get().n,
      audits: db.prepare("SELECT COUNT(*) n FROM audit_log").get().n,
    });

    // No answers, no waiver acceptances: the required field fails first.
    const before = counts();
    assert.throws(
      () => transferRegistration(db, actor, registration.id, input),
      (error) =>
        error.transfer_not_saved === true && /required/i.test(error.message),
    );
    assert.deepEqual(counts(), before);
    assert.equal(
      db
        .prepare("SELECT status FROM registrations WHERE id=?")
        .get(registration.id).status,
      "Pending",
    );
    assert.equal(
      db
        .prepare("SELECT voided FROM invoices WHERE id=?")
        .get(registration.invoice_id).voided,
      0,
    );

    // Answering the field but skipping the required waiver also rolls back.
    assert.throws(
      () =>
        transferRegistration(db, actor, registration.id, {
          ...input,
          destination: {
            program_id: destination.id,
            answers: { [field.id]: "Pat 555-0100" },
            waiver_acceptances: [],
            form_version: 2,
          },
        }),
      /Record acceptance for Liability release/,
    );
    assert.deepEqual(counts(), before);
    assert.equal(
      db
        .prepare("SELECT status FROM registrations WHERE id=?")
        .get(registration.id).status,
      "Pending",
    );
  } finally {
    db.close();
  }
});

test("stale destination form and waiver versions roll back the whole transfer", () => {
  const { db, actor, personId, program, setForm, requiredField, requiredWaiver } =
    fixture();
  try {
    const source = program("Source", 8000);
    const destination = program("Destination");
    const field = requiredField();
    const waiver = requiredWaiver();
    setForm(destination.id, [field], [waiver]);
    const savedWaiver = getForm(db, "org", `program:${destination.id}`)
      .waivers[0];
    const registration = register(db, actor, {
      program_id: source.id,
      person_id: personId,
    });
    const base = {
      request_key: id(),
      revision: cancellationPreview(db, actor, registration.id).revision,
      invoice_action: "void_unpaid",
      reason: "Move",
      destination: {
        program_id: destination.id,
        answers: { [field.id]: "Pat 555-0100" },
        waiver_acceptances: [accept(savedWaiver, personId)],
      },
    };
    // A stale form_version is rejected before anything changes.
    assert.throws(
      () =>
        transferRegistration(db, actor, registration.id, {
          ...base,
          destination: { ...base.destination, form_version: 1 },
        }),
      (error) => error.status === 409 && /form changed/i.test(error.message),
    );
    // A waiver edited since the preview invalidates the quoted acceptance.
    assert.throws(
      () =>
        transferRegistration(db, actor, registration.id, {
          ...base,
          destination: {
            ...base.destination,
            form_version: 2,
            waiver_acceptances: [
              { ...accept(waiver, personId), waiver_version: 9 },
            ],
          },
        }),
      (error) => error.status === 409 && /waiver changed/i.test(error.message),
    );
    assert.equal(
      db
        .prepare("SELECT status FROM registrations WHERE id=?")
        .get(registration.id).status,
      "Pending",
    );
    assert.equal(
      db
        .prepare("SELECT voided FROM invoices WHERE id=?")
        .get(registration.invoice_id).voided,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM registration_transfers").get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test("valid destination evidence transfers atomically and retries stay idempotent", () => {
  const { db, actor, personId, program, setForm, requiredField, requiredWaiver } =
    fixture();
  try {
    const source = program("Source", 8000);
    const destination = program("Destination", 12000);
    // The source also carries signed evidence that must survive the transfer.
    const sourceWaiver = requiredWaiver("Source release");
    setForm(source.id, [], [sourceWaiver]);
    const destField = requiredField();
    const destWaiver = requiredWaiver("Destination release");
    setForm(destination.id, [destField], [destWaiver]);

    const sourceForm = getForm(db, "org", `program:${source.id}`);
    const destinationForm = getForm(db, "org", `program:${destination.id}`);
    const savedSourceWaiver = sourceForm.waivers.find(
      (w) => w.id === sourceWaiver.id,
    );
    const savedDestWaiver = destinationForm.waivers.find(
      (w) => w.id === destWaiver.id,
    );
    const registration = register(db, actor, {
      program_id: source.id,
      person_id: personId,
      waiver_acceptances: [accept(savedSourceWaiver, personId)],
      form_version: sourceForm.version,
    });
    const input = {
      request_key: id(),
      revision: cancellationPreview(db, actor, registration.id).revision,
      invoice_action: "void_unpaid",
      reason: "Division move",
      destination: {
        program_id: destination.id,
        answers: { [destField.id]: "Pat 555-0100" },
        waiver_acceptances: [accept(savedDestWaiver, personId)],
        form_version: destinationForm.version,
      },
    };
    const quote = previewRegistrationTransfer(db, actor, registration.id, input);
    input.expected_outcome = quote.outcome;
    const result = transferRegistration(db, actor, registration.id, input);
    const destinationId = result.destination.id;
    assert.notEqual(destinationId, registration.id);

    // Destination evidence is distinct and bound to the new registration.
    const answers = db
      .prepare("SELECT * FROM registration_answers WHERE registration_id=?")
      .get(destinationId);
    assert.equal(answers.definition_version, 2);
    assert.equal(
      JSON.parse(answers.answers)[destField.id],
      "Pat 555-0100",
    );
    const destinationWaivers = db
      .prepare(
        "SELECT * FROM waiver_acceptances WHERE registration_id=? AND org_id=?",
      )
      .all(destinationId, "org");
    assert.equal(destinationWaivers.length, 1);
    assert.equal(destinationWaivers[0].waiver_id, destWaiver.id);
    assert.equal(destinationWaivers[0].signer_id, personId);
    assert.equal(destinationWaivers[0].method, "Admin recorded");

    // Source history is preserved: canceled registration, voided invoice,
    // untouched signed waiver evidence.
    assert.equal(
      db
        .prepare("SELECT status FROM registrations WHERE id=?")
        .get(registration.id).status,
      "Canceled",
    );
    assert.equal(
      db
        .prepare("SELECT voided FROM invoices WHERE id=?")
        .get(registration.invoice_id).voided,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM waiver_acceptances WHERE registration_id=?",
        )
        .get(registration.id).n,
      1,
    );

    // Replaying the identical request returns the stored result and writes
    // nothing new; a different body under the same key conflicts.
    const evidence = () => ({
      answers: db
        .prepare("SELECT COUNT(*) n FROM registration_answers")
        .get().n,
      waivers: db.prepare("SELECT COUNT(*) n FROM waiver_acceptances").get().n,
      registrations: db.prepare("SELECT COUNT(*) n FROM registrations").get().n,
    });
    const before = evidence();
    assert.deepEqual(
      transferRegistration(db, actor, registration.id, input),
      JSON.parse(JSON.stringify(result)),
    );
    assert.deepEqual(evidence(), before);
    assert.throws(
      () =>
        transferRegistration(db, actor, registration.id, {
          ...input,
          reason: "Different reason",
        }),
      (error) => error.status === 409,
    );
    assert.deepEqual(
      registrationTransferResult(db, actor, registration.id, input.request_key),
      { completed: true, result: JSON.parse(JSON.stringify(result)) },
    );
  } finally {
    db.close();
  }
});

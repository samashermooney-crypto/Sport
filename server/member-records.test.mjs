import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { beginMemberSignup, verifyMemberSignup } from "./member-auth.mjs";
import {
  saveMemberProfile,
  accessibleProfile,
  canReadMemberFile,
} from "./member-profile.mjs";
import {
  memberInvoices,
  memberInvoice,
  memberRegistrationRecord,
} from "./member-records.mjs";
import { saveProgram, register, recordPayment } from "./domain.mjs";
import { saveForm } from "./forms.mjs";
import { issueCredit, applyCredit } from "./directory.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Example Club'),('foreign','Other Club')",
  ).run();
  const app = makeApp(db),
    actor = { id: "admin", org_id: "org" };
  const signup = {
    email: "guardian@example.com",
    password: "Example password 2026!",
    first_name: "Casey",
    last_name: "Example",
    birthdate: "1988-01-01",
  };
  const account = verifyMemberSignup(
    db,
    "org",
    beginMemberSignup(db, "org", signup).token,
  );
  const stranger = verifyMemberSignup(
    db,
    "org",
    beginMemberSignup(db, "org", { ...signup, email: "stranger@example.com" })
      .token,
  );
  const household = db
    .prepare("SELECT household_id FROM people WHERE id=?")
    .get(account.person_id).household_id;
  const child = saveMemberProfile(db, account, {
    first_name: "Riley",
    last_name: "Example",
    birthdate: "2015-04-10",
    gender: "Unknown",
    household_id: household,
    profile_form_version: 1,
    profile_record_version: 0,
    profile_answers: {},
  });
  const program = saveProgram(db, actor, {
    name: "Example League",
    type: "League",
    sport: "Soccer",
    level: "All",
    season: "Fall",
    gender: "Co-Ed",
    start_date: "2026-10-01",
    fee_cents: 9500,
  });
  const file = id(),
    question = id(),
    hidden = id();
  db.prepare("INSERT INTO form_files VALUES(?,?,?,?,?,?)").run(
    file,
    "org",
    "fixture.txt",
    "text/plain",
    Buffer.from("Fictional record attachment"),
    now(),
  );
  const fields = [
    { id: question, name: "Attachment", type: "File Upload" },
    {
      id: hidden,
      name: "Private staff review",
      type: "Single Text",
      visibility: "Admin Only",
    },
  ];
  const form = saveForm(db, actor, `program:${program.id}`, {
    version: 1,
    fields,
  });
  const registration = register(db, actor, {
    program_id: program.id,
    person_id: child.id,
    form_version: form.version,
    answers: { [question]: file, [hidden]: "Staff secret" },
  });
  return {
    db,
    app,
    actor,
    account,
    stranger,
    signup,
    child,
    registration,
    program,
    fields,
    file,
    question,
    hidden,
  };
}
test("family invoices expose accurate balances and history without internal payment data", () => {
  const { db, actor, account, stranger, child, registration } = fixture();
  try {
    recordPayment(db, actor, registration.invoice_id, {
      amount_cents: 2000,
      method: "Check",
      reference: "Internal bank reference",
      idempotency_key: "fictional-payment-1",
    });
    const credit = issueCredit(db, actor, {
      person_id: child.id,
      amount_cents: 1000,
      description: "Internal adjustment note",
    });
    applyCredit(db, actor, registration.invoice_id, {
      credit_id: credit.id,
      amount_cents: 1000,
      idempotency_key: "fictional-credit-1",
    });
    const invoice = memberInvoice(db, account, registration.invoice_id);
    assert.equal(invoice.balance_cents, 6500);
    assert.equal(invoice.status, "Partially paid");
    assert.equal(invoice.history.length, 2);
    assert.equal(
      invoice.history.some((h) => h.type === "credit"),
      true,
    );
    assert.equal(JSON.stringify(invoice).includes("Internal"), false);
    assert.equal(JSON.stringify(invoice).includes("idempotency"), false);
    assert.deepEqual(memberInvoices(db, stranger), []);
    assert.throws(
      () => memberInvoice(db, stranger, registration.invoice_id),
      /not found/,
    );
    db.prepare("UPDATE invoices SET due_date='2000-01-01' WHERE id=?").run(
      registration.invoice_id,
    );
    assert.equal(
      memberInvoice(db, account, registration.invoice_id).status,
      "Overdue",
    );
    db.prepare("UPDATE invoices SET voided=1 WHERE id=?").run(
      registration.invoice_id,
    );
    assert.equal(
      memberInvoice(db, account, registration.invoice_id).balance_cents,
      0,
    );
    assert.equal(
      memberInvoice(db, account, registration.invoice_id).status,
      "Void",
    );
  } finally {
    db.close();
  }
});
test("registration history honors stored and current staff privacy while retaining archived family records", () => {
  const {
    db,
    actor,
    account,
    stranger,
    child,
    registration,
    program,
    fields,
    file,
    question,
    hidden,
  } = fixture();
  try {
    const record = memberRegistrationRecord(db, account, registration.id);
    assert.equal(record.answers[question], file);
    assert.equal(record.answers[hidden], undefined);
    assert.equal(
      record.fields.some((f) => f.id === hidden),
      false,
    );
    assert.equal(canReadMemberFile(db, account, file), true);
    assert.equal(canReadMemberFile(db, stranger, file), false);
    assert.throws(
      () => memberRegistrationRecord(db, stranger, registration.id),
      /not found/,
    );
    db.prepare(
      "UPDATE people SET data=json_set(data,'$.archived_at',?) WHERE id=?",
    ).run(now(), child.id);
    assert.equal(
      memberInvoice(db, account, registration.invoice_id).participant_name,
      "Riley Example",
    );
    assert.equal(
      memberRegistrationRecord(db, account, registration.id).id,
      registration.id,
    );
    assert.throws(() => accessibleProfile(db, account, child.id), /not found/);
    saveForm(db, actor, `program:${program.id}`, {
      version: 2,
      fields: fields.map((f) => ({ ...f, visibility: "Admin Only" })),
    });
    assert.deepEqual(
      memberRegistrationRecord(db, account, registration.id).fields,
      [],
    );
    assert.deepEqual(
      memberRegistrationRecord(db, account, registration.id).answers,
      {},
    );
    assert.equal(canReadMemberFile(db, account, file), false);
    assert.equal(
      JSON.parse(
        db
          .prepare(
            "SELECT answers FROM registration_answers WHERE registration_id=?",
          )
          .get(registration.id).answers,
      )[question],
      file,
    );
  } finally {
    db.close();
  }
});
test("member record and attachment routes remain private across accounts and organizations", async () => {
  const { db, app, signup, registration, file } = fixture();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/member`;
  const login = async (email) =>
    (
      await fetch(root + "/org/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fieldhouse-Request": "1",
        },
        body: JSON.stringify({ ...signup, email }),
      })
    ).headers
      .get("set-cookie")
      .split(";")[0];
  try {
    const cookie = await login(signup.email),
      stranger = await login("stranger@example.com");
    for (const path of [
      `invoices/${registration.invoice_id}`,
      `registrations/${registration.id}`,
      `form-files/${file}`,
    ]) {
      assert.equal((await fetch(root + "/org/" + path)).status, 401);
      assert.equal(
        (await fetch(root + "/org/" + path, { headers: { cookie } })).status,
        200,
      );
      assert.equal(
        (await fetch(root + "/org/" + path, { headers: { cookie: stranger } }))
          .status,
        404,
      );
      assert.equal(
        (await fetch(root + "/foreign/" + path, { headers: { cookie } }))
          .status,
        401,
      );
    }
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

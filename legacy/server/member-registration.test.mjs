import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { beginMemberSignup, verifyMemberSignup } from "./member-auth.mjs";
import { saveProgram } from "./domain.mjs";
import { saveForm } from "./forms.mjs";
import {
  memberEnrollmentContext,
  registerMember,
} from "./member-registration.mjs";
import { saveMemberProfile } from "./member-profile.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
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
    capacity: 1,
  });
  const waiver = id(),
    question = id(),
    hidden = id();
  const form = saveForm(db, actor, `program:${program.id}`, {
    version: 1,
    fields: [
      {
        id: question,
        name: "Practice day",
        type: "Single Text",
        required: true,
      },
      {
        id: hidden,
        name: "Staff only",
        type: "Single Text",
        required: true,
        visibility: "Admin Only",
      },
    ],
    waivers: [
      {
        id: waiver,
        name: "Fictional test waiver",
        content: "<p>Nonbinding test document.</p>",
      },
    ],
  });
  const input = {
    program_id: program.id,
    person_id: child.id,
    answers: { [question]: "Monday" },
    form_version: form.version,
    waiver_acceptances: [
      { waiver_id: waiver, waiver_version: 1, signer_id: account.person_id },
    ],
    expected_fee_cents: 9500,
  };
  return {
    db,
    app,
    actor,
    account,
    stranger,
    child,
    program,
    input,
    hidden,
    signup,
  };
}
test("member enrollment validates public windows, passwords, family roles and required profile completion", () => {
  const { db, actor, account, stranger, child, program, input, hidden } =
    fixture();
  try {
    const context = memberEnrollmentContext(db, account, input);
    assert.equal(
      context.form.fields.some((f) => f.id === hidden),
      false,
    );
    assert.deepEqual(
      context.form.signers.map((p) => p.id),
      [account.person_id],
    );
    assert.throws(
      () => memberEnrollmentContext(db, stranger, input),
      /family account/,
    );
    db.prepare("UPDATE programs SET public=0 WHERE id=?").run(program.id);
    assert.throws(
      () => memberEnrollmentContext(db, account, input),
      /not found/,
    );
    db.prepare(
      "UPDATE programs SET public=1,registration_start='2099-01-01' WHERE id=?",
    ).run(program.id);
    assert.throws(() => registerMember(db, account, input), /not open/);
    db.prepare(
      "UPDATE programs SET registration_start='',registration_end='2000-01-01' WHERE id=?",
    ).run(program.id);
    assert.throws(() => registerMember(db, account, input), /not open/);
    db.prepare(
      "UPDATE programs SET registration_end='',data=json_set(data,'$.registration_password','secret') WHERE id=?",
    ).run(program.id);
    assert.throws(
      () => memberEnrollmentContext(db, account, input),
      /correct program/,
    );
    assert.equal(
      memberEnrollmentContext(db, account, { ...input, password: "secret" })
        .program.id,
      program.id,
    );
    db.prepare(
      "UPDATE programs SET data=json_set(data,'$.registration_password','') WHERE id=?",
    ).run(program.id);
    const household = db
      .prepare("SELECT household_id FROM people WHERE id=?")
      .get(child.id).household_id;
    db.prepare("INSERT INTO household_members VALUES(?,?,'Supervisor')").run(
      household,
      stranger.person_id,
    );
    assert.throws(
      () =>
        registerMember(db, account, {
          ...input,
          person_id: stranger.person_id,
        }),
      /family account/,
    );
    saveForm(db, actor, "profile", {
      version: 1,
      fields: [
        {
          id: id(),
          name: "Required profile answer",
          type: "Single Text",
          required: true,
        },
      ],
    });
    assert.throws(() => registerMember(db, account, input), /Complete Casey/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registrations").get().n, 0);
  } finally {
    db.close();
  }
});
test("member registration binds waiver signer, detects price changes, and creates pending invoices or waitlists atomically", () => {
  const { db, account, stranger, input, program } = fixture();
  try {
    assert.throws(
      () => registerMember(db, account, { ...input, expected_fee_cents: 0 }),
      /price changed/,
    );
    assert.throws(
      () =>
        registerMember(db, account, {
          ...input,
          waiver_acceptances: input.waiver_acceptances.map((a) => ({
            ...a,
            signer_id: stranger.person_id,
          })),
        }),
      /own signed-in/,
    );
    assert.throws(
      () =>
        registerMember(db, account, {
          ...input,
          waiver_acceptances: input.waiver_acceptances.map((a) => ({
            ...a,
            accepted_at: "2020-01-01T00:00:00Z",
          })),
        }),
      /own signed-in/,
    );
    assert.throws(
      () =>
        registerMember(db, account, {
          ...input,
          waiver_acceptances: [],
          waiver_accepted: true,
        }),
      /acceptance/,
    );
    assert.throws(
      () => registerMember(db, account, { ...input, form_version: 99 }),
      /form changed/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices").get().n, 0);
    assert.throws(
      () => registerMember(db, account, { ...input, role: "Coach" }),
      /self-registration/,
    );
    const result = registerMember(db, account, {
      ...input,
      team_id: "forged",
    });
    assert.equal(result.status, "Pending");
    assert.equal(result.invoice.total_cents, 9500);
    assert.equal(result.invoice.paid_cents, 0);
    assert.equal(
      db.prepare("SELECT role FROM registrations WHERE id=?").get(result.id)
        .role,
      "Free Agent",
    );
    const evidence = db
      .prepare("SELECT * FROM waiver_acceptances WHERE registration_id=?")
      .get(result.id);
    assert.equal(evidence.method, "Member accepted");
    assert.equal(evidence.signer_id, account.person_id);
    assert.throws(
      () => registerMember(db, account, input),
      /already registered/,
    );
    const wait = registerMember(db, account, {
      ...input,
      person_id: account.person_id,
    });
    assert.equal(wait.status, "Wait List");
    assert.equal(wait.invoice, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices").get().n, 1);
  } finally {
    db.close();
  }
});
test("member enrollment HTTP endpoints require a member cookie and reject cross-organization requests", async () => {
  const { db, app, signup, input } = fixture();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/member`;
  const post = (path, body, cookie = "") =>
    fetch(root + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
        cookie,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/org/enrollment", input)).status, 401);
    const login = await post("/org/login", signup),
      cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await post("/other/enrollment", input, cookie)).status, 401);
    assert.equal((await post("/org/enrollment", input, cookie)).status, 200);
    assert.equal((await post("/org/registrations", input, cookie)).status, 201);
    assert.equal((await post("/org/registrations", input, cookie)).status, 409);
    const records = await (
      await fetch(root + "/org/registrations", { headers: { cookie } })
    ).json();
    assert.equal(records.length, 1);
    assert.equal(records[0].participant_name, "Riley Example");
    assert.equal("answers" in records[0], false);
    const outsiderLogin = await post("/org/login", {
      ...signup,
      email: "stranger@example.com",
    });
    const outsiderCookie = outsiderLogin.headers
      .get("set-cookie")
      .split(";")[0];
    assert.deepEqual(
      await (
        await fetch(root + "/org/registrations", {
          headers: { cookie: outsiderCookie },
        })
      ).json(),
      [],
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("member plan selection enforces access and versions, snapshots price atomically, and caps private redemption", async () => {
  const { savePaymentPlan } = await import("./payment-plans.mjs");
  const { getRules, saveRules } = await import("./program-rules.mjs");
  const { invoiceInstallments } = await import("./invoice-installments.mjs");
  const { db, actor, account, program, input } = fixture();
  try {
    const current = getRules(db, "org", program);
    saveRules(
      db,
      actor,
      {
        ...current,
        enable_payment_plans: true,
      },
      program.id,
    );
    const plan = savePaymentPlan(db, actor, program.id, {
      version: 1,
      name: "Private schedule",
      role: "Free Agent",
      private_code: "TEST-PRIVATE",
      redemption_limit: 1,
      installments: [
        { due_date: "2098-10-01", amount_cents: 4000 },
        { due_date: "2098-11-01", amount_cents: 6000 },
      ],
    }).plans[0];
    assert.equal(
      memberEnrollmentContext(db, account, input).payment_plans.length,
      0,
    );
    const picked = {
      ...input,
      private_plan_code: "TEST-PRIVATE",
      payment_plan_id: plan.id,
      payment_plan_version: 1,
      expected_fee_cents: 10000,
    };
    const exposed = memberEnrollmentContext(db, account, picked)
      .payment_plans[0];
    assert.equal(exposed.total_cents, 10000);
    assert.equal(exposed.private_code, undefined);
    assert.throws(
      () => registerMember(db, account, { ...picked, private_plan_code: "" }),
      /not available/,
    );
    assert.throws(
      () => registerMember(db, account, { ...picked, payment_plan_version: 2 }),
      /changed/,
    );
    assert.throws(
      () =>
        registerMember(db, account, { ...picked, expected_fee_cents: 9500 }),
      /price changed/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registrations").get().n, 0);
    const result = registerMember(db, account, picked);
    assert.equal(result.invoice.total_cents, 10000);
    assert.equal(
      invoiceInstallments(db, "org", result.invoice.id).installments.length,
      2,
    );
    assert.equal(
      memberEnrollmentContext(db, account, picked).payment_plans[0].available,
      false,
    );
  } finally {
    db.close();
  }
});
test("plan discounts distribute exactly across installments and cap small rows", async () => {
  const { discountedSchedule } = await import("./member-payment-plans.mjs");
  const original = {
    total_cents: 100,
    installments: [{ total_cents: 1 }, { total_cents: 99 }],
  };
  const discounted = discountedSchedule(original, 50);
  assert.deepEqual(
    discounted.installments.map((r) => r.total_cents),
    [0, 50],
  );
  assert.equal(
    discounted.installments.reduce((sum, r) => sum + r.discount_cents, 0),
    50,
  );
  assert.deepEqual(
    original.installments.map((r) => r.total_cents),
    [1, 99],
  );
});

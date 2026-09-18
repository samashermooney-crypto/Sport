import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDb, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProgram, register } from "./domain.mjs";
import { savePerson } from "./directory.mjs";
import {
  getForm,
  saveForm,
  applicableFields,
  registrationFormContext,
  profileFormContext,
} from "./forms.mjs";

test("profile answers validate atomically, reject stale forms, and preserve revision history", () => {
  const { db, actor, child, field } = fixture();
  try {
    const profile = saveForm(db, actor, "profile", {
      version: 1,
      fields: [field],
    });
    const input = {
      ...child,
      profile_form_version: profile.version,
      profile_record_version: 0,
      profile_answers: { [field.id]: "Thursday" },
    };
    assert.throws(
      () =>
        savePerson(
          db,
          actor,
          {
            ...input,
            first_name: "Changed",
            profile_answers: { [field.id]: "Friday" },
          },
          child.id,
        ),
      /Choose an option/,
    );
    assert.equal(
      db.prepare("SELECT first_name FROM people WHERE id=?").get(child.id)
        .first_name,
      child.first_name,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM profile_answer_revisions").get().n,
      0,
    );
    savePerson(db, actor, input, child.id);
    assert.equal(
      profileFormContext(db, actor, child.id).answers[field.id],
      "Thursday",
    );
    assert.throws(
      () => savePerson(db, actor, input, child.id),
      /updated elsewhere/,
    );
    const edited = saveForm(db, actor, "profile", {
      ...profile,
      fields: [{ ...field, name: "Preferred weekday" }],
    });
    assert.throws(
      () =>
        savePerson(
          db,
          actor,
          { ...input, profile_record_version: 1 },
          child.id,
        ),
      /questions changed/,
    );
    savePerson(
      db,
      actor,
      {
        ...input,
        profile_form_version: edited.version,
        profile_record_version: 1,
        profile_answers: {},
      },
      child.id,
    );
    const history = db
      .prepare(
        "SELECT * FROM profile_answer_revisions WHERE person_id=? ORDER BY version",
      )
      .all(child.id);
    assert.equal(history.length, 2);
    assert.equal(JSON.parse(history[0].definition).fields[0].name, field.name);
    assert.equal(JSON.parse(history[0].answers)[field.id], "Thursday");
    assert.deepEqual(JSON.parse(history[1].answers), {}); // Admin can skip required additional questions.
    savePerson(db, actor, { ...child, notes: "Notes-only update" }, child.id);
    assert.equal(profileFormContext(db, actor, child.id).record_version, 2);
    assert.throws(
      () => profileFormContext(db, { ...actor, org_id: "foreign" }, child.id),
      /not found/i,
    );
    assert.equal(
      db
        .prepare("SELECT data FROM people WHERE id=?")
        .get(child.id)
        .data.includes("profile_answers"),
      false,
    );
  } finally {
    db.close();
  }
});

test("profile questions retain hidden age-specific answers and validate checkbox, numeric and file values", () => {
  const { db, actor, child, field } = fixture();
  try {
    const numeric = {
      id: randomUUID(),
      name: "Jersey number",
      type: "Numeric",
    };
    const checks = {
      id: randomUUID(),
      name: "Interests",
      type: "Multiple Checkboxes",
      options: ["Soccer", "Basketball"],
    };
    const file = { id: randomUUID(), name: "Attachment", type: "File Upload" };
    const profile = saveForm(db, actor, "profile", {
      version: 1,
      fields: [field, numeric, checks, file],
    });
    const input = {
      ...child,
      profile_form_version: profile.version,
      profile_record_version: 0,
      profile_answers: {
        [field.id]: "Monday",
        [numeric.id]: 7,
        [checks.id]: ["Soccer"],
      },
    };
    for (const answers of [
      { [numeric.id]: "7" },
      { [checks.id]: ["Soccer", "Soccer"] },
      { [file.id]: randomUUID() },
    ]) {
      assert.throws(
        () =>
          savePerson(
            db,
            actor,
            { ...input, profile_answers: answers },
            child.id,
          ),
        /number|valid options|Upload a file/,
      );
    }
    savePerson(db, actor, input, child.id);
    const adultInput = {
      ...input,
      birthdate: "1980-01-01",
      profile_record_version: 1,
      profile_answers: { [numeric.id]: 8, [checks.id]: ["Basketball"] },
    };
    assert.throws(
      () =>
        savePerson(
          db,
          actor,
          { ...adultInput, profile_answers: input.profile_answers },
          child.id,
        ),
      /does not apply/,
    );
    savePerson(db, actor, adultInput, child.id);
    assert.equal(
      profileFormContext(db, actor, child.id).answers[field.id],
      "Monday",
    );
    assert.equal(
      profileFormContext(db, actor, child.id).answers[numeric.id],
      8,
    );
    const edited = saveForm(db, actor, "profile", {
      ...profile,
      fields: [numeric, checks, file],
    });
    savePerson(
      db,
      actor,
      {
        ...adultInput,
        profile_form_version: edited.version,
        profile_record_version: 2,
      },
      child.id,
    );
    assert.equal(
      profileFormContext(db, actor, child.id).answers[field.id],
      undefined,
    );
    assert.equal(
      JSON.parse(
        db
          .prepare(
            "SELECT answers FROM profile_answer_revisions WHERE person_id=? AND version=1",
          )
          .get(child.id).answers,
      )[field.id],
      "Monday",
    );
  } finally {
    db.close();
  }
});

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('foreign','Other')",
  ).run();
  const actor = { id: "admin", org_id: "org" };
  const base = {
    name: "Season",
    type: "League",
    sport: "Soccer",
    gender: "Co-Ed",
    level: "All",
    season: "Fall",
    start_date: "2026-10-01",
    status: "Live",
    fee_cents: 9500,
  };
  const child = savePerson(db, actor, {
    first_name: "Young",
    last_name: "Player",
    birthdate: "2015-06-10",
  });
  const parent = savePerson(db, actor, {
    first_name: "Adult",
    last_name: "Guardian",
    kind: "parent",
    birthdate: "1980-01-01",
  });
  const outsider = savePerson(db, actor, {
    first_name: "Other",
    last_name: "Adult",
    kind: "parent",
    birthdate: "1981-01-01",
  });
  db.prepare(
    "INSERT INTO households(id,org_id,name) VALUES('family','org','Example')",
  ).run();
  db.prepare("INSERT INTO household_members VALUES(?,?,?)").run(
    "family",
    child.id,
    "Member",
  );
  db.prepare("INSERT INTO household_members VALUES(?,?,?)").run(
    "family",
    parent.id,
    "Supervisor",
  );
  const field = {
    id: randomUUID(),
    name: "Preferred practice day",
    type: "Dropdown",
    required: true,
    options: ["Monday", "Thursday"],
    apply: "Children",
  };
  const waiver = {
    id: randomUUID(),
    name: "Demonstration acknowledgment",
    kind: "Main Waiver",
    content: "<p>Fictional test document, not a legal agreement.</p>",
    enabled: true,
    required: true,
  };
  return { db, actor, base, child, parent, outsider, field, waiver };
}
test("registration forms snapshot defaults and retain submitted answers after field edits", () => {
  const { db, actor, base, child, field } = fixture();
  try {
    const old = saveProgram(db, actor, base);
    saveForm(db, actor, "site", { version: 1, fields: [field] });
    const program = saveProgram(db, actor, { ...base, name: "New season" }),
      scope = `program:${program.id}`;
    assert.equal(
      getForm(db, actor.org_id, `program:${old.id}`).fields.length,
      0,
    );
    saveForm(db, actor, "site", {
      version: 2,
      fields: [{ ...field, name: "New default question" }],
    });
    const form = getForm(db, actor.org_id, scope);
    assert.equal(form.fields[0].name, field.name);
    const registration = {
      program_id: program.id,
      person_id: child.id,
      form_version: form.version,
      answers: { [field.id]: "Thursday" },
    };
    assert.throws(
      () => register(db, actor, { ...registration, answers: {} }),
      /required/,
    );
    assert.throws(
      () =>
        register(db, actor, {
          ...registration,
          answers: { [field.id]: "Invalid" },
        }),
      /Choose an option/,
    );
    assert.throws(
      () => register(db, actor, { ...registration, form_version: 999 }),
      /form changed/,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM invoices").get().n, 0);
    const reg = register(db, actor, registration);
    saveForm(db, actor, scope, {
      ...form,
      fields: [{ ...field, name: "Different question", options: ["Tuesday"] }],
    });
    const saved = db
      .prepare("SELECT * FROM registration_answers WHERE registration_id=?")
      .get(reg.id);
    assert.equal(JSON.parse(saved.answers)[field.id], "Thursday");
    assert.equal(JSON.parse(saved.definition).fields[0].name, field.name);
    assert.throws(() => saveForm(db, actor, scope, form), /changed/);
    assert.throws(
      () => saveForm(db, { id: "other", org_id: "foreign" }, scope, form),
      /not found/,
    );
  } finally {
    db.close();
  }
});
test("waivers require current documents and an adult participant or family supervisor", () => {
  const { db, actor, base, child, parent, outsider, waiver } = fixture();
  try {
    saveForm(db, actor, "site", { version: 1, waivers: [waiver] });
    const program = saveProgram(db, actor, base),
      scope = `program:${program.id}`,
      form = getForm(db, actor.org_id, scope);
    const input = {
      program_id: program.id,
      person_id: child.id,
      form_version: form.version,
      waiver_accepted: true,
    };
    assert.deepEqual(
      registrationFormContext(
        db,
        actor,
        program.id,
        child.id,
        "Free Agent",
      ).signers.map((p) => p.id),
      [parent.id],
    );
    const evidence = {
      waiver_id: waiver.id,
      waiver_version: 1,
      signer_id: parent.id,
    };
    assert.throws(() => register(db, actor, input), /Record acceptance/);
    assert.throws(
      () =>
        register(db, actor, {
          ...input,
          waiver_acceptances: [{ ...evidence, signer_id: outsider.id }],
        }),
      /family supervisor/,
    );
    assert.throws(
      () =>
        register(db, actor, {
          ...input,
          waiver_acceptances: [{ ...evidence, signer_id: child.id }],
        }),
      /adult signer/,
    );
    assert.throws(
      () =>
        register(db, actor, {
          ...input,
          waiver_acceptances: [{ ...evidence, waiver_version: 9 }],
        }),
      /waiver changed/,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM invoices").get().n, 0);
    const reg = register(db, actor, {
      ...input,
      waiver_acceptances: [evidence],
    });
    assert.ok(reg.waiver_accepted_at);
    saveForm(db, actor, scope, {
      ...form,
      waivers: [
        {
          ...waiver,
          content: "<p>New fictional text</p><script>bad()</script>",
        },
      ],
    });
    const updated = getForm(db, actor.org_id, scope);
    assert.equal(updated.waivers[0].version, 2);
    assert.doesNotMatch(updated.waivers[0].content, /<script|bad\(/);
    const record = db
      .prepare("SELECT * FROM waiver_acceptances WHERE registration_id=?")
      .get(reg.id);
    assert.equal(record.method, "Admin recorded");
    assert.equal(record.recorded_by, actor.id);
    assert.equal(record.signer_id, parent.id);
    assert.equal(JSON.parse(record.document).content, waiver.content);
  } finally {
    db.close();
  }
});
test("field applicability handles children, staff assignments and member visibility", () => {
  const { db, actor, child, parent, field } = fixture();
  try {
    const fields = [
      field,
      {
        ...field,
        id: randomUUID(),
        name: "Staff note",
        apply: "Always",
        managed_by_staff: true,
      },
      { ...field, id: randomUUID(), name: "Adult field", apply: "Adults" },
      {
        ...field,
        id: randomUUID(),
        name: "Private admin note",
        apply: "Always",
        visibility: "Admin Only",
      },
      {
        ...field,
        id: randomUUID(),
        name: "Coach question",
        apply: "Always",
        roles: ["Program Staff"],
        staff_roles: ["Coach"],
      },
    ];
    saveForm(db, actor, "site", { version: 1, fields });
    const form = getForm(db, actor.org_id);
    assert.deepEqual(
      applicableFields(form, child, "Free Agent", "2026-09-07", {
        member: true,
      }).fields.map((f) => f.name),
      [field.name],
    );
    assert.deepEqual(
      applicableFields(form, parent, "Free Agent", "2026-09-07", {
        member: true,
      }).fields.map((f) => f.name),
      ["Adult field"],
    );
    const captain = applicableFields(form, parent, "Captain", "2026-09-07");
    assert.equal(
      captain.fields.some((f) => f.name === "Coach question"),
      false,
    );
    assert.equal(
      applicableFields(form, parent, "Coach", "2026-09-07").fields.some(
        (f) => f.name === "Coach question",
      ),
      true,
    );
  } finally {
    db.close();
  }
});

test("form attachments validate type, download as attachments, and stay organization-scoped", async () => {
  const { db, actor, base, child, parent, waiver } = fixture();
  for (const org of ["org", "foreign"])
    db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
      org,
      org,
      "Admin",
      `${org}@example.com`,
      passwordHash("test-password"),
      "owner",
    );
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  const login = async (org) => {
    const response = await fetch(root + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
      },
      body: JSON.stringify({
        email: `${org}@example.com`,
        password: "test-password",
      }),
    });
    return response.headers.get("set-cookie").split(";")[0];
  };
  try {
    const cookie = await login("org"),
      foreign = await login("foreign");
    const headers = {
      Cookie: cookie,
      "X-Fieldhouse-Request": "1",
      "Content-Type": "application/pdf",
      "X-File-Name": "sample%20document.pdf",
    };
    assert.equal(
      (
        await fetch(root + "/api/form-files", {
          method: "POST",
          headers,
          body: "<html>Not a PDF</html>",
        })
      ).status,
      400,
    );
    const response = await fetch(root + "/api/form-files", {
      method: "POST",
      headers,
      body: "%PDF-1.7\nFictional verification fixture\n%%EOF",
    });
    assert.equal(response.status, 201);
    const file = await response.json();
    assert.equal(file.name, "sample document.pdf");
    const download = await fetch(root + `/api/form-files/${file.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /^attachment;/);
    assert.match(download.headers.get("content-type"), /application\/pdf/);
    assert.equal(
      (await fetch(root + `/api/form-files/${file.id}`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(root + `/api/form-files/${file.id}`, {
          headers: { Cookie: foreign },
        })
      ).status,
      404,
    );
    const f = {
      id: randomUUID(),
      name: "Supporting file",
      type: "File Upload",
      required: true,
    };
    saveForm(db, actor, "site", { version: 1, fields: [f] });
    const program = saveProgram(db, actor, base);
    const input = {
      program_id: program.id,
      person_id: child.id,
      form_version: 1,
    };
    assert.throws(
      () =>
        register(db, actor, { ...input, answers: { [f.id]: "not-a-file" } }),
      /Upload a file/,
    );
    db.prepare(
      "INSERT INTO form_files VALUES('foreign-file','foreign','other.txt','text/plain',?,'2026-01-01')",
    ).run(Buffer.from("Other organization"));
    assert.throws(
      () =>
        register(db, actor, { ...input, answers: { [f.id]: "foreign-file" } }),
      /Upload a file/,
    );
    const reg = register(db, actor, { ...input, answers: { [f.id]: file.id } });
    const saved = JSON.parse(
      db
        .prepare(
          "SELECT answers FROM registration_answers WHERE registration_id=?",
        )
        .get(reg.id).answers,
    );
    assert.equal(saved[f.id], file.id);
    const profile = saveForm(db, actor, "profile", { version: 1, fields: [f] });
    const profileResponse = await fetch(root + `/api/people/${child.id}`, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "X-Fieldhouse-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...child,
        profile_form_version: profile.version,
        profile_record_version: 0,
        profile_answers: { [f.id]: file.id },
      }),
    });
    assert.equal(profileResponse.status, 200);
    for (const path of [
      `/api/profile-form?person_id=${child.id}`,
      `/api/people/${child.id}/profile-answers`,
    ]) {
      assert.equal(
        (await fetch(root + path, { headers: { Cookie: cookie } })).status,
        200,
      );
      assert.equal(
        (await fetch(root + path, { headers: { Cookie: foreign } })).status,
        404,
      );
      assert.equal((await fetch(root + path)).status, 401);
    }
    const history = await (
      await fetch(root + `/api/people/${child.id}/profile-answers`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(history.revisions[0].answers[f.id], file.id);
    const withWaiver = saveForm(db, actor, `program:${program.id}`, {
      ...getForm(db, actor.org_id, `program:${program.id}`),
      waivers: [waiver],
    });
    const adultRegistration = register(db, actor, {
      program_id: program.id,
      person_id: parent.id,
      form_version: withWaiver.version,
      answers: { [f.id]: file.id },
      waiver_acceptances: [
        { waiver_id: waiver.id, waiver_version: 1, signer_id: parent.id },
      ],
    });
    const member = await (
      await fetch(root + `/api/people/${parent.id}`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(member.waivers[0].registration_id, adultRegistration.id);
    assert.equal(member.waivers[0].name, waiver.name);
    assert.equal(member.waivers[0].waiver_version, 1);
    assert.equal(member.waivers[0].signer_name, "Adult Guardian");
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

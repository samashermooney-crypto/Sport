import {
  getMemberProperties,
  saveMemberProperties,
  memberCompletion,
} from "./member-completion.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, id, now } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { beginMemberSignup, verifyMemberSignup } from "./member-auth.mjs";
import {
  memberProfileForm,
  saveMemberProfile,
  accessibleProfile,
} from "./member-profile.mjs";
import { saveForm, profileFormContext } from "./forms.mjs";
import { savePerson } from "./directory.mjs";

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO organizations(id,name) VALUES('org','Club'),('other','Other')",
  ).run();
  const app = makeApp(db);
  const signup = {
    email: "parent@example.com",
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
  const outsider = verifyMemberSignup(
    db,
    "org",
    beginMemberSignup(db, "org", { ...signup, email: "outsider@example.com" })
      .token,
  );
  const actor = { id: "admin", org_id: "org" };
  const required = id(),
    hidden = id(),
    file = id();
  saveForm(db, actor, "profile", {
    version: 1,
    fields: [
      { id: required, name: "Jersey", type: "Numeric", required: true },
      {
        id: hidden,
        name: "Internal notes",
        type: "Single Text",
        visibility: "Admin Only",
      },
      { id: file, name: "Attachment", type: "File Upload" },
    ],
  });
  const input = {
    ...signup,
    gender: "Unknown",
    profile_answers: { [required]: 12 },
    profile_form_version: 2,
    profile_record_version: 0,
  };
  const household = db
    .prepare("SELECT household_id FROM people WHERE id=?")
    .get(account.person_id).household_id;
  return {
    db,
    app,
    signup,
    account,
    outsider,
    actor,
    required,
    hidden,
    file,
    input,
    household,
  };
}
test("member profile updates require current questions, preserve staff answers, and reject unrelated family access", () => {
  const f = fixture(),
    { db, account, input, actor, required, hidden, outsider } = f;
  try {
    const current = accessibleProfile(db, account, account.person_id);
    savePerson(
      db,
      actor,
      {
        ...current,
        notes: "Staff only",
        profile_form_version: 2,
        profile_record_version: 0,
        profile_answers: { [required]: 10, [hidden]: "Private staff answer" },
      },
      account.person_id,
    );
    const visible = memberProfileForm(db, account, account.person_id);
    assert.equal(
      visible.fields.some((x) => x.id === hidden),
      false,
    );
    assert.equal(visible.answers[hidden], undefined);
    assert.throws(
      () =>
        saveMemberProfile(
          db,
          account,
          { ...input, profile_record_version: 1, profile_answers: {} },
          account.person_id,
        ),
      /Jersey/,
    );
    assert.throws(() =>
      saveMemberProfile(
        db,
        account,
        {
          ...input,
          profile_record_version: 1,
          profile_answers: { [hidden]: "forged", [required]: 12 },
        },
        account.person_id,
      ),
    );
    const saved = saveMemberProfile(
      db,
      account,
      {
        ...input,
        profile_record_version: 1,
        notes: "overwritten",
        kind: "staff",
        email: "changed@example.com",
        household_role: "Member",
      },
      account.person_id,
    );
    assert.equal(saved.email, "parent@example.com");
    assert.equal(saved.kind, "parent");
    assert.equal("notes" in saved, false);
    assert.equal(
      accessibleProfile(db, account, account.person_id).notes,
      "Staff only",
    );
    assert.equal(
      profileFormContext(db, actor, account.person_id).answers[hidden],
      "Private staff answer",
    );
    assert.throws(
      () => saveMemberProfile(db, account, input, account.person_id),
      /updated elsewhere/,
    );
    assert.throws(
      () => memberProfileForm(db, outsider, account.person_id),
      /not found/,
    );
    assert.throws(
      () => saveMemberProfile(db, outsider, input, account.person_id),
      /not found/,
    );
  } finally {
    db.close();
  }
});
test("adding children is atomic, family-scoped, and cannot promote roles or link an existing person", () => {
  const { db, account, outsider, input, household } = fixture();
  try {
    const child = {
      ...input,
      birthdate: "2015-04-10",
      first_name: "Riley",
      household_id: household,
    };
    const before = db.prepare("SELECT count(*) n FROM people").get().n;
    assert.throws(() =>
      saveMemberProfile(db, account, { ...child, profile_answers: {} }),
    );
    assert.equal(db.prepare("SELECT count(*) n FROM people").get().n, before);
    assert.throws(
      () => saveMemberProfile(db, outsider, child),
      /family you manage/,
    );
    assert.throws(
      () =>
        saveMemberProfile(db, account, { ...child, birthdate: "1980-01-01" }),
      /under 18/,
    );
    const result = saveMemberProfile(db, account, {
      ...child,
      person_id: outsider.person_id,
      kind: "parent",
      household_role: "Supervisor",
    });
    assert.notEqual(result.id, outsider.person_id);
    assert.equal(result.kind, "player");
    assert.equal(result.email, "");
    assert.equal(
      db
        .prepare("SELECT role FROM household_members WHERE person_id=?")
        .get(result.id).role,
      "Member",
    );
    assert.equal(accessibleProfile(db, account, result.id).first_name, "Riley");
  } finally {
    db.close();
  }
});
test("member HTTP profile files require ownership or an accessible visible family answer", async () => {
  const { db, app, signup, account, outsider, input, file, actor } = fixture();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/member/org`;
  const request = (path, method = "GET", body, cookie = "", extra = {}) =>
    fetch(root + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
        cookie,
        ...extra,
      },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
  try {
    const cookie = (await request("/login", "POST", signup)).headers
      .get("set-cookie")
      .split(";")[0];
    const otherCookie = (
      await request("/login", "POST", {
        ...signup,
        email: "outsider@example.com",
      })
    ).headers
      .get("set-cookie")
      .split(";")[0];
    assert.equal((await request(`/profiles/${account.person_id}`)).status, 401);
    assert.equal(
      (
        await request(
          `/profiles/${account.person_id}`,
          "GET",
          undefined,
          otherCookie,
        )
      ).status,
      404,
    );
    const upload = await request(
      "/form-files",
      "POST",
      "Fictional profile attachment",
      cookie,
      { "Content-Type": "text/plain", "X-File-Name": "profile.txt" },
    );
    assert.equal(upload.status, 201);
    const saved = await upload.json();
    assert.equal(
      (await request(`/form-files/${saved.id}`, "GET", undefined, cookie))
        .status,
      200,
    );
    assert.equal(
      (await request(`/form-files/${saved.id}`, "GET", undefined, otherCookie))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          `/profiles/${outsider.person_id}`,
          "PUT",
          {
            ...input,
            profile_answers: { ...input.profile_answers, [file]: saved.id },
          },
          otherCookie,
        )
      ).status,
      403,
    );
    const response = await request(
      `/profiles/${account.person_id}`,
      "PUT",
      {
        ...input,
        profile_answers: { ...input.profile_answers, [file]: saved.id },
      },
      cookie,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await request(`/profiles/${account.person_id}`, "PUT", input, cookie))
        .status,
      409,
    );
    const adminFile = id();
    db.prepare("INSERT INTO form_files VALUES(?,?,?,?,?,?)").run(
      adminFile,
      "org",
      "admin.txt",
      "text/plain",
      Buffer.from("Admin attached file"),
      now(),
    );
    assert.equal(
      (await request(`/form-files/${adminFile}`, "GET", undefined, cookie))
        .status,
      404,
    );
    savePerson(
      db,
      actor,
      {
        ...accessibleProfile(db, account, account.person_id),
        profile_form_version: 2,
        profile_record_version: 1,
        profile_answers: { ...input.profile_answers, [file]: adminFile },
      },
      account.person_id,
    );
    assert.equal(
      (await request(`/form-files/${adminFile}`, "GET", undefined, cookie))
        .status,
      200,
    );
    assert.equal(
      (await request(`/form-files/${adminFile}`, "GET", undefined, otherCookie))
        .status,
      404,
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("profile completion gates member APIs, preserves repair access, and clears after family profiles are complete", async () => {
  const {
    db,
    app,
    account,
    actor,
    input,
    household,
    signup,
    required,
    outsider,
  } = fixture();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/member/org`;
  let cookie = "";
  const request = (path, method = "GET", body) =>
    fetch(root + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
        cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.deepEqual(memberCompletion(db, account), {
      required: false,
      profiles: [],
    });
    saveMemberProperties(db, actor, {
      version: 1,
      require_profile_completion: true,
    });
    assert.equal(
      getMemberProperties(db, "other").require_profile_completion,
      false,
    );
    assert.throws(
      () =>
        saveMemberProperties(db, actor, {
          version: 1,
          require_profile_completion: false,
        }),
      /changed/,
    );
    assert.equal(
      memberCompletion(db, account).profiles[0].missing.includes("Jersey"),
      true,
    );
    assert.equal((await request("/profile-completion")).status, 401);
    cookie = (await request("/login", "POST", signup)).headers
      .get("set-cookie")
      .split(";")[0];
    const blocked = await request("/invoices");
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, "PROFILE_COMPLETION_REQUIRED");
    assert.equal((await request("/family")).status, 200);
    assert.equal((await request(`/profiles/${account.person_id}`)).status, 200);
    assert.equal(
      (await request(`/profiles/${account.person_id}`, "PUT", input)).status,
      200,
    );
    assert.equal((await request("/invoices")).status, 200);
    const child = saveMemberProfile(db, account, {
      ...input,
      first_name: "Riley",
      birthdate: "2015-04-10",
      household_id: household,
    });
    db.prepare("DELETE FROM profile_answers WHERE person_id=?").run(child.id);
    const incomplete = memberCompletion(db, account);
    assert.deepEqual(
      incomplete.profiles.map((p) => p.id),
      [child.id],
    );
    assert.equal(
      incomplete.profiles.some((p) => p.id === outsider.person_id),
      false,
    );
    assert.equal((await request("/invoices")).status, 403);
    assert.equal((await request("/registrations", "POST", {})).status, 403);
    saveMemberProfile(
      db,
      account,
      {
        ...input,
        first_name: "Riley",
        birthdate: "2015-04-10",
        profile_record_version: 1,
      },
      child.id,
    );
    assert.equal(memberCompletion(db, account).required, false);
    assert.equal((await request("/invoices")).status, 200);
    saveMemberProperties(db, actor, {
      version: 2,
      require_profile_completion: false,
    });
    db.prepare("DELETE FROM profile_answers WHERE person_id=?").run(
      account.person_id,
    );
    assert.equal((await request("/invoices")).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("required member addresses validate signup and profile writes without losing existing data", () => {
  const { db, account, actor, input, signup } = fixture();
  try {
    saveMemberProperties(db, actor, {
      version: 1,
      require_profile_completion: true,
      require_address: true,
    });
    assert.throws(
      () =>
        beginMemberSignup(db, "org", {
          ...signup,
          email: "address@example.com",
        }),
      /member address/,
    );
    assert.throws(
      () =>
        saveMemberProfile(
          db,
          account,
          {
            ...input,
            address: "   ",
            city: "Town",
            state: "ST",
            postal: "12345",
          },
          account.person_id,
        ),
      /Address/,
    );
    assert.equal(
      memberProfileForm(db, account, account.person_id).record_version,
      0,
    );
    const address = {
      address: "123 Fictional Lane",
      city: "Example City",
      state: "IL",
      postal: "60000",
    };
    saveMemberProfile(db, account, { ...input, ...address }, account.person_id);
    assert.equal(memberCompletion(db, account).required, false);
    assert.equal(
      accessibleProfile(db, account, account.person_id).address,
      address.address,
    );
    const created = verifyMemberSignup(
      db,
      "org",
      beginMemberSignup(db, "org", {
        ...signup,
        ...address,
        email: "address@example.com",
      }).token,
    );
    assert.equal(
      accessibleProfile(db, created, created.person_id).postal,
      address.postal,
    );
    saveMemberProperties(db, actor, {
      version: 2,
      require_profile_completion: true,
      require_address: false,
    });
    saveMemberProfile(
      db,
      account,
      { ...input, profile_record_version: 1 },
      account.person_id,
    );
    assert.equal(memberCompletion(db, account).required, false);
  } finally {
    db.close();
  }
});

test("mobile collection requirements distinguish adults and children and preserve hidden numbers and consent", () => {
  const { db, account, actor, input, signup, household } = fixture();
  try {
    const settings = {
      version: 1,
      require_profile_completion: true,
      collect_adult_mobile: true,
      require_adult_mobile: true,
      collect_child_mobile: false,
    };
    saveMemberProperties(db, actor, settings);
    assert.throws(
      () =>
        beginMemberSignup(db, "org", {
          ...signup,
          email: "mobile@example.com",
        }),
      /mobile number/,
    );
    assert.throws(
      () => saveMemberProfile(db, account, input, account.person_id),
      /mobile number/,
    );
    const saved = saveMemberProfile(
      db,
      account,
      { ...input, phone: "+1 202-555-0100", sms_opt_in: true },
      account.person_id,
    );
    assert.equal(saved.phone, "+1 202-555-0100");
    assert.equal(
      accessibleProfile(db, account, account.person_id).sms_opt_in,
      false,
    );
    assert.equal(memberCompletion(db, account).required, false);
    const child = saveMemberProfile(db, account, {
      ...input,
      first_name: "Riley",
      birthdate: "2015-04-10",
      household_id: household,
      phone: "+1 202-555-0101",
    });
    assert.equal(child.phone, "");
    saveMemberProperties(db, actor, {
      ...settings,
      version: 2,
      collect_adult_mobile: false,
    });
    const updated = saveMemberProfile(
      db,
      account,
      { ...input, phone: "changed", profile_record_version: 1 },
      account.person_id,
    );
    assert.equal(updated.phone, "+1 202-555-0100");
    const newAccount = verifyMemberSignup(
      db,
      "org",
      beginMemberSignup(db, "org", {
        ...signup,
        email: "mobile@example.com",
        phone: "ignored",
      }).token,
    );
    assert.equal(
      accessibleProfile(db, newAccount, newAccount.person_id).phone,
      "",
    );
    assert.equal(
      accessibleProfile(db, newAccount, newAccount.person_id).sms_opt_in,
      false,
    );
  } finally {
    db.close();
  }
});

test("adult secondary email collection validates requirements without changing login identity", () => {
  const { db, account, actor, input, signup, household } = fixture();
  try {
    const settings = {
      version: 1,
      require_profile_completion: true,
      collect_secondary_email: true,
      require_secondary_email: true,
    };
    saveMemberProperties(db, actor, settings);
    assert.throws(
      () =>
        beginMemberSignup(db, "org", {
          ...signup,
          email: "secondary@example.com",
        }),
      /secondary email/,
    );
    assert.throws(
      () => saveMemberProfile(db, account, input, account.person_id),
      /secondary email/,
    );
    assert.throws(() =>
      saveMemberProfile(
        db,
        account,
        { ...input, secondary_email: "invalid" },
        account.person_id,
      ),
    );
    assert.equal(
      memberCompletion(db, account).profiles[0].missing.includes(
        "Secondary email address",
      ),
      true,
    );
    saveMemberProfile(
      db,
      account,
      { ...input, secondary_email: " Other@Example.com " },
      account.person_id,
    );
    assert.equal(
      accessibleProfile(db, account, account.person_id).secondary_email,
      "other@example.com",
    );
    assert.equal(
      db.prepare("SELECT email FROM member_accounts WHERE id=?").get(account.id)
        .email,
      signup.email,
    );
    assert.equal(memberCompletion(db, account).required, false);
    const child = saveMemberProfile(db, account, {
      ...input,
      birthdate: "2015-04-10",
      household_id: household,
      secondary_email: "ignored@example.com",
    });
    assert.equal(child.secondary_email, "");
    saveMemberProperties(db, actor, {
      ...settings,
      version: 2,
      collect_secondary_email: false,
    });
    saveMemberProfile(
      db,
      account,
      {
        ...input,
        profile_record_version: 1,
        secondary_email: "replacement@example.com",
      },
      account.person_id,
    );
    assert.equal(
      accessibleProfile(db, account, account.person_id).secondary_email,
      "other@example.com",
    );
  } finally {
    db.close();
  }
});

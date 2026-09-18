import test from "node:test";
import { getTerminology } from "./terminology.mjs";
import assert from "node:assert/strict";
import { openDb, passwordHash } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProgram } from "./domain.mjs";
import { beginMemberSignup, verifyMemberSignup } from "./member-auth.mjs";
import {
  initializeWebsites,
  pages,
  savePage,
  removePage,
  restorePage,
  updateMenu,
  theme,
  saveTheme,
  publicPage,
  publicPrograms,
} from "./website.mjs";

function fixture() {
  const db = openDb(":memory:");
  for (const org of ["one", "two"])
    db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(org, org);
  initializeWebsites(db);
  return {
    db,
    actor: { id: "owner", org_id: "one" },
    foreign: { id: "other", org_id: "two" },
  };
}
const input = {
  name: "About our club",
  title: "Our club",
  slug: "about",
  content: "<p>Welcome.</p>",
  published: true,
  menu_enabled: true,
};

test("restricted website pages and images accept member sessions without granting console access", async () => {
  const { db, actor } = fixture();
  const app = makeApp(db);
  const signup = {
    email: "family@example.com",
    password: "Example password 2026!",
    first_name: "Casey",
    last_name: "Example",
    birthdate: "1988-01-01",
  };
  const account = verifyMemberSignup(
    db,
    "one",
    beginMemberSignup(db, "one", signup).token,
  );
  verifyMemberSignup(db, "two", beginMemberSignup(db, "two", signup).token);
  db.prepare("INSERT INTO assets VALUES(?,?,?,?,?)").run(
    "member-image",
    "one",
    "image/png",
    Buffer.from("fictional image"),
    new Date().toISOString(),
  );
  savePage(db, actor, {
    ...input,
    slug: "family-guide",
    requires_login: true,
    content: "<p>Member-only practice guide.</p>",
    mobile_image_id: "member-image",
  });
  savePage(db, actor, {
    ...input,
    slug: "draft-guide",
    requires_login: true,
    published: false,
    content: "Draft secret",
  });
  db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
    "foreign-admin",
    "two",
    "Admin",
    "admin-other@example.com",
    passwordHash("test-password"),
    "owner",
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api`;
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
  const get = (path, cookie = "") =>
    fetch(root + path, { headers: { cookie } });
  const cookieOf = (response) =>
    response.headers.get("set-cookie").split(";")[0];
  try {
    const member = cookieOf(await post("/member/one/login", signup));
    const foreign = cookieOf(await post("/member/two/login", signup));
    const admin = cookieOf(
      await post("/auth/login", {
        email: "admin-other@example.com",
        password: "test-password",
      }),
    );
    const page = "/public/sites/one/pages/family-guide",
      image = "/public/sites/one/assets/member-image";
    assert.equal((await get(page)).status, 401);
    assert.equal((await get(image)).status, 404);
    assert.equal((await get(page, foreign)).status, 401);
    assert.equal((await get(page, admin)).status, 401);
    assert.equal((await get(page, member + "; " + admin)).status, 200);
    const response = await get(page, member);
    assert.match((await response.json()).content, /Member-only practice guide/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal((await get(image, member)).status, 200);
    assert.equal(
      (await get("/public/sites/one/pages/draft-guide", member)).status,
      404,
    );
    assert.equal((await get("/website", member)).status, 401);
    await post("/member/one/logout", {}, member);
    assert.equal((await get(page, member)).status, 401);
    assert.equal((await get(image, member)).status, 404);
    const refreshed = cookieOf(await post("/member/one/login", signup));
    db.prepare(
      "UPDATE people SET data=json_set(data,'$.archived_at',?) WHERE id=?",
    ).run(new Date().toISOString(), account.person_id);
    assert.equal((await get(page, refreshed)).status, 401);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("website saves sanitize content, preserve revisions, and reject stale or foreign edits", () => {
  const { db, actor, foreign } = fixture();
  try {
    const first = savePage(db, actor, {
      ...input,
      content:
        '<p>Welcome.</p><script>secret()</script><a href="javascript:alert(1)">link</a>',
    });
    assert.doesNotMatch(first.content, /script|javascript|secret/);
    const revision = db
      .prepare("SELECT id FROM website_revisions WHERE page_id=? AND version=1")
      .get(first.id);
    const second = savePage(
      db,
      actor,
      { ...first, title: "Updated title", published: false },
      first.id,
    );
    assert.equal(second.version, 2);
    assert.throws(
      () => savePage(db, actor, { ...first, title: "Stale" }, first.id),
      /changed in another/,
    );
    assert.throws(() => savePage(db, foreign, second, first.id), /not found/);
    assert.throws(() => publicPage(db, actor.org_id, "about"), /not found/);
    const restored = restorePage(db, actor, first.id, revision.id, 2);
    assert.equal(restored.version, 3);
    assert.equal(restored.title, input.title);
    assert.equal(restored.published, true);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM website_revisions WHERE page_id=?")
        .get(first.id).n,
      3,
    );
    assert.throws(() =>
      savePage(
        db,
        actor,
        { ...restored, external_url: "javascript:alert(1)" },
        first.id,
      ),
    );
    assert.throws(() =>
      savePage(
        db,
        actor,
        { ...restored, mobile_cta: true, mobile_url: "" },
        first.id,
      ),
    );
    assert.throws(() =>
      savePage(
        db,
        actor,
        { ...restored, mobile_image_id: "other-org-asset" },
        first.id,
      ),
    );
    const home = pages(db, actor.org_id).find((p) => p.kind === "home");
    assert.throws(
      () => savePage(db, actor, { ...home, slug: "other-home" }, home.id),
      /Built-in/,
    );
    assert.throws(
      () => removePage(db, actor, home.id, home.version),
      /Built-in/,
    );
  } finally {
    db.close();
  }
});

test("menu edits are atomic, cannot form cycles, and page removal reparents children", () => {
  const { db, actor, foreign } = fixture();
  try {
    const parent = savePage(db, actor, input),
      child = savePage(db, actor, {
        ...input,
        name: "Child",
        slug: "child",
        menu_parent_id: parent.id,
      });
    assert.throws(
      () =>
        savePage(db, actor, { ...parent, menu_parent_id: child.id }, parent.id),
      /beneath itself/,
    );
    const foreignPage = pages(db, foreign.org_id)[0];
    assert.throws(
      () =>
        savePage(
          db,
          actor,
          { ...parent, menu_parent_id: foreignPage.id },
          parent.id,
        ),
      /not found/,
    );
    const edits = [
      {
        id: parent.id,
        version: 1,
        menu_order: 2,
        menu_label: "Parent",
        menu_enabled: true,
      },
      {
        id: child.id,
        version: 99,
        menu_order: 1,
        menu_label: "Child",
        menu_enabled: true,
      },
    ];
    assert.throws(() => updateMenu(db, actor, edits), /changed in another/);
    assert.equal(
      pages(db, actor.org_id).find((p) => p.id === parent.id).version,
      1,
    );
    edits[1].version = 1;
    updateMenu(db, actor, edits);
    assert.equal(
      pages(db, actor.org_id).find((p) => p.id === parent.id).menu_label,
      "Parent",
    );
    removePage(db, actor, parent.id, 2);
    const updated = pages(db, actor.org_id).find((p) => p.id === child.id);
    assert.equal(updated.menu_parent_id, null);
    assert.equal(updated.version, 3);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM website_revisions WHERE page_id=?")
        .get(parent.id).n,
      0,
    );
  } finally {
    db.close();
  }
});

test("public program serialization excludes hidden programs, hidden parents and private fields", () => {
  const { db, actor } = fixture();
  try {
    const base = {
      name: "Public season",
      type: "League",
      sport: "Soccer",
      season: "Fall",
      gender: "Any gender",
      level: "All levels",
      start_date: "2026-10-01",
      status: "Live",
      registration_password: "PRIVATE-PASSWORD",
      code: "INTERNAL-CODE",
      integration_codes: ["PRIVATE-INTEGRATION"],
      description: "<p>Season information</p><script>bad()</script>",
    };
    saveProgram(db, actor, base);
    saveProgram(db, actor, { ...base, name: "Private", public: false });
    saveProgram(db, actor, { ...base, name: "Draft", status: "Unpublished" });
    const parent = saveProgram(db, actor, {
      ...base,
      name: "Hidden parent",
      grouped: true,
      public: false,
    });
    saveProgram(db, actor, {
      ...base,
      name: "Hidden child",
      parent_id: parent.id,
    });
    const result = publicPrograms(db, actor.org_id);
    assert.equal(result.length, 1);
    assert.equal(result[0].password_required, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE|INTERNAL|password"|<script|bad\(/,
    );
    const settings = theme(db, actor.org_id);
    saveTheme(db, actor, { ...settings, primary: "#123456" });
    assert.equal(theme(db, actor.org_id).primary, "#123456");
    assert.throws(
      () => saveTheme(db, actor, { ...settings, primary: "#654321" }),
      /changed/,
    );
    assert.throws(() =>
      saveTheme(db, actor, { ...settings, primary: "red;display:none" }),
    );
  } finally {
    db.close();
  }
});

test("anonymous website API denies unpublished/restricted content and nonpublic assets", async () => {
  const { db, actor } = fixture();
  for (const org of ["one", "two"])
    db.prepare("INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)").run(
      org,
      org,
      "Admin",
      org + "@example.com",
      passwordHash("test-password"),
      "owner",
    );
  const published = savePage(db, actor, input);
  savePage(db, actor, {
    ...input,
    slug: "unpublished",
    published: false,
    content: "HIDDEN-DRAFT",
  });
  const restricted = savePage(db, actor, {
    ...input,
    slug: "restricted",
    requires_login: true,
    content: "SECRET-CONTENT",
    external_url: "https://example.com/SECRET-DESTINATION",
  });
  db.prepare("INSERT INTO assets VALUES(?,?,?,?,?)").run(
    "image",
    "one",
    "image/png",
    Buffer.from("test"),
    new Date().toISOString(),
  );
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie = "") =>
    fetch(base + "/api" + path, { headers: { Cookie: cookie } });
  const login = async (org) => {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fieldhouse-Request": "1",
      },
      body: JSON.stringify({
        email: org + "@example.com",
        password: "test-password",
      }),
    });
    return response.headers.get("set-cookie").split(";")[0];
  };
  try {
    const listing = await get("/public/sites/one");
    assert.equal(listing.status, 200);
    assert.equal(listing.headers.get("x-frame-options"), "DENY");
    assert.equal(
      (await fetch(base + "/site/one")).headers.get("x-frame-options"),
      "SAMEORIGIN",
    );
    assert.equal(
      (await fetch(base + "/website/pages")).headers.get("x-frame-options"),
      "DENY",
    );
    const body = await listing.json();
    assert.deepEqual(Object.keys(body.terminology).sort(), ["level", "season"]);
    const terminology = getTerminology(db, "one");
    terminology.fields.find((f) => f.key === "season").label = "Session";
    terminology.fields.find((f) => f.key === "level").label = "Ability";
    db.prepare("INSERT INTO settings VALUES(?,'site','terminology',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value")
      .run("one", JSON.stringify(terminology));
    assert.deepEqual((await (await get("/public/sites/one")).json()).terminology, {season: "Session", level: "Ability"});
    assert.equal((await (await get("/public/sites/two")).json()).terminology.season, "Season");
    assert.equal(
      body.pages.some((p) => p.slug === "unpublished"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(body), /SECRET|HIDDEN|content|snapshot/);
    assert.equal((await get("/public/sites/one/pages/about")).status, 200);
    assert.equal(
      (await get("/public/sites/one/pages/unpublished")).status,
      404,
    );
    assert.equal((await get("/public/sites/one/pages/restricted")).status, 401);
    assert.equal((await get("/public/sites/one/assets/image")).status, 404);
    const owner = await login("one"),
      foreign = await login("two");
    assert.equal(
      (await get("/public/sites/one/pages/restricted", owner)).status,
      200,
    );
    assert.equal(
      (await get("/public/sites/one/pages/restricted", foreign)).status,
      401,
    );
    assert.equal(
      (await get("/website/pages/" + published.id, foreign)).status,
      404,
    );
    assert.equal((await get("/website/pages/" + published.id)).status, 401);
    const withImage = savePage(
      db,
      actor,
      { ...restricted, mobile_image_id: "image" },
      restricted.id,
    );
    assert.equal((await get("/public/sites/one/assets/image")).status, 404);
    assert.equal(
      (await get("/public/sites/one/assets/image", owner)).status,
      200,
    );
    savePage(db, actor, { ...withImage, requires_login: false }, restricted.id);
    assert.equal((await get("/public/sites/one/assets/image")).status, 200);
    assert.equal((await get("/public/sites/two/assets/image")).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

import { memberRequestSession } from "./member-auth.mjs";
import { websiteTeamRoster } from "./roster-visibility.mjs";
import { registrationAvailability } from "./registration-availability.mjs";
import { getTerminology } from "./terminology.mjs";
import { z } from "zod";
import { id, now, transaction, audit, unpack } from "./db.mjs";
import { DomainError } from "./domain.mjs";
import { cleanHtml } from "./html.mjs";
import { programStandings } from "./standings.mjs";

const safeLink = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    if (/^\/(?!\/)/.test(value) && !/[\\\r\n\t]/.test(value)) return true;
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use an http(s) URL or a path beginning with /.");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const pageSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    external_url: safeLink.default(""),
    published: z.boolean().default(false),
    requires_login: z.boolean().default(false),
    menu_enabled: z.boolean().default(false),
    menu_label: z.string().trim().max(100).default(""),
    menu_parent_id: z.string().nullable().default(null),
    menu_order: z.number().int().min(0).max(10000).default(0),
    content: z.string().max(100000).default(""),
    meta_description: z.string().max(320).default(""),
    meta_keywords: z.string().max(500).default(""),
    template: z
      .enum(["Standard", "Home Page", "FAQ", "Team Roster"])
      .default("Standard"),
    mobile_intro: z.string().max(160).default(""),
    mobile_summary: z.string().max(500).default(""),
    mobile_cta: z.boolean().default(false),
    mobile_url: safeLink.default(""),
    mobile_image_id: z.string().default(""),
    version: z.number().int().positive().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.mobile_cta && (!p.mobile_url || !p.mobile_intro))
      ctx.addIssue({
        code: "custom",
        message: "The mobile button needs text and a destination",
        path: ["mobile_url"],
      });
  });
const themeSchema = z.object({
  primary: color.default("#3a67b2"),
  secondary: color.default("#252b2e"),
  facebook: safeLink.default(""),
  instagram: safeLink.default(""),
  x: safeLink.default(""),
  registration_filters: z.boolean().default(true),
  version: z.number().int().positive().optional(),
});
const defaults = [
  ["Homepage", "home", "home"],
  ["Leagues", "leagues", "League"],
  ["Tournaments", "tournaments", "Tournament"],
  ["Events", "events", "Event"],
  ["Club Teams", "clubs", "Club team"],
  ["Camps", "camps", "Camp"],
  ["Classes", "classes", "Class"],
  ["Calendar", "calendar", "calendar"],
  ["Blog", "blog", "blog"],
  ["Locations", "locations", "locations"],
  ["Store", "store", "store"],
  ["Terms of Service", "terms", "terms"],
  ["Privacy Policy", "privacy", "privacy"],
];
export function initializeWebsites(db) {
  for (const org of db.prepare("SELECT id,name FROM organizations").all()) {
    if (db.prepare("SELECT 1 FROM website_settings WHERE org_id=?").get(org.id))
      continue;
    transaction(db, () => {
      db.prepare("INSERT INTO website_settings(org_id,data) VALUES(?,?)").run(
        org.id,
        JSON.stringify(themeSchema.parse({})),
      );
      defaults.forEach(([name, slug, kind], index) => {
        const pageId = id(),
          timestamp = now();
        const visible = !["terms", "privacy", "blog"].includes(kind);
        db.prepare(
          "INSERT INTO website_pages(id,org_id,name,title,slug,kind,published,menu_enabled,menu_label,menu_order,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          pageId,
          org.id,
          name,
          kind === "home" ? org.name : name,
          slug,
          kind,
          +visible,
          +visible,
          kind === "home" ? "Home" : name,
          index + 1,
          JSON.stringify({
            content:
              kind === "home"
                ? "<h2>Find your next season.</h2><p>Explore programs, schedules, and opportunities to play.</p>"
                : "",
            template: kind === "home" ? "Home Page" : "Standard",
          }),
          timestamp,
          timestamp,
        );
        saveRevision(db, { org_id: org.id }, pageId);
      });
    });
  }
}
export function pages(db, org) {
  return db
    .prepare(
      "SELECT * FROM website_pages WHERE org_id=? ORDER BY menu_order,name",
    )
    .all(org)
    .map(pageView);
}
function pageView(row) {
  if (!row) return null;
  const p = unpack(row);
  return {
    ...pageSchema.parse({
      ...p,
      published: !!p.published,
      requires_login: !!p.requires_login,
      menu_enabled: !!p.menu_enabled,
    }),
    id: p.id,
    org_id: p.org_id,
    kind: p.kind,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
function getPage(db, org, pageId) {
  const row = db
    .prepare("SELECT * FROM website_pages WHERE id=? AND org_id=?")
    .get(pageId, org);
  if (!row) throw new DomainError("Page not found", 404);
  return pageView(row);
}
function saveRevision(db, actor, pageId) {
  const page = getPage(db, actor.org_id, pageId);
  db.prepare("INSERT INTO website_revisions VALUES(?,?,?,?,?,?,?)").run(
    id(),
    actor.org_id,
    pageId,
    page.version,
    JSON.stringify(page),
    actor.id ?? null,
    now(),
  );
}
function checkVersion(previous, version) {
  if (previous.version !== version)
    throw new DomainError(
      "This page changed in another session. Reload before saving.",
      409,
    );
}
function checkParent(db, org, parentId, pageId) {
  const seen = new Set([pageId]);
  while (parentId) {
    if (seen.has(parentId))
      throw new DomainError("A menu item cannot be nested beneath itself.");
    seen.add(parentId);
    parentId = getPage(db, org, parentId).menu_parent_id;
  }
}
function checkImage(db, org, imageId) {
  if (
    imageId &&
    !db
      .prepare("SELECT 1 FROM assets WHERE id=? AND org_id=?")
      .get(imageId, org)
  )
    throw new DomainError("Choose an image belonging to this organization.");
}
function writePage(db, actor, input, existingId) {
  const p = pageSchema.parse(input),
    before = existingId ? getPage(db, actor.org_id, existingId) : null;
  const pageId = existingId || id(),
    timestamp = now();
  if (before) {
    checkVersion(before, p.version);
    if (before.kind !== "custom" && (before.slug !== p.slug || p.external_url))
      throw new DomainError(
        "Built-in page addresses cannot be changed or redirected.",
      );
  }
  checkParent(db, actor.org_id, p.menu_parent_id, pageId);
  checkImage(db, actor.org_id, p.mobile_image_id);
  const {
    content,
    meta_description,
    meta_keywords,
    template,
    mobile_intro,
    mobile_summary,
    mobile_cta,
    mobile_url,
    mobile_image_id,
  } = p;
  const data = JSON.stringify({
    content: cleanHtml(content),
    meta_description,
    meta_keywords,
    template,
    mobile_intro,
    mobile_summary: cleanHtml(mobile_summary),
    mobile_cta,
    mobile_url,
    mobile_image_id,
  });
  const fields = [
    p.name,
    p.title,
    p.slug,
    p.external_url,
    +p.published,
    +p.requires_login,
    +p.menu_enabled,
    p.menu_label,
    p.menu_parent_id,
    p.menu_order,
    data,
    timestamp,
  ];
  if (before)
    db.prepare(
      "UPDATE website_pages SET name=?,title=?,slug=?,external_url=?,published=?,requires_login=?,menu_enabled=?,menu_label=?,menu_parent_id=?,menu_order=?,data=?,updated_at=?,version=version+1 WHERE id=? AND org_id=?",
    ).run(...fields, pageId, actor.org_id);
  else
    db.prepare(
      "INSERT INTO website_pages(name,title,slug,external_url,published,requires_login,menu_enabled,menu_label,menu_parent_id,menu_order,data,updated_at,id,org_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(...fields, pageId, actor.org_id, timestamp);
  saveRevision(db, actor, pageId);
  audit(
    db,
    actor,
    before ? "page.updated" : "page.created",
    "website_page",
    pageId,
    { version: (before?.version ?? 0) + 1 },
  );
  return getPage(db, actor.org_id, pageId);
}
export function savePage(db, actor, input, existingId) {
  return transaction(db, () => writePage(db, actor, input, existingId));
}
export function restorePage(db, actor, pageId, revisionId, version) {
  return transaction(db, () => {
    const before = getPage(db, actor.org_id, pageId);
    checkVersion(before, version);
    const revision = db
      .prepare(
        "SELECT * FROM website_revisions WHERE id=? AND page_id=? AND org_id=?",
      )
      .get(revisionId, pageId, actor.org_id);
    if (!revision) throw new DomainError("Revision not found", 404);
    const result = writePage(
      db,
      actor,
      { ...JSON.parse(revision.snapshot), version },
      pageId,
    );
    audit(db, actor, "page.restored", "website_page", pageId, {
      from_version: revision.version,
    });
    return result;
  });
}
export function removePage(db, actor, pageId, version) {
  return transaction(db, () => {
    const page = getPage(db, actor.org_id, pageId);
    checkVersion(page, version);
    if (page.kind !== "custom")
      throw new DomainError("Built-in pages cannot be deleted.");
    for (const child of db
      .prepare(
        "SELECT id FROM website_pages WHERE org_id=? AND menu_parent_id=?",
      )
      .all(actor.org_id, pageId)) {
      db.prepare(
        "UPDATE website_pages SET menu_parent_id=NULL,version=version+1,updated_at=? WHERE id=?",
      ).run(now(), child.id);
      saveRevision(db, actor, child.id);
    }
    db.prepare("DELETE FROM website_pages WHERE id=? AND org_id=?").run(
      pageId,
      actor.org_id,
    );
    audit(db, actor, "page.deleted", "website_page", pageId, {
      name: page.name,
    });
    return { ok: true };
  });
}
export function updateMenu(db, actor, input) {
  const edits = z
    .array(
      z.object({
        id: z.string(),
        version: z.number().int(),
        menu_order: z.number().int().min(0).max(10000),
        menu_label: z.string().trim().min(1).max(100),
        menu_enabled: z.boolean(),
      }),
    )
    .max(500)
    .parse(input);
  if (new Set(edits.map((e) => e.id)).size !== edits.length)
    throw new DomainError("A menu item was included twice.");
  return transaction(db, () => {
    for (const edit of edits) {
      const page = getPage(db, actor.org_id, edit.id);
      checkVersion(page, edit.version);
      writePage(db, actor, { ...page, ...edit }, edit.id);
    }
    return pages(db, actor.org_id);
  });
}
export function theme(db, org) {
  const row = db
    .prepare("SELECT * FROM website_settings WHERE org_id=?")
    .get(org);
  if (!row) throw new DomainError("Website not found", 404);
  return { ...themeSchema.parse(JSON.parse(row.data)), version: row.version };
}
export function saveTheme(db, actor, input) {
  const p = themeSchema.parse(input);
  return transaction(db, () => {
    const before = theme(db, actor.org_id);
    if (before.version !== p.version)
      throw new DomainError(
        "Website settings changed. Reload before saving.",
        409,
      );
    db.prepare(
      "UPDATE website_settings SET data=?,version=version+1 WHERE org_id=?",
    ).run(JSON.stringify(p), actor.org_id);
    audit(db, actor, "website.theme.updated", "organization", actor.org_id);
    return theme(db, actor.org_id);
  });
}

const publicMetadata = (p) => ({
  id: p.id,
  name: p.name,
  title: p.title,
  slug: p.slug,
  kind: p.kind,
  requires_login: p.requires_login,
  menu_enabled: p.menu_enabled,
  menu_label: p.menu_label,
  menu_parent_id: p.menu_parent_id,
  menu_order: p.menu_order,
});
export function publicPrograms(db, org) {
  const timezone = db.prepare("SELECT timezone FROM organizations WHERE id=?").get(org)?.timezone || "UTC";
  return db
    .prepare(
      "SELECT p.* FROM programs p LEFT JOIN programs parent ON parent.id=p.parent_id WHERE p.org_id=? AND p.public=1 AND p.status!='Unpublished' AND p.archived_at IS NULL AND (p.parent_id IS NULL OR (parent.public=1 AND parent.status!='Unpublished' AND parent.archived_at IS NULL)) ORDER BY p.start_date,p.name",
    )
    .all(org)
    .map((row) => {
      const p = unpack(row);
      return {
        id: p.id,
        parent_id: p.parent_id,
        name: p.name,
        type: p.type,
        sport: p.sport,
        season: p.season,
        gender: p.gender,
        level: p.level,
        status: p.status,
        grouped: !!p.grouped,
        start_date: p.start_visible === false ? "" : p.start_date,
        end_date: p.end_visible === false ? "" : p.end_date,
        registration_start: p.registration_start,
        registration_end: p.registration_end,
        fee_cents: p.fee_cents,
        description: cleanHtml(p.description || ""),
        registration_status: p.registration_status || "",
        registration_availability: registrationAvailability(p, timezone),
        location_id: p.location_id || "",
        password_required: !!p.registration_password,
      };
    });
}
export function publicCalendar(db, org) {
  const visible = new Set(publicPrograms(db, org).map((p) => p.id));
  return db
    .prepare(
      "SELECT e.id,e.program_id,e.title,e.type,e.start_at,e.end_at,e.state,e.home_score,e.away_score,e.location_id,e.data,h.name home_team,h.program_id home_program_id,a.name away_team,a.program_id away_program_id,l.name location FROM events e LEFT JOIN teams h ON h.id=e.home_team_id LEFT JOIN teams a ON a.id=e.away_team_id LEFT JOIN locations l ON l.id=e.location_id WHERE e.org_id=? AND e.published=1 ORDER BY e.start_at",
    )
    .all(org)
    .filter(
      (e) =>
        visible.has(e.program_id) &&
        (!e.home_program_id || visible.has(e.home_program_id)) &&
        (!e.away_program_id || visible.has(e.away_program_id)),
    )
    .map(({ data, home_program_id, away_program_id, ...event }) => {
      const result = JSON.parse(data || "{}");
      return {
        ...event,
        game_type: result.game_type || "Regular Season",
        overtime: result.overtime === true,
        forfeit: result.forfeit || "None",
        match_scores: (result.match_scores || []).map(({ home, away }) => ({
          home,
          away,
        })),
      };
    });
}
export function publicPage(db, org, slug, actor) {
  const p = pages(db, org).find((p) => p.slug === slug && p.published);
  if (!p) throw new DomainError("Page not found", 404);
  if (p.requires_login && actor?.org_id !== org)
    throw new DomainError(
      "Sign in to this organization to view this page.",
      401,
    );
  return {
    ...publicMetadata(p),
    external_url: p.external_url,
    content: p.content,
    meta_description: p.meta_description,
    meta_keywords: p.meta_keywords,
    template: p.template,
    mobile_intro: p.mobile_intro,
    mobile_summary: p.mobile_summary,
    mobile_cta: p.mobile_cta,
    mobile_url: p.mobile_url,
    mobile_image_id: p.mobile_image_id,
  };
}
export function installPublicWebsiteRoutes(app, db) {
  initializeWebsites(db);
  app.get("/api/public/sites/:org/teams/:teamId/roster", (req, res) => {
    res.set("Cache-Control", "no-store").json(websiteTeamRoster(db, req.params.org, req.params.teamId,
      memberRequestSession(db, req, req.params.org)));
  });
  app.use("/api/public/sites/:org", (req, res, next) => {
    req.websiteActor =
      req.actor?.org_id === req.params.org
        ? req.actor
        : memberRequestSession(db, req, req.params.org);
    next();
  });
  app.get("/api/public/sites/:org", (req, res) => {
    const organization = db
      .prepare("SELECT id,name,timezone,currency FROM organizations WHERE id=?")
      .get(req.params.org);
    if (!organization) throw new DomainError("Website not found", 404);
    const t = theme(db, organization.id);
    res.json({
      organization,
      terminology: Object.fromEntries(
        getTerminology(db, organization.id).fields
          .filter((field) => ["season", "level"].includes(field.key))
          .map((field) => [field.key, field.label]),
      ),
      theme: {
        primary: t.primary,
        secondary: t.secondary,
        facebook: t.facebook,
        instagram: t.instagram,
        x: t.x,
        registration_filters: t.registration_filters,
      },
      pages: pages(db, organization.id)
        .filter((p) => p.published)
        .map(publicMetadata),
    });
  });
  app.get("/api/public/sites/:org/pages/:slug", (req, res) =>
    res.json(publicPage(db, req.params.org, req.params.slug, req.websiteActor)),
  );
  app.get("/api/public/sites/:org/programs", (req, res) =>
    res.json(publicPrograms(db, req.params.org)),
  );
  app.get("/api/public/sites/:org/programs/:id/standings", (req, res) => {
    const visible = new Set(
      publicPrograms(db, req.params.org).map((p) => p.id),
    );
    if (!visible.has(req.params.id))
      throw new DomainError("Program not found", 404);
    res.json(
      programStandings(db, req.params.org, req.params.id, {
        publicOnly: true,
        visibleProgramIds: visible,
      }),
    );
  });
  app.get("/api/public/sites/:org/calendar", (req, res) =>
    res.json(publicCalendar(db, req.params.org)),
  );
  app.get("/api/public/sites/:org/locations", (req, res) => {
    const locations = new Set(
      [
        ...publicPrograms(db, req.params.org),
        ...publicCalendar(db, req.params.org),
      ]
        .map((e) => e.location_id)
        .filter(Boolean),
    );
    res.json(
      db
        .prepare(
          "SELECT id,name,address,parent_id FROM locations WHERE org_id=? ORDER BY name",
        )
        .all(req.params.org)
        .filter((l) => locations.has(l.id)),
    );
  });
  app.get("/api/public/sites/:org/assets/:id", (req, res) => {
    const referenced = pages(db, req.params.org).some(
      (p) =>
        p.published &&
        (!p.requires_login || req.websiteActor?.org_id === req.params.org) &&
        p.mobile_image_id === req.params.id,
    );
    const asset =
      referenced &&
      db
        .prepare("SELECT mime,bytes FROM assets WHERE id=? AND org_id=?")
        .get(req.params.id, req.params.org);
    if (!asset) throw new DomainError("Image not found", 404);
    res
      .type(asset.mime)
      .set("Content-Security-Policy", "default-src 'none'")
      .send(Buffer.from(asset.bytes));
  });
}
export function installWebsiteRoutes(app, db) {
  app.get("/api/website", (req, res) =>
    res.json({
      org_id: req.actor.org_id,
      pages: pages(db, req.actor.org_id),
      theme: theme(db, req.actor.org_id),
    }),
  );
  app.post("/api/website/pages", (req, res) =>
    res.status(201).json(savePage(db, req.actor, req.body)),
  );
  app.get("/api/website/pages/:id", (req, res) =>
    res.json(getPage(db, req.actor.org_id, req.params.id)),
  );
  app.put("/api/website/pages/:id", (req, res) =>
    res.json(savePage(db, req.actor, req.body, req.params.id)),
  );
  app.delete("/api/website/pages/:id", (req, res) =>
    res.json(removePage(db, req.actor, req.params.id, req.body.version)),
  );
  app.get("/api/website/pages/:id/revisions", (req, res) => {
    getPage(db, req.actor.org_id, req.params.id);
    res.json(
      db
        .prepare(
          "SELECT id,version,created_at FROM website_revisions WHERE page_id=? AND org_id=? ORDER BY version DESC LIMIT 100",
        )
        .all(req.params.id, req.actor.org_id),
    );
  });
  app.post("/api/website/pages/:id/restore", (req, res) =>
    res.json(
      restorePage(
        db,
        req.actor,
        req.params.id,
        req.body.revision_id,
        req.body.version,
      ),
    ),
  );
  app.put("/api/website/menu", (req, res) =>
    res.json(updateMenu(db, req.actor, req.body)),
  );
  app.put("/api/website/theme", (req, res) =>
    res.json(saveTheme(db, req.actor, req.body)),
  );
}

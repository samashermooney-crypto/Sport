import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { id, now, transaction, audit, unpack } from "./db.mjs";
import { DomainError, requireEntity } from "./domain.mjs";

import { cleanHtml } from "./html.mjs";
export { cleanHtml } from "./html.mjs";
const array = () => z.array(z.string()).max(500).default([]);
export const targetSchema = z.object({
  group: z.enum(["site", "programs", "teams", "admins"]).default("site"),
  members: z.boolean().default(true),
  contacts: z.boolean().default(false),
  person_ids: array(),
  team_ids: array(),
  program_ids: array(),
  program_states: z.array(z.string()).default(["Upcoming", "Live"]),
  sports: array(),
  seasons: array(),
  exclude_programs: z.boolean().default(false),
  gender: z.string().default(""),
  roles: z
    .array(z.string())
    .default([
      "Team Captain",
      "Team Player",
      "Free Agent",
      "Captain",
      "Coach",
      "Volunteer",
    ]),
  statuses: z.array(z.string()).default(["Confirmed", "Pending", "Wait List"]),
  payment: z.enum(["", "None", "Owes", "Paid"]).default(""),
  waiver: z.enum(["", "Accepted", "Not accepted"]).default(""),
  city: z.string().trim().max(100).default(""),
  by_games: z.boolean().default(false),
  game_from: z
    .union([z.iso.datetime({ offset: true }), z.literal("")])
    .default(""),
  game_to: z
    .union([z.iso.datetime({ offset: true }), z.literal("")])
    .default(""),
  location_ids: array(),
  game_types: array(),
  include_admins: z.boolean().default(false),
  newsletter: z.boolean().default(false),
  copy_self: z.boolean().default(false),
});
export function getMessageSettings(db, orgId) {
  const row = db
    .prepare(
      "SELECT value FROM settings WHERE org_id=? AND scope='site' AND key='messaging'",
    )
    .get(orgId);
  return {
    from_name: db
      .prepare("SELECT name FROM organizations WHERE id=?")
      .get(orgId).name,
    reply_to: "",
    header: "",
    footer: "",
    ...(row ? JSON.parse(row.value) : {}),
  };
}
export function deliveryConfiguration(env = process.env) {
  return {
    email: !!(env.RESEND_API_KEY && env.MAIL_FROM),
    sms: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM),
    enabled: env.MESSAGE_DELIVERY_ENABLED === "true",
  };
}
export function resolveRecipients(db, actor, input, channel = "email") {
  const t = targetSchema.parse(input),
    org = actor.org_id;
  for (const p of t.program_ids) requireEntity(db, "programs", p, org);
  for (const p of t.person_ids) requireEntity(db, "people", p, org);
  for (const p of t.location_ids) requireEntity(db, "locations", p, org);
  for (const id of t.team_ids) {
    const team = unpack(requireEntity(db, "teams", id, org));
    const program = unpack(requireEntity(db, "programs", team.program_id, org));
    if (team.archived_at || program.archived_at)
      throw new DomainError("Choose active teams and programs");
  }
  if (t.group === "teams" && (!t.team_ids.length || t.person_ids.length))
    throw new DomainError("Choose teams for the team audience");
  if (
    t.by_games &&
    (!t.game_from ||
      !t.game_to ||
      Date.parse(t.game_to) < Date.parse(t.game_from))
  )
    throw new DomainError("Choose a valid game date and time range");
  const people = db
      .prepare("SELECT * FROM people WHERE org_id=?")
      .all(org)
      .map(unpack)
      .filter((p) => !p.archived_at),
    byId = new Map(people.map((p) => [p.id, p]));
  const regs = db
    .prepare(
      `SELECT r.*,i.total_cents,i.paid_cents,p.parent_id,p.sport,p.season,p.status program_state FROM registrations r JOIN programs p ON p.id=r.program_id LEFT JOIN invoices i ON i.id=r.invoice_id WHERE r.org_id=? AND r.status!='Canceled'`,
    )
    .all(org);
  let chosen = [];
  if (t.person_ids.length)
    chosen = people.filter((p) => t.person_ids.includes(p.id));
  else if (t.group === "teams") {
    const ids = new Set(
      regs
        .filter(
          (r) =>
            t.team_ids.includes(r.team_id) &&
            t.statuses.includes(r.status) &&
            (!t.roles.length || t.roles.includes(r.role)),
        )
        .map((r) => r.person_id),
    );
    db.prepare("SELECT person_id,team_id,role FROM team_staff WHERE org_id=?")
      .all(org)
      .filter(
        (r) =>
          t.team_ids.includes(r.team_id) &&
          (!t.roles.length || t.roles.includes(r.role)),
      )
      .forEach((r) => ids.add(r.person_id));
    chosen = people.filter((p) => ids.has(p.id));
  } else if (t.group === "site" && t.members) chosen = people;
  else if (t.group === "programs") {
    const gameTeams = new Set();
    if (t.by_games)
      db.prepare("SELECT * FROM events WHERE org_id=?")
        .all(org)
        .map(unpack)
        .filter(
          (e) =>
            Date.parse(e.start_at) >= Date.parse(t.game_from) &&
            Date.parse(e.start_at) <= Date.parse(t.game_to) &&
            (!t.location_ids.length ||
              t.location_ids.includes(e.location_id)) &&
            (!t.game_types.length ||
              t.game_types.includes(e.game_type || e.type)),
        )
        .forEach((e) => {
          gameTeams.add(e.home_team_id);
          gameTeams.add(e.away_team_id);
        });
    const memberIds = new Set(
      regs
        .filter((r) => {
          const programMatch =
            (!t.program_ids.length ||
              t.program_ids.includes(r.program_id) ||
              t.program_ids.includes(r.parent_id)) &&
            t.program_states.includes(r.program_state) &&
            (!t.sports.length || t.sports.includes(r.sport)) &&
            (!t.seasons.length || t.seasons.includes(r.season));
          return (
            (t.exclude_programs ? !programMatch : programMatch) &&
            t.roles.includes(r.role) &&
            t.statuses.includes(r.status) &&
            (!t.payment ||
              (t.payment === "None"
                ? !r.invoice_id
                : t.payment === "Owes"
                  ? r.total_cents > r.paid_cents
                  : !!r.invoice_id && r.total_cents === r.paid_cents)) &&
            (!t.waiver ||
              (t.waiver === "Accepted"
                ? !!r.waiver_accepted_at
                : !r.waiver_accepted_at)) &&
            (!t.by_games || (!!r.team_id && gameTeams.has(r.team_id)))
          );
        })
        .map((r) => r.person_id),
    );
    chosen = people.filter((p) => memberIds.has(p.id));
  }
  chosen = chosen.filter(
    (p) =>
      (!t.gender || p.gender === t.gender) &&
      (!t.city || p.city?.toLowerCase() === t.city.toLowerCase()),
  );
  const links = db
    .prepare(
      "SELECT hm.* FROM household_members hm JOIN households h ON h.id=hm.household_id WHERE h.org_id=?",
    )
    .all(org);
  const recipients = new Map(),
    skipped = [];
  const add = (person, address, kind, reason = "") => {
    if (!address) return;
    address =
      kind === "email"
        ? address.trim().toLowerCase()
        : address.replace(/[\s().-]/g, "");
    if (kind === "email" && !z.email().safeParse(address).success) return;
    if (kind === "sms" && !/^\+[1-9]\d{7,14}$/.test(address)) return;
    if (reason) {
      skipped.push({
        name:
          person.name ||
          [person.first_name, person.last_name].filter(Boolean).join(" "),
        reason,
      });
      return;
    }
    const key = kind + ":" + address;
    if (!recipients.has(key))
      recipients.set(key, {
        person_id: byId.has(person.id) ? person.id : null,
        name:
          person.name ||
          [person.first_name, person.last_name].filter(Boolean).join(" "),
        address,
        channel: kind,
      });
  };
  const addPerson = (p) => {
    if (channel !== "sms") {
      const reason =
        p.email_status === "Bounced"
          ? "Address suppressed"
          : t.newsletter &&
              (p.email_status === "Unsubscribed" ||
                p.marketing_opt_in === false)
            ? "Newsletter opt-out"
            : "";
      add(p, p.email, "email", reason);
      add(p, p.secondary_email, "email", reason);
    }
    if (channel !== "email")
      add(p, p.phone, "sms", p.sms_opt_in ? "" : "SMS consent is missing");
  };
  for (const person of chosen) {
    const familyIds = links
      .filter((l) => l.person_id === person.id && l.role === "Member")
      .map((l) => l.household_id);
    const parents = links
      .filter(
        (l) => familyIds.includes(l.household_id) && l.role === "Supervisor",
      )
      .map((l) => byId.get(l.person_id))
      .filter(Boolean);
    // Every supervisor receives youth notices. Deduplication runs after family expansion.
    (parents.length ? parents : [person]).forEach(addPerson);
  }
  if (t.group === "site" && t.contacts && channel !== "sms")
    db.prepare("SELECT * FROM email_contacts WHERE org_id=?")
      .all(org)
      .forEach((c) =>
        add(
          c,
          c.email,
          "email",
          c.status === "Subscribed" ? "" : "Contact unsubscribed",
        ),
      );
  if (t.group === "admins" || t.include_admins)
    db.prepare(
      "SELECT * FROM users WHERE org_id=? AND role IN ('owner','admin','manager')",
    )
      .all(org)
      .forEach((u) => channel !== "sms" && add(u, u.email, "email"));
  if (t.copy_self && channel !== "sms") add(actor, actor.email, "email");
  return {
    recipients: [...recipients.values()],
    skipped,
    matched_members: chosen.length,
    email: [...recipients.values()].filter((r) => r.channel === "email").length,
    sms: [...recipients.values()].filter((r) => r.channel === "sms").length,
  };
}
const messageSchema = z.object({
  subject: z.string().trim().max(255).default(""),
  body: z.string().max(65500).default(""),
  channel: z.enum(["email", "sms", "both"]).default("email"),
  from_name: z.string().trim().max(100).default(""),
  targets: targetSchema.default({}),
  mobile: z.boolean().default(true),
  expires: z.union([z.iso.date(), z.literal("")]).default(""),
  include_header: z.boolean().default(false),
  include_footer: z.boolean().default(false),
});
export function getMessage(db, actor, messageId) {
  const row = db
    .prepare("SELECT * FROM messages WHERE id=? AND org_id=?")
    .get(messageId, actor.org_id);
  if (!row) throw new DomainError("Message not found", 404);
  return unpack(row);
}
export function saveMessage(db, actor, input, messageId) {
  const m = messageSchema.parse(input);
  m.body = cleanHtml(m.body);
  resolveRecipients(db, actor, m.targets, m.channel);
  if (messageId && getMessage(db, actor, messageId).status !== "Draft")
    throw new DomainError("Only drafts can be edited", 409);
  const key = messageId || id(),
    { subject, body, channel, ...data } = m;
  db.prepare(
    `INSERT INTO messages(id,org_id,author_id,subject,body,channel,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET subject=excluded.subject,body=excluded.body,channel=excluded.channel,data=excluded.data,updated_at=excluded.updated_at`,
  ).run(
    key,
    actor.org_id,
    actor.id,
    subject,
    body,
    channel,
    JSON.stringify(data),
    now(),
    now(),
  );
  audit(db, actor, messageId ? "update" : "create", "message", key);
  return getMessage(db, actor, key);
}
export function queueMessage(db, actor, messageId, env = process.env) {
  return transaction(db, () => {
    const m = getMessage(db, actor, messageId);
    if (!["Draft", "Awaiting configuration"].includes(m.status)) return m;
    if (!m.subject && m.channel !== "sms")
      throw new DomainError("Enter a subject line");
    if (
      !sanitizeHtml(m.body, { allowedTags: [], allowedAttributes: {} }).trim()
    )
      throw new DomainError("Enter a message");
    const settings = getMessageSettings(db, actor.org_id),
      config = deliveryConfiguration(env);
    const preview = resolveRecipients(db, actor, m.targets, m.channel);
    if (!preview.recipients.length)
      throw new DomainError("No deliverable recipients match these filters");
    const configured =
        config.enabled &&
        (m.channel === "email"
          ? config.email
          : m.channel === "sms"
            ? config.sms
            : config.email && config.sms),
      state = configured ? "Queued" : "Awaiting configuration";
    if (m.status === "Draft") {
      const frozen = {
        ...messageSchema.parse(m),
        header: m.include_header ? settings.header : "",
        footer: m.include_footer ? settings.footer : "",
        reply_to: settings.reply_to,
        from_name: m.from_name || settings.from_name,
      };
      delete frozen.body;
      delete frozen.subject;
      delete frozen.channel;
      db.prepare("UPDATE messages SET data=? WHERE id=?").run(
        JSON.stringify(frozen),
        m.id,
      );
      for (const r of preview.recipients)
        db.prepare(
          "INSERT INTO message_recipients(id,org_id,message_id,person_id,channel,address,name,status) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          id(),
          actor.org_id,
          m.id,
          r.person_id,
          r.channel,
          r.address,
          r.name,
          state,
        );
    } else if (configured)
      db.prepare(
        "UPDATE message_recipients SET status='Queued' WHERE message_id=? AND status='Awaiting configuration'",
      ).run(m.id);
    db.prepare(
      "UPDATE messages SET status=?,queued_at=?,updated_at=? WHERE id=?",
    ).run(state, now(), now(), m.id);
    audit(db, actor, "queue", "message", m.id, {
      recipients: preview.recipients.length,
      state,
    });
    return getMessage(db, actor, m.id);
  });
}
export function installMessagingRoutes(app, db) {
  app.get("/api/messaging/configuration", (req, res) =>
    res.json({
      ...getMessageSettings(db, req.actor.org_id),
      delivery: deliveryConfiguration(),
    }),
  );
  app.put("/api/messaging/configuration", (req, res) => {
    const v = z
      .object({
        from_name: z.string().trim().min(1).max(100),
        reply_to: z.union([z.email(), z.literal("")]),
        header: z.string().max(10000),
        footer: z.string().max(10000),
      })
      .parse(req.body);
    v.header = cleanHtml(v.header);
    v.footer = cleanHtml(v.footer);
    db.prepare(
      "INSERT INTO settings VALUES(?,'site','messaging',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(req.actor.org_id, JSON.stringify(v));
    audit(db, req.actor, "update", "messaging_settings", req.actor.org_id);
    res.json(v);
  });
  app.post("/api/messaging/preview", (req, res) => {
    const v = messageSchema.parse(req.body);
    res.json(resolveRecipients(db, req.actor, v.targets, v.channel));
  });
  app.get("/api/messaging/messages", (req, res) =>
    res.json(
      db
        .prepare(
          `SELECT m.*,u.name sender,(SELECT COUNT(*) FROM message_recipients r WHERE r.message_id=m.id) recipient_count,(SELECT COUNT(*) FROM message_recipients r WHERE r.message_id=m.id AND r.status='Accepted') accepted_count FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.org_id=? ORDER BY m.created_at DESC`,
        )
        .all(req.actor.org_id)
        .map(unpack),
    ),
  );
  app.post("/api/messaging/messages", (req, res) =>
    res.status(201).json(saveMessage(db, req.actor, req.body)),
  );
  app.get("/api/messaging/messages/:id", (req, res) =>
    res.json({
      ...getMessage(db, req.actor, req.params.id),
      recipients: db
        .prepare(
          "SELECT * FROM message_recipients WHERE message_id=? AND org_id=? ORDER BY name,address",
        )
        .all(req.params.id, req.actor.org_id),
    }),
  );
  app.put("/api/messaging/messages/:id", (req, res) =>
    res.json(saveMessage(db, req.actor, req.body, req.params.id)),
  );
  app.post("/api/messaging/messages/:id/queue", (req, res) =>
    res.json(queueMessage(db, req.actor, req.params.id)),
  );
  app.post("/api/messaging/messages/:id/copy", (req, res) =>
    res
      .status(201)
      .json(
        saveMessage(db, req.actor, getMessage(db, req.actor, req.params.id)),
      ),
  );
  app.post("/api/messaging/messages/:id/cancel", (req, res) => {
    transaction(db, () => {
      const m = getMessage(db, req.actor, req.params.id);
      if (!["Queued", "Awaiting configuration", "Draft"].includes(m.status))
        throw new DomainError("Only drafts or queued messages can be canceled");
      db.prepare(
        "UPDATE message_recipients SET status='Canceled' WHERE message_id=? AND status IN ('Queued','Awaiting configuration')",
      ).run(m.id);
      db.prepare(
        "UPDATE messages SET status='Canceled',updated_at=? WHERE id=?",
      ).run(now(), m.id);
      audit(db, req.actor, "cancel", "message", m.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/messaging/contacts", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM email_contacts WHERE org_id=? ORDER BY created_at DESC",
        )
        .all(req.actor.org_id),
    ),
  );
  app.post("/api/messaging/contacts", (req, res) => {
    const emails = z.array(z.email()).min(1).max(500).parse(req.body.emails);
    transaction(db, () => {
      for (const email of emails)
        db.prepare(
          "INSERT OR IGNORE INTO email_contacts VALUES(?,?,?,?,?)",
        ).run(
          id(),
          req.actor.org_id,
          email.trim().toLowerCase(),
          "Subscribed",
          now(),
        );
      audit(db, req.actor, "add", "email_contacts", req.actor.org_id, {
        count: emails.length,
      });
    });
    res.status(201).json({ ok: true });
  });
  app.patch("/api/messaging/contacts/:id", (req, res) => {
    const v = z
      .object({ status: z.enum(["Subscribed", "Unsubscribed"]) })
      .parse(req.body);
    const result = db
      .prepare("UPDATE email_contacts SET status=? WHERE id=? AND org_id=?")
      .run(v.status, req.params.id, req.actor.org_id);
    if (!result.changes) throw new DomainError("Contact not found", 404);
    audit(db, req.actor, "update", "email_contact", req.params.id, v);
    res.json({ ok: true });
  });
  app.delete("/api/messaging/contacts/:id", (req, res) => {
    db.prepare("DELETE FROM email_contacts WHERE id=? AND org_id=?").run(
      req.params.id,
      req.actor.org_id,
    );
    audit(db, req.actor, "remove", "email_contact", req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/messaging/templates", (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM message_templates WHERE org_id=? ORDER BY name")
        .all(req.actor.org_id),
    ),
  );
  app.post("/api/messaging/templates", (req, res) => {
    const t = z
        .object({
          name: z.string().trim().min(1).max(100),
          subject: z.string().max(255),
          body: z.string().max(65500),
        })
        .parse(req.body),
      key = id();
    db.prepare("INSERT INTO message_templates VALUES(?,?,?,?,?,?)").run(
      key,
      req.actor.org_id,
      t.name,
      t.subject,
      cleanHtml(t.body),
      now(),
    );
    res.status(201).json({ id: key });
  });
  app.delete("/api/messaging/templates/:id", (req, res) => {
    db.prepare("DELETE FROM message_templates WHERE id=? AND org_id=?").run(
      req.params.id,
      req.actor.org_id,
    );
    res.json({ ok: true });
  });
}

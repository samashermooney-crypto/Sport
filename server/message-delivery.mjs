import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import sanitizeHtml from "sanitize-html";
import { openDb, now, unpack } from "./db.mjs";
import { deliveryConfiguration } from "./messaging.mjs";

// This worker runs only when explicitly enabled. Provider acceptance does not mean delivery.
export async function deliverQueued(
  db,
  { env = process.env, send, limit = 100 } = {},
) {
  const config = deliveryConfiguration(env);
  if (!config.enabled && !send)
    return { processed: 0, reason: "Message delivery is disabled" };
  const rows = db
    .prepare(
      "SELECT r.*,m.subject,m.body,m.data FROM message_recipients r JOIN messages m ON m.id=r.message_id WHERE r.status='Queued' AND m.status IN ('Queued','Processing') ORDER BY m.queued_at,r.id LIMIT ?",
    )
    .all(limit);
  let processed = 0;
  for (const row of rows) {
    if (!send && !config[row.channel]) continue;
    // Claim before I/O. A crash leaves Processing, which needs reconciliation rather than blind resend.
    const claim = db
      .prepare(
        "UPDATE message_recipients SET status='Processing',attempted_at=? WHERE id=? AND status='Queued'",
      )
      .run(now(), row.id);
    if (!claim.changes) continue;
    db.prepare("UPDATE messages SET status='Processing' WHERE id=?").run(
      row.message_id,
    );
    const r = unpack(row);
    const person = r.person_id
      ? unpack(
          db
            .prepare("SELECT * FROM people WHERE id=? AND org_id=?")
            .get(r.person_id, r.org_id),
        )
      : null;
    const contact = db
      .prepare("SELECT status FROM email_contacts WHERE org_id=? AND email=?")
      .get(r.org_id, r.address);
    const suppressed =
      (person &&
        (person.archived_at ||
          (r.channel === "sms" &&
            (!person.sms_opt_in ||
              (person.phone || "").replace(/[\s().-]/g, "") !== r.address)) ||
          (r.channel === "email" &&
            (person.email_status === "Bounced" ||
              (r.targets.newsletter &&
                (person.email_status === "Unsubscribed" ||
                  person.marketing_opt_in === false)))))) ||
      contact?.status === "Unsubscribed";
    try {
      if (suppressed) {
        db.prepare(
          "UPDATE message_recipients SET status='Suppressed',completed_at=?,error='Recipient consent or address status changed' WHERE id=?",
        ).run(now(), r.id);
      } else {
        const result = await (send ? send(r) : deliver(r, env));
        db.prepare(
          "UPDATE message_recipients SET status='Accepted',provider_id=?,completed_at=?,error='' WHERE id=?",
        ).run(result.id, now(), r.id);
      }
    } catch (error) {
      db.prepare(
        "UPDATE message_recipients SET status=?,error=?,completed_at=? WHERE id=?",
      ).run(
        error.definitive ? "Failed" : "Unknown",
        error.message.slice(0, 500),
        now(),
        r.id,
      );
    }
    processed++;
    const states = db
      .prepare("SELECT status FROM message_recipients WHERE message_id=?")
      .all(r.message_id)
      .map((x) => x.status);
    const state = states.includes("Queued")
      ? "Queued"
      : states.includes("Processing")
        ? "Processing"
        : states.every((x) => x === "Accepted")
          ? "Accepted"
          : states.some((x) => ["Failed", "Unknown"].includes(x))
            ? "Needs attention"
            : states.every((x) => x === "Canceled")
              ? "Canceled"
              : "Partially accepted";
    db.prepare("UPDATE messages SET status=?,updated_at=? WHERE id=?").run(
      state,
      now(),
      r.message_id,
    );
  }
  return { processed };
}
async function deliver(r, env) {
  let response;
  if (r.channel === "email") {
    const fromName = (r.from_name || "Athlentry").replace(/[<>\r\n"]/g, "");
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
        "Idempotency-Key": "fieldhouse-" + r.id,
      },
      body: JSON.stringify({
        from: fromName + " <" + env.MAIL_FROM + ">",
        to: [r.address],
        subject: r.subject,
        html: (r.header || "") + r.body + (r.footer || ""),
        ...(r.reply_to ? { reply_to: r.reply_to } : {}),
      }),
    });
  } else {
    response = await fetch(
      "https://api.twilio.com/2010-04-01/Accounts/" +
        encodeURIComponent(env.TWILIO_ACCOUNT_SID) +
        "/Messages.json",
      {
        method: "POST",
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN,
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: r.address,
          From: env.TWILIO_FROM,
          Body: sanitizeHtml(r.body, {
            allowedTags: [],
            allowedAttributes: {},
          }),
        }),
      },
    );
  }
  if (!response.ok) {
    const error = new Error("Provider returned HTTP " + response.status);
    error.definitive = response.status >= 400 && response.status < 500;
    throw error;
  }
  const json = await response.json(),
    key = json.id || json.sid;
  if (!key)
    throw new Error("Provider response did not include a message identifier");
  return { id: key };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const db = openDb(process.env.DATABASE_PATH);
  try {
    console.log(await deliverQueued(db));
  } finally {
    db.close();
  }
}

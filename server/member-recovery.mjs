import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit, now, passwordHash, transaction } from "./db.mjs";

const digest = (token) => createHash("sha256").update(token).digest("hex");
const invalid = () =>
  Object.assign(
    new Error(
      "This password reset link is invalid or expired. Request a new link.",
    ),
    { status: 400 },
  );

export function initializeMemberRecovery(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS member_reset_tokens(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE REFERENCES member_accounts(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)",
  );
}

export function beginMemberRecovery(db, org, input) {
  const email = z
    .object({ email: z.string().trim().email().max(254) })
    .parse(input)
    .email.toLowerCase();
  const account = db
    .prepare(
      "SELECT a.id,a.email FROM member_accounts a JOIN people p ON p.id=a.person_id AND p.org_id=a.org_id WHERE a.org_id=? AND a.email=? COLLATE NOCASE AND json_extract(p.data,'$.archived_at') IS NULL",
    )
    .get(org, email);
  if (!account) return null;
  const token = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO member_reset_tokens VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at",
  ).run(
    digest(token),
    account.id,
    new Date(Date.now() + 30 * 60000).toISOString(),
    now(),
  );
  return { token, email: account.email };
}

export function finishMemberRecovery(db, org, input) {
  const data = z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      password: z
        .string()
        .min(12, "Use at least 12 characters for your password.")
        .max(128),
    })
    .parse(input);
  const password = passwordHash(data.password);
  return transaction(db, () => {
    const account = db
      .prepare(
        "SELECT a.id,a.org_id,t.expires_at FROM member_reset_tokens t JOIN member_accounts a ON a.id=t.account_id JOIN people p ON p.id=a.person_id AND p.org_id=a.org_id WHERE t.token_hash=? AND a.org_id=? AND json_extract(p.data,'$.archived_at') IS NULL",
      )
      .get(digest(data.token), org);
    if (!account || account.expires_at <= now()) throw invalid();
    db.prepare(
      "UPDATE member_accounts SET password_hash=? WHERE id=? AND org_id=?",
    ).run(password, account.id, org);
    db.prepare("DELETE FROM member_sessions WHERE account_id=?").run(
      account.id,
    );
    db.prepare("DELETE FROM member_reset_tokens WHERE account_id=?").run(
      account.id,
    );
    audit(db, { org_id: org }, "reset_password", "member_account", account.id);
    return { ok: true };
  });
}

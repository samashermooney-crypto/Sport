import { installMemberAttendanceRoutes } from "./attendance.mjs";
import { acceptMemberInvitation } from "./member-invitations.mjs";
import { initializeMemberRecovery, beginMemberRecovery, finishMemberRecovery } from "./member-recovery.mjs";
import {
  memberCollectionSettings,
  memberPhonePolicy,
  requireMemberMobile,
  secondaryEmailSchema,
  secondaryEmailPolicy,
  requireSecondaryEmail,
  requireMemberAddress,
} from "./member-properties.mjs";
import { memberCompletion } from "./member-completion.mjs";
import { installMemberScheduleRoutes } from "./member-schedule.mjs";
import { installMemberRecordRoutes } from "./member-records.mjs";
import { installMemberRegistrationRoutes } from "./member-registration.mjs";
import { installMemberProfileRoutes } from "./member-profile.mjs";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  audit,
  id,
  now,
  passwordHash,
  passwordMatches,
  transaction,
  unpack,
} from "./db.mjs";

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const hash = (token) => createHash("sha256").update(token).digest("hex");
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const password = z
  .string()
  .min(12, "Use at least 12 characters for your password.")
  .max(128);
const signupSchema = z.object({
  email,
  password,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  birthdate: z.iso.date(),
  address: z.string().trim().max(300).default(""),
  city: z.string().trim().max(100).default(""),
  state: z.string().trim().max(100).default(""),
  postal: z.string().trim().max(30).default(""),
  phone: z.string().trim().max(50).default(""),
  secondary_email: secondaryEmailSchema,
});
const cookieName = "fieldhouse_member";
const cookieValue = (req) =>
  (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);

export function initializeMemberAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_accounts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),person_id TEXT NOT NULL UNIQUE REFERENCES people(id),email TEXT NOT NULL COLLATE NOCASE,password_hash TEXT NOT NULL,verified_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(org_id,email));
    CREATE TABLE IF NOT EXISTS member_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES member_accounts(id),expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_signup_tokens(token_hash TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),email TEXT NOT NULL COLLATE NOCASE,data TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(org_id,email));
  `);
  initializeMemberRecovery(db);
}
function organization(db, org) {
  const result = db
    .prepare("SELECT id,name,timezone FROM organizations WHERE id=?")
    .get(org);
  if (!result) throw fail("Organization not found", 404);
  return result;
}
function isAdult(birthdate, timezone) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(),
  );
  const [y, m, d] = birthdate.split("-").map(Number),
    [cy, cm, cd] = today.split("-").map(Number);
  return (
    birthdate <= today &&
    cy - y - (cm < m || (cm === m && cd < d) ? 1 : 0) >= 18
  );
}
function existingEmail(db, org, value) {
  return (
    db
      .prepare(
        "SELECT 1 FROM member_accounts WHERE org_id=? AND email=? COLLATE NOCASE",
      )
      .get(org, value) ||
    db
      .prepare("SELECT 1 FROM people WHERE org_id=? AND email=? COLLATE NOCASE")
      .get(org, value) ||
    db
      .prepare("SELECT 1 FROM users WHERE org_id=? AND email=? COLLATE NOCASE")
      .get(org, value)
  );
}
export function beginMemberSignup(db, org, input) {
  const p = signupSchema.parse(input),
    site = organization(db, org);
  requireMemberAddress(db, org, p);
  requireMemberMobile(db, org, p);
  requireSecondaryEmail(db, org, p);
  if (!secondaryEmailPolicy(db, org, p).collect) p.secondary_email = "";
  if (!memberPhonePolicy(db, org, p).collect) p.phone = "";
  if (!isAdult(p.birthdate, site.timezone))
    throw fail(
      "A parent or adult participant must create the account. Children are added to a family account.",
    );
  return transaction(db, () => {
    if (existingEmail(db, org, p.email))
      throw fail(
        "This email already belongs to an account or member. Sign in or contact the organization for account access.",
        409,
      );
    const token = randomBytes(32).toString("hex");
    const { password: rawPassword, ...profile } = p;
    db.prepare("DELETE FROM member_signup_tokens WHERE expires_at<=?").run(
      now(),
    );
    db.prepare(
      "INSERT INTO member_signup_tokens VALUES(?,?,?,?,?,?) ON CONFLICT(org_id,email) DO UPDATE SET token_hash=excluded.token_hash,data=excluded.data,expires_at=excluded.expires_at,created_at=excluded.created_at",
    ).run(
      hash(token),
      org,
      p.email,
      JSON.stringify({ ...profile, password_hash: passwordHash(rawPassword) }),
      new Date(Date.now() + 30 * 60000).toISOString(),
      now(),
    );
    return { token, email: p.email, organization: site.name };
  });
}
export function verifyMemberSignup(db, org, token) {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(token);
  return transaction(db, () => {
    const pending = db
      .prepare(
        "SELECT * FROM member_signup_tokens WHERE token_hash=? AND org_id=? AND expires_at>?",
      )
      .get(hash(token), org, now());
    if (!pending)
      throw fail(
        "This verification link is invalid or expired. Create your account again to request a new link.",
        410,
      );
    if (existingEmail(db, org, pending.email))
      throw fail(
        "This email is already in use. Contact the organization for account access.",
        409,
      );
    const p = JSON.parse(pending.data),
      personId = id(),
      familyId = id(),
      accountId = id();
    const stamp = now();
    db.prepare("INSERT INTO households VALUES(?,?,?)").run(
      familyId,
      org,
      `${p.last_name} Family`,
    );
    db.prepare("INSERT INTO household_details VALUES(?,'Family','')").run(
      familyId,
    );
    db.prepare("INSERT INTO people VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      personId,
      org,
      familyId,
      p.first_name,
      p.last_name,
      pending.email,
      p.birthdate,
      "Unknown",
      "parent",
      JSON.stringify({
        phone: p.phone || "",
        secondary_email: p.secondary_email || "",
        address: p.address || "",
        city: p.city || "",
        state: p.state || "",
        postal: p.postal || "",
        marketing_opt_in: false,
        sms_opt_in: false,
        email_status: "Active",
      }),
      stamp,
    );
    db.prepare("INSERT INTO household_members VALUES(?,?,'Supervisor')").run(
      familyId,
      personId,
    );
    db.prepare("INSERT INTO member_accounts VALUES(?,?,?,?,?,?,?)").run(
      accountId,
      org,
      personId,
      pending.email,
      p.password_hash,
      stamp,
      stamp,
    );
    db.prepare("DELETE FROM member_signup_tokens WHERE token_hash=?").run(
      hash(token),
    );
    audit(
      db,
      { id: accountId, org_id: org },
      "member.account_created",
      "person",
      personId,
    );
    return { id: accountId, org_id: org, person_id: personId };
  });
}
export function memberSession(db, org, token) {
  if (!token) return null;
  const row = db
    .prepare(
      "SELECT a.id,a.org_id,a.person_id,a.email,p.first_name,p.last_name,p.birthdate,p.data FROM member_sessions s JOIN member_accounts a ON a.id=s.account_id JOIN people p ON p.id=a.person_id AND p.org_id=a.org_id WHERE s.token_hash=? AND a.org_id=? AND s.expires_at>?",
    )
    .get(hash(token), org, now());
  if (!row || JSON.parse(row.data).archived_at) return null;
  const { data, ...account } = row;
  return account;
}
export function memberRequestSession(db, req, org) {
  return memberSession(db, org, cookieValue(req));
}
function sessionToken(db, accountId) {
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM member_sessions WHERE expires_at<=?").run(now());
  db.prepare("INSERT INTO member_sessions VALUES(?,?,?)").run(
    hash(token),
    accountId,
    new Date(Date.now() + 86400000).toISOString(),
  );
  return token;
}
export function memberFamily(db, account) {
  const rows = db
    .prepare(
      "SELECT DISTINCT p.*,m.role household_role FROM household_members self JOIN households h ON h.id=self.household_id AND h.org_id=? JOIN household_members m ON m.household_id=h.id JOIN people p ON p.id=m.person_id AND p.org_id=h.org_id WHERE self.person_id=? AND self.role='Supervisor' ORDER BY p.last_name,p.first_name",
    )
    .all(account.org_id, account.person_id)
    .map(unpack)
    .filter((p) => !p.archived_at);
  return rows.map((p) => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    birthdate: p.birthdate,
    household_role: p.household_role,
    self: p.id === account.person_id,
    can_register: p.id === account.person_id || p.household_role === "Member",
  }));
}

export function installMemberAuthRoutes(
  app,
  db,
  { env = process.env, sendVerification, sendRecovery } = {},
) {
  initializeMemberAuth(db);
  const dummy = passwordHash(randomBytes(32).toString("hex")),
    attempts = new Map();
  const preview =
    env.NODE_ENV !== "production" && env.AUTH_EMAIL_DELIVERY_ENABLED !== "true";
  const limit = (req, action) => {
    const key = `${req.ip}:${req.params.org}:${action}`,
      time = Date.now();
    if (attempts.size > 10000)
      for (const [key, value] of attempts)
        if (value.until < time) attempts.delete(key);
    let entry = attempts.get(key);
    if (!entry || entry.until < time) {
      entry = { count: 0, until: time + 15 * 60000 };
      attempts.set(key, entry);
    }
    if (++entry.count > (action === "login" ? 12 : 6))
      throw fail("Too many attempts. Try again in 15 minutes.", 429);
  };
  const issue = (res, account) =>
    res.cookie(cookieName, sessionToken(db, account.id), {
      httpOnly: true,
      sameSite: "strict",
      secure: env.NODE_ENV === "production" || env.COOKIE_SECURE === "true",
      maxAge: 86400000,
      path: "/",
    });
  app.get("/api/member/:org/signup-settings", (req, res) => {
    organization(db, req.params.org);
    res.json(memberCollectionSettings(db, req.params.org));
  });
  app.get("/api/member/:org/session", (req, res) => {
    organization(db, req.params.org);
    res.json(memberSession(db, req.params.org, cookieValue(req)));
  });
  app.post("/api/member/:org/signup", async (req, res) => {
    limit(req, "signup");
    if (
      !preview &&
      !sendVerification &&
      !(
        env.AUTH_EMAIL_DELIVERY_ENABLED === "true" &&
        env.RESEND_API_KEY &&
        env.MAIL_FROM &&
        env.PUBLIC_URL
      )
    )
      throw fail(
        "Account email delivery is not configured. Contact the organization.",
        503,
      );
    const destination = z
      .object({
        program: z.string().max(200).optional(),
        return_page: z.string().max(200).optional(),
        return_team: z.string().max(200).optional(),
      })
      .parse(req.body);
    const pending = beginMemberSignup(db, req.params.org, req.body);
    const query = new URLSearchParams({ token: pending.token });
    for (const key of ["program", "return_page", "return_team"])
      if (destination[key]) query.set(key, destination[key]);
    const path = `/site/${encodeURIComponent(req.params.org)}/account/verify?${query}`;
    if (preview && !sendVerification)
      return res.status(202).json({
        message: "Verify your email to finish creating your account.",
        development_link: path,
      });
    const url = new URL(path, env.PUBLIC_URL || "https://example.test");
    if (env.NODE_ENV === "production" && url.protocol !== "https:")
      throw fail("Account email delivery requires a secure public URL.", 503);
    if (sendVerification)
      await sendVerification({ to: pending.email, url: url.href });
    else {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `member-signup-${hash(pending.token)}`,
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [pending.email],
          subject: "Verify your Athlentry account",
          text: `Finish creating your account: ${url.href}\n\nThis link expires in 30 minutes. If you did not request this, you can ignore it.`,
        }),
      });
      if (!response.ok)
        throw fail(
          "The verification email could not be sent. Please try again later.",
          503,
        );
    }
    res.status(202).json({
      message:
        "Check your email for a verification link. It expires in 30 minutes.",
    });
  });
  app.post("/api/member/:org/verify", (req, res) => {
    limit(req, "verify");
    const account = verifyMemberSignup(db, req.params.org, req.body.token);
    issue(res, account);
    res.json({ ok: true });
  });
  app.post("/api/member/:org/forgot-password", async (req, res) => {
    limit(req, "forgot-password");
    organization(db, req.params.org);
    if (!preview && !sendRecovery && !(env.AUTH_EMAIL_DELIVERY_ENABLED === "true" && env.RESEND_API_KEY && env.MAIL_FROM && env.PUBLIC_URL))
      throw fail("Account email delivery is not configured. Contact the organization.", 503);
    const publicUrl = new URL(env.PUBLIC_URL || "https://example.test");
    if (!preview && env.NODE_ENV === "production" && publicUrl.protocol !== "https:")
      throw fail("Account email delivery requires a secure public URL.", 503);
    const pending = beginMemberRecovery(db, req.params.org, req.body);
    const message = "If an active account matches that email, a password reset link will be sent. It expires in 30 minutes.";
    if (pending) {
      const path = `/site/${encodeURIComponent(req.params.org)}/account/reset-password?token=${pending.token}`;
      if (preview && !sendRecovery) return res.status(202).json({ message, development_link: path });
      const url = new URL(path, publicUrl);
      try {
        if (sendRecovery) await sendRecovery({ to: pending.email, url: url.href });
        else {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST", signal: AbortSignal.timeout(20000),
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `member-reset-${hash(pending.token)}` },
            body: JSON.stringify({ from: env.MAIL_FROM, to: [pending.email], subject: "Reset your Athlentry password", text: `Reset your password: ${url.href}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email.` }),
          });
          if (!response.ok) throw new Error("Recovery email delivery failed");
        }
      } catch {
        // Never disclose account existence or provider details in a public response.
        console.error("Member recovery email delivery failed.");
      }
    }
    res.status(202).json({ message });
  });
  app.post("/api/member/:org/reset-password", (req, res) => {
    limit(req, "reset-password");
    organization(db, req.params.org);
    const result = finishMemberRecovery(db, req.params.org, req.body);
    res.clearCookie(cookieName, { path: "/" });
    res.json(result);
  });
  app.post("/api/member/:org/accept-invitation", (req, res) => {
    limit(req, "accept-invitation");
    organization(db, req.params.org);
    const account = acceptMemberInvitation(db, req.params.org, req.body);
    issue(res, account);
    res.json({ ok: true });
  });
  app.post("/api/member/:org/login", (req, res) => {
    limit(req, "login");
    const p = z
      .object({ email, password: z.string().min(1).max(128) })
      .parse(req.body);
    const account = db
      .prepare(
        "SELECT a.*,p.data FROM member_accounts a JOIN people p ON p.id=a.person_id AND p.org_id=a.org_id WHERE a.org_id=? AND a.email=? COLLATE NOCASE",
      )
      .get(req.params.org, p.email);
    const valid = passwordMatches(p.password, account?.password_hash || dummy);
    if (!account || !valid || JSON.parse(account.data).archived_at)
      throw fail("Email or password is incorrect.", 401);
    attempts.delete(`${req.ip}:${req.params.org}:login`);
    issue(res, account);
    res.json({ ok: true });
  });
  app.post("/api/member/:org/logout", (req, res) => {
    const token = cookieValue(req);
    if (token)
      db.prepare("DELETE FROM member_sessions WHERE token_hash=?").run(
        hash(token),
      );
    res.clearCookie(cookieName, { path: "/" });
    res.json({ ok: true });
  });
  app.use("/api/member/:org", (req, res, next) => {
    req.member = memberSession(db, req.params.org, cookieValue(req));
    if (!req.member)
      return res.status(401).json({ error: "Sign in to your member account." });
    next();
  });
  installMemberProfileRoutes(app, db);
  app.get("/api/member/:org/profile-completion", (req, res) =>
    res.json(memberCompletion(db, req.member)),
  );
  app.use("/api/member/:org", (req, res, next) => {
    if (["/family", "/password"].includes(req.path)) return next();
    const completion = memberCompletion(db, req.member);
    if (completion.required)
      return res.status(403).json({
        error: "Complete required family profiles before continuing.",
        code: "PROFILE_COMPLETION_REQUIRED",
        ...completion,
      });
    next();
  });
  installMemberRegistrationRoutes(app, db);
  installMemberRecordRoutes(app, db);
  installMemberScheduleRoutes(app, db);
  installMemberAttendanceRoutes(app, db);
  app.get("/api/member/:org/family", (req, res) =>
    res.json(memberFamily(db, req.member)),
  );
  app.post("/api/member/:org/password", (req, res) => {
    limit(req, "password");
    const p = z
      .object({
        current_password: z.string().min(1).max(128),
        new_password: password,
      })
      .parse(req.body);
    const account = db
      .prepare("SELECT * FROM member_accounts WHERE id=? AND org_id=?")
      .get(req.member.id, req.member.org_id);
    if (!passwordMatches(p.current_password, account.password_hash))
      throw fail("Current password is incorrect.");
    transaction(db, () => {
      db.prepare("UPDATE member_accounts SET password_hash=? WHERE id=?").run(
        passwordHash(p.new_password),
        account.id,
      );
      db.prepare("DELETE FROM member_sessions WHERE account_id=?").run(
        account.id,
      );
      audit(
        db,
        { id: account.id, org_id: account.org_id },
        "member.password_changed",
        "person",
        account.person_id,
      );
    });
    issue(res, account);
    res.json({ ok: true });
  });
}

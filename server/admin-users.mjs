import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  audit,
  id,
  now,
  passwordHash,
  passwordMatches,
  transaction,
} from "./db.mjs";
import { DomainError } from "./domain.mjs";
import { authDeliveryMode, deliverAuthLink } from "./auth-delivery.mjs";

const digest = (token) => createHash("sha256").update(token).digest("hex");
const fail = (message, status = 400) => new DomainError(message, status);
export const CONSOLE_ROLES = ["owner", "admin", "manager", "reporter"];
const INVITATION_TTL_MS = 7 * 24 * 60 * 60000;
const RESET_TTL_MS = 30 * 60000;
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
export const consolePassword = z
  .string()
  .min(12, "Use at least 12 characters for your password.")
  .max(128);

const safeUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  active: !!u.active,
  revision: u.revision,
  deactivated_at: u.deactivated_at ?? null,
});
const safeInvitation = (i) => ({
  id: i.id,
  email: i.email,
  name: i.name,
  role: i.role,
  status: i.status,
  expires_at: i.expires_at,
  sent_at: i.sent_at,
  delivery_error: i.delivery_error,
  created_at: i.created_at,
});

export function listConsoleAccess(db, org) {
  return {
    users: db
      .prepare(
        "SELECT id,name,email,role,active,revision,deactivated_at FROM users WHERE org_id=? ORDER BY name",
      )
      .all(org)
      .map(safeUser),
    invitations: db
      .prepare(
        "SELECT * FROM admin_invitations WHERE org_id=? ORDER BY created_at DESC",
      )
      .all(org)
      .map(safeInvitation),
  };
}

function emailTakenByConsole(db, value) {
  return db
    .prepare("SELECT id,org_id FROM users WHERE lower(email)=?")
    .get(value.toLowerCase());
}
function emailTakenByMember(db, org, value) {
  return db
    .prepare(
      "SELECT id FROM member_accounts WHERE org_id=? AND email=? COLLATE NOCASE",
    )
    .get(org, value);
}
const pendingInvitation = (db, org, value) =>
  db
    .prepare(
      "SELECT * FROM admin_invitations WHERE org_id=? AND email=? AND status='Pending'",
    )
    .get(org, value);

export function inviteConsoleUser(db, actor, input) {
  const p = z
    .object({
      email,
      name: z.string().trim().min(1).max(100),
      role: z.enum(CONSOLE_ROLES),
    })
    .parse(input);
  return transaction(db, () => {
    if (emailTakenByConsole(db, p.email))
      throw fail(
        "This email already has console access. Change its role from the user list instead.",
        409,
      );
    if (emailTakenByMember(db, actor.org_id, p.email))
      throw fail(
        "This email belongs to a member account in this organization. Use a different email for console access.",
        409,
      );
    const pending = pendingInvitation(db, actor.org_id, p.email);
    if (pending)
      throw Object.assign(
        fail(
          "An invitation is already pending for this email. Resend or revoke it.",
          409,
        ),
        { invitation_id: pending.id },
      );
    const token = randomBytes(32).toString("hex"),
      invitationId = id(),
      stamp = now();
    db.prepare(
      "INSERT INTO admin_invitations(id,org_id,email,name,role,token_hash,expires_at,invited_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      invitationId,
      actor.org_id,
      p.email,
      p.name,
      p.role,
      digest(token),
      new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
      actor.id,
      stamp,
      stamp,
    );
    audit(db, actor, "admin_invitation.created", "admin_invitation", invitationId, {
      email: p.email,
      name: p.name,
      role: p.role,
    });
    return {
      invitation: safeInvitation(
        db
          .prepare("SELECT * FROM admin_invitations WHERE id=?")
          .get(invitationId),
      ),
      token,
    };
  });
}

function loadPendingInvitation(db, org, invitationId) {
  const invitation = db
    .prepare("SELECT * FROM admin_invitations WHERE id=? AND org_id=?")
    .get(invitationId, org);
  if (!invitation) throw fail("Invitation not found", 404);
  if (invitation.status !== "Pending")
    throw fail(`This invitation is already ${invitation.status.toLowerCase()}.`, 409);
  return invitation;
}

export function resendConsoleInvitation(db, actor, invitationId) {
  return transaction(db, () => {
    const invitation = loadPendingInvitation(db, actor.org_id, invitationId);
    if (emailTakenByConsole(db, invitation.email))
      throw fail(
        "This email already has console access. Revoke the invitation instead.",
        409,
      );
    if (emailTakenByMember(db, actor.org_id, invitation.email))
      throw fail(
        "This email now belongs to a member account. Revoke the invitation instead.",
        409,
      );
    const token = randomBytes(32).toString("hex"),
      stamp = now();
    db.prepare(
      "UPDATE admin_invitations SET token_hash=?,expires_at=?,sent_at=NULL,delivery_error='',updated_at=? WHERE id=?",
    ).run(
      digest(token),
      new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
      stamp,
      invitation.id,
    );
    audit(
      db,
      actor,
      "admin_invitation.resent",
      "admin_invitation",
      invitation.id,
      { email: invitation.email },
    );
    return {
      invitation: safeInvitation(
        db
          .prepare("SELECT * FROM admin_invitations WHERE id=?")
          .get(invitation.id),
      ),
      token,
    };
  });
}

export function revokeConsoleInvitation(db, actor, invitationId) {
  return transaction(db, () => {
    const invitation = loadPendingInvitation(db, actor.org_id, invitationId);
    db.prepare(
      "UPDATE admin_invitations SET status='Revoked',updated_at=? WHERE id=?",
    ).run(now(), invitation.id);
    audit(
      db,
      actor,
      "admin_invitation.revoked",
      "admin_invitation",
      invitation.id,
      { email: invitation.email },
    );
    return { ok: true };
  });
}

export function markInvitationDelivered(db, org, invitationId, error = "") {
  db.prepare(
    "UPDATE admin_invitations SET sent_at=?,delivery_error=?,updated_at=? WHERE id=? AND org_id=?",
  ).run(error ? null : now(), error, now(), invitationId, org);
}

const updateSchema = z
  .object({
    role: z.enum(CONSOLE_ROLES).optional(),
    active: z.boolean().optional(),
    expected_revision: z.number().int().positive(),
  })
  .refine((v) => v.role !== undefined || v.active !== undefined, {
    message: "Provide a role or active change.",
  });
export function updateConsoleUser(db, actor, userId, input) {
  const p = updateSchema.parse(input);
  return transaction(db, () => {
    const user = db
      .prepare("SELECT * FROM users WHERE id=? AND org_id=?")
      .get(userId, actor.org_id);
    if (!user) throw fail("User not found", 404);
    if (user.revision !== p.expected_revision)
      throw fail("This user changed. Reload before saving.", 409);
    const role = p.role ?? user.role,
      active = p.active ?? !!user.active;
    const losesOwner =
      user.role === "owner" &&
      !!user.active &&
      (role !== "owner" || !active);
    if (
      losesOwner &&
      !db
        .prepare(
          "SELECT 1 FROM users WHERE org_id=? AND role='owner' AND active=1 AND id!=? LIMIT 1",
        )
        .get(actor.org_id, user.id)
    )
      throw fail(
        "Keep at least one active owner. Promote another owner first.",
        409,
      );
    if (role === user.role && active === !!user.active) return safeUser(user);
    const deactivated = !active && !!user.active,
      reactivated = active && !user.active;
    db.prepare(
      "UPDATE users SET role=?,active=?,revision=revision+1,deactivated_at=? WHERE id=? AND org_id=?",
    ).run(
      role,
      +active,
      deactivated ? now() : reactivated ? null : user.deactivated_at,
      user.id,
      actor.org_id,
    );
    // Role changes and deactivation end every existing console session.
    if (role !== user.role || deactivated)
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    if (deactivated)
      db.prepare("DELETE FROM admin_reset_tokens WHERE user_id=?").run(user.id);
    audit(db, actor, "admin_user.updated", "user", user.id, {
      role: { from: user.role, to: role },
      active: { from: !!user.active, to: active },
    });
    return safeUser(
      db.prepare("SELECT * FROM users WHERE id=?").get(user.id),
    );
  });
}

export function acceptConsoleInvitation(db, input) {
  const p = z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      password: consolePassword,
      name: z.string().trim().min(1).max(100).optional(),
    })
    .parse(input);
  return transaction(db, () => {
    const invitation = db
      .prepare("SELECT * FROM admin_invitations WHERE token_hash=?")
      .get(digest(p.token));
    if (
      !invitation ||
      invitation.status !== "Pending" ||
      invitation.expires_at <= now()
    )
      throw fail(
        "This invitation link is invalid or expired. Ask an owner for a new invitation.",
      );
    if (
      !db
        .prepare("SELECT 1 FROM organizations WHERE id=?")
        .get(invitation.org_id)
    )
      throw fail("This invitation is no longer valid.", 409);
    if (emailTakenByConsole(db, invitation.email))
      throw fail(
        "An account already exists for this email. Sign in or reset its password.",
        409,
      );
    if (emailTakenByMember(db, invitation.org_id, invitation.email))
      throw fail(
        "This email belongs to a member account. Contact the organization.",
        409,
      );
    const userId = id(),
      stamp = now();
    // Role, organization and email come from the invitation, never the request.
    db.prepare(
      "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)",
    ).run(
      userId,
      invitation.org_id,
      p.name || invitation.name,
      invitation.email,
      passwordHash(p.password),
      invitation.role,
    );
    db.prepare(
      "UPDATE admin_invitations SET status='Accepted',updated_at=? WHERE id=?",
    ).run(stamp, invitation.id);
    audit(
      db,
      { id: userId, org_id: invitation.org_id },
      "admin_invitation.accepted",
      "user",
      userId,
      { invitation_id: invitation.id, email: invitation.email, role: invitation.role },
    );
    return db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  });
}

export function beginConsoleRecovery(db, input) {
  const value = z.object({ email }).parse(input).email;
  const user = db
    .prepare("SELECT * FROM users WHERE lower(email)=?")
    .get(value);
  // Inactive accounts cannot redeem recovery challenges.
  if (!user || !user.active) return null;
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM admin_reset_tokens WHERE expires_at<=?").run(now());
  db.prepare(
    "INSERT INTO admin_reset_tokens VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at",
  ).run(
    digest(token),
    user.id,
    new Date(Date.now() + RESET_TTL_MS).toISOString(),
    now(),
  );
  return { token, email: user.email };
}

export function finishConsoleRecovery(db, input) {
  const p = z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      password: consolePassword,
    })
    .parse(input);
  return transaction(db, () => {
    const row = db
      .prepare(
        "SELECT t.*,u.active,u.org_id FROM admin_reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?",
      )
      .get(digest(p.token));
    if (!row || row.expires_at <= now() || !row.active)
      throw fail(
        "This password reset link is invalid or expired. Request a new link.",
      );
    db.prepare(
      "UPDATE users SET password_hash=?,revision=revision+1 WHERE id=?",
    ).run(passwordHash(p.password), row.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(row.user_id);
    db.prepare("DELETE FROM admin_reset_tokens WHERE user_id=?").run(
      row.user_id,
    );
    audit(
      db,
      { org_id: row.org_id },
      "reset_password",
      "user",
      row.user_id,
    );
    return { ok: true };
  });
}

export function changeConsolePassword(db, actor, input) {
  const p = z
    .object({
      current_password: z.string().min(1).max(256),
      new_password: consolePassword,
    })
    .parse(input);
  const user = db
    .prepare("SELECT * FROM users WHERE id=? AND org_id=?")
    .get(actor.id, actor.org_id);
  if (!user || !user.active)
    throw fail("This account is no longer active.", 403);
  if (!passwordMatches(p.current_password, user.password_hash))
    throw fail("Current password is incorrect.");
  return transaction(db, () => {
    db.prepare(
      "UPDATE users SET password_hash=?,revision=revision+1 WHERE id=?",
    ).run(passwordHash(p.new_password), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    db.prepare("DELETE FROM admin_reset_tokens WHERE user_id=?").run(user.id);
    audit(db, actor, "password_changed", "user", user.id);
    return { ok: true };
  });
}

export function issueAdminSession(db, res, env, userId) {
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now());
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    digest(token),
    userId,
    new Date(Date.now() + 86400000).toISOString(),
  );
  res.cookie("fieldhouse_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.COOKIE_SECURE === "true",
    maxAge: 86400000,
    path: "/",
  });
}

const ownerOnly = (req) => {
  if (req.actor.role !== "owner")
    throw fail("Only an organization owner can manage console access.", 403);
};

function rateLimiter() {
  const attempts = new Map();
  return (req, action, max = 6) => {
    const key = `${req.ip}:${action}`,
      time = Date.now();
    if (attempts.size > 10000)
      for (const [k, v] of attempts) if (v.until < time) attempts.delete(k);
    let entry = attempts.get(key);
    if (!entry || entry.until < time) {
      entry = { count: 0, until: time + 15 * 60000 };
      attempts.set(key, entry);
    }
    if (++entry.count > max)
      throw fail("Too many attempts. Try again in 15 minutes.", 429);
  };
}

// Public console-auth endpoints. Installed before the session gate.
export function installConsoleAuthRoutes(
  app,
  db,
  { env = process.env, sendInvitation, sendRecovery } = {},
) {
  const limit = rateLimiter();
  app.post("/api/auth/accept-invitation", (req, res) => {
    limit(req, "accept-invitation");
    const user = acceptConsoleInvitation(db, req.body);
    issueAdminSession(db, res, env, user.id);
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      org_id: user.org_id,
    });
  });
  app.post("/api/auth/forgot-password", async (req, res) => {
    limit(req, "forgot-password");
    const mode = authDeliveryMode(env);
    if (!mode.preview && !sendRecovery && !mode.configured)
      throw fail(
        "Account email delivery is not configured. Contact the organization.",
        503,
      );
    const pending = beginConsoleRecovery(db, req.body);
    const message =
      "If an active console account matches that email, a password reset link will be sent. It expires in 30 minutes.";
    if (pending) {
      const path = `/reset-password?token=${pending.token}`;
      if (mode.preview && !sendRecovery)
        return res.status(202).json({ message, development_link: path });
      try {
        await deliverAuthLink({
          env,
          send: sendRecovery,
          to: pending.email,
          path,
          subject: "Reset your Athlentry administrator password",
          text: "Reset your administrator password:",
          idempotency: "admin-reset",
          token: pending.token,
        });
      } catch {
        // Never disclose account existence or provider details publicly.
        console.error("Administrator recovery email delivery failed.");
      }
    }
    res.status(202).json({ message });
  });
  app.post("/api/auth/reset-password", (req, res) => {
    limit(req, "reset-password");
    const result = finishConsoleRecovery(db, req.body);
    res.clearCookie("fieldhouse_session", { path: "/" });
    res.json(result);
  });
}

// Owner-scoped console access management. Installed after the admin gate.
export function installAdminAccessRoutes(
  app,
  db,
  { env = process.env, sendInvitation } = {},
) {
  // Checked before creating a challenge: an unconfigured live deployment
  // refuses outright instead of persisting an undeliverable invitation.
  const ensureDeliverable = () => {
    const mode = authDeliveryMode(env);
    if (!mode.preview && !sendInvitation && !mode.configured)
      throw fail(
        "Account email delivery is not configured. Contact the organization.",
        503,
      );
    return mode;
  };
  const deliver = async (req, res, result, makePath, status = 201) => {
    const mode = ensureDeliverable();
    if (mode.preview && !sendInvitation)
      return res.status(status).json({
        ...result.invitation,
        delivery: "preview",
        development_link: makePath(result.token),
      });
    try {
      await deliverAuthLink({
        env,
        send: sendInvitation,
        to: result.invitation.email,
        path: makePath(result.token),
        subject: "You have been invited to a Athlentry organization",
        text: "Accept your administrator invitation:",
        idempotency: "admin-invite",
        token: result.token,
      });
      markInvitationDelivered(db, req.actor.org_id, result.invitation.id);
    } catch (error) {
      markInvitationDelivered(
        db,
        req.actor.org_id,
        result.invitation.id,
        error.status ? error.message : "Delivery failed",
      );
      throw fail(
        "The invitation was saved but the email could not be sent. Resend it from the user list.",
        503,
      );
    }
    res.status(status).json({
      ...safeInvitation(
        db
          .prepare("SELECT * FROM admin_invitations WHERE id=?")
          .get(result.invitation.id),
      ),
      delivery: "sent",
    });
  };
  const invitationPath = (token) => `/accept-invitation?token=${token}`;

  app.get("/api/admin-users", (req, res) => {
    ownerOnly(req);
    res.json(listConsoleAccess(db, req.actor.org_id));
  });
  app.post("/api/admin-users/invitations", async (req, res) => {
    ownerOnly(req);
    ensureDeliverable();
    await deliver(req, res, inviteConsoleUser(db, req.actor, req.body), (t) =>
      invitationPath(t),
    );
  });
  app.post("/api/admin-users/invitations/:id/resend", async (req, res) => {
    ownerOnly(req);
    ensureDeliverable();
    await deliver(
      req,
      res,
      resendConsoleInvitation(db, req.actor, req.params.id),
      (t) => invitationPath(t),
      200,
    );
  });
  app.delete("/api/admin-users/invitations/:id", (req, res) => {
    ownerOnly(req);
    res.json(revokeConsoleInvitation(db, req.actor, req.params.id));
  });
  app.patch("/api/admin-users/:id", (req, res) => {
    ownerOnly(req);
    res.json(updateConsoleUser(db, req.actor, req.params.id, req.body));
  });
}

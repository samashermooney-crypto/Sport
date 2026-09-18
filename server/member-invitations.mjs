import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit, id, now, passwordHash, transaction, unpack } from "./db.mjs";
import { DomainError, requireEntity } from "./domain.mjs";
import { authDeliveryMode, deliverAuthLink } from "./auth-delivery.mjs";
import { consolePassword } from "./admin-users.mjs";

const digest = (token) => createHash("sha256").update(token).digest("hex");
const fail = (message, status = 400) => new DomainError(message, status);
const INVITATION_TTL_MS = 7 * 24 * 60 * 60000;
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

const safeInvitation = (i) => ({
  id: i.id,
  email: i.email,
  status: i.status,
  expires_at: i.expires_at,
  sent_at: i.sent_at,
  delivery_error: i.delivery_error,
  created_at: i.created_at,
});
const safeAccount = (a) =>
  a
    ? {
        id: a.id,
        email: a.email,
        verified_at: a.verified_at,
        created_at: a.created_at,
      }
    : null;

function organization(db, org) {
  const row = db
    .prepare("SELECT id,name,timezone FROM organizations WHERE id=?")
    .get(org);
  if (!row) throw fail("Organization not found", 404);
  return row;
}
// Adult means a provable 18+ birthdate, or a parent/staff record without one.
function adultPerson(person, timezone) {
  if (person.birthdate) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
    }).format(new Date());
    const [y, m, d] = person.birthdate.split("-").map(Number),
      [cy, cm, cd] = today.split("-").map(Number);
    return (
      person.birthdate <= today &&
      cy - y - (cm < m || (cm === m && cd < d) ? 1 : 0) >= 18
    );
  }
  return ["parent", "staff"].includes(person.kind);
}
const personAccount = (db, org, personId) =>
  db
    .prepare(
      "SELECT id,email,verified_at,created_at FROM member_accounts WHERE org_id=? AND person_id=?",
    )
    .get(org, personId);
const pendingFor = (db, org, personId) =>
  db
    .prepare(
      "SELECT * FROM member_account_invitations WHERE org_id=? AND person_id=? AND status='Pending'",
    )
    .get(org, personId);

function eligibility(db, org, person) {
  const site = organization(db, org);
  if (unpack(person).archived_at)
    return {
      ok: false,
      reason: "The member is archived. Restore the member first.",
    };
  if (!adultPerson(person, site.timezone))
    return {
      ok: false,
      reason:
        "Only adult members can receive account access. Children stay under a family supervisor's account.",
    };
  if (personAccount(db, org, person.id))
    return { ok: false, reason: "This member already has an account." };
  return { ok: true, reason: "" };
}

export function memberAccountAccess(db, org, personId) {
  const person = requireEntity(db, "people", personId, org),
    account = personAccount(db, org, personId),
    invitations = db
      .prepare(
        "SELECT * FROM member_account_invitations WHERE org_id=? AND person_id=? ORDER BY created_at DESC",
      )
      .all(org, personId)
      .map(safeInvitation),
    state = eligibility(db, org, person);
  return {
    person_id: personId,
    state: account ? "active" : invitations.some((i) => i.status === "Pending") ? "pending" : "none",
    account: safeAccount(account),
    invitations,
    eligible: state.ok,
    reason: state.reason || "",
  };
}

function emailConflict(db, org, value, personId) {
  if (db.prepare("SELECT 1 FROM people WHERE org_id=? AND id!=? AND lower(trim(email))=? LIMIT 1").get(org, personId, value))
    throw fail("This email is shared by another member record. Give this adult a unique email on their profile before inviting them.", 409);
  if (
    db
      .prepare(
        "SELECT 1 FROM member_accounts WHERE org_id=? AND email=? COLLATE NOCASE",
      )
      .get(org, value)
  )
    throw fail(
      "This email already belongs to a member account in this organization.",
      409,
    );
  if (db.prepare("SELECT 1 FROM users WHERE org_id=? AND lower(email)=?").get(org, value))
    throw fail(
      "This email belongs to a console account in this organization. Use a different email.",
      409,
    );
}
function resolveInviteEmail(db, org, person, supplied) {
  const record = (person.email || "").trim().toLowerCase();
  if (record) {
    if (supplied && supplied !== record)
      throw fail(
        "The invitation email must match the member record. Update the member record first.",
        409,
      );
    return { intended: record, snapshot: record };
  }
  if (!supplied)
    throw fail(
      "The member record has no email. Supply the invitation email.",
    );
  return { intended: supplied, snapshot: "" };
}

export function inviteMemberAccount(db, actor, personId, input) {
  const p = z
    .object({ email: email.optional() })
    .parse(input ?? {});
  return transaction(db, () => {
    const person = requireEntity(db, "people", personId, actor.org_id),
      state = eligibility(db, actor.org_id, person);
    if (!state.ok) throw fail(state.reason, 409);
    const pending = pendingFor(db, actor.org_id, personId);
    if (pending)
      throw Object.assign(
        fail(
          "An invitation is already pending for this member. Resend or revoke it.",
          409,
        ),
        { invitation_id: pending.id },
      );
    const { intended, snapshot } = resolveInviteEmail(
      db,
      actor.org_id,
      person,
      p.email,
    );
    emailConflict(db, actor.org_id, intended, personId);
    const token = randomBytes(32).toString("hex"),
      invitationId = id(),
      stamp = now();
    db.prepare(
      "INSERT INTO member_account_invitations(id,org_id,person_id,email,person_email,token_hash,expires_at,invited_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      invitationId,
      actor.org_id,
      personId,
      intended,
      snapshot,
      digest(token),
      new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
      actor.id,
      stamp,
      stamp,
    );
    audit(db, actor, "member_invitation.created", "person", personId, {
      invitation_id: invitationId,
      email: intended,
    });
    return {
      invitation: safeInvitation(
        db
          .prepare("SELECT * FROM member_account_invitations WHERE id=?")
          .get(invitationId),
      ),
      token,
    };
  });
}

const loadPending = (db, org, personId, inviteId) => {
  const invitation = db
    .prepare(
      "SELECT * FROM member_account_invitations WHERE id=? AND org_id=? AND person_id=?",
    )
    .get(inviteId, org, personId);
  if (!invitation) throw fail("Invitation not found", 404);
  if (invitation.status !== "Pending")
    throw fail(`This invitation is already ${invitation.status.toLowerCase()}.`, 409);
  return invitation;
};

// Re-verify at resend exactly what issuance verified: the member must still be
// an active adult whose record email has not changed incompatibly.
function recheckEligible(db, org, invitation) {
  const person = db
    .prepare("SELECT * FROM people WHERE id=? AND org_id=?")
    .get(invitation.person_id, org);
  if (!person) throw fail("The member record no longer exists.", 409);
  const state = eligibility(db, org, person);
  if (!state.ok) throw fail(state.reason, 409);
  if ((person.email || "").trim().toLowerCase() !== invitation.person_email)
    throw fail(
      "The member record email changed. Revoke this invitation and issue a new one.",
      409,
    );
  emailConflict(db, org, invitation.email, invitation.person_id);
  return person;
}

export function resendMemberInvitation(db, actor, personId, inviteId) {
  return transaction(db, () => {
    const invitation = loadPending(db, actor.org_id, personId, inviteId);
    recheckEligible(db, actor.org_id, invitation);
    const token = randomBytes(32).toString("hex"),
      stamp = now();
    db.prepare(
      "UPDATE member_account_invitations SET token_hash=?,expires_at=?,sent_at=NULL,delivery_error='',updated_at=? WHERE id=?",
    ).run(
      digest(token),
      new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
      stamp,
      invitation.id,
    );
    audit(db, actor, "member_invitation.resent", "person", personId, {
      invitation_id: invitation.id,
    });
    return {
      invitation: safeInvitation(
        db
          .prepare("SELECT * FROM member_account_invitations WHERE id=?")
          .get(invitation.id),
      ),
      token,
    };
  });
}

export function revokeMemberInvitation(db, actor, personId, inviteId) {
  return transaction(db, () => {
    const invitation = loadPending(db, actor.org_id, personId, inviteId);
    db.prepare(
      "UPDATE member_account_invitations SET status='Revoked',updated_at=? WHERE id=?",
    ).run(now(), invitation.id);
    audit(db, actor, "member_invitation.revoked", "person", personId, {
      invitation_id: invitation.id,
    });
    return { ok: true };
  });
}

export function markMemberInvitationDelivered(db, org, inviteId, error = "") {
  db.prepare(
    "UPDATE member_account_invitations SET sent_at=?,delivery_error=?,updated_at=? WHERE id=? AND org_id=?",
  ).run(error ? null : now(), error, now(), inviteId, org);
}

export function acceptMemberInvitation(db, org, input) {
  const p = z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      password: consolePassword,
    })
    .parse(input);
  return transaction(db, () => {
    const invitation = db
      .prepare(
        "SELECT * FROM member_account_invitations WHERE token_hash=? AND org_id=?",
      )
      .get(digest(p.token), org);
    if (
      !invitation ||
      invitation.status !== "Pending" ||
      invitation.expires_at <= now()
    )
      throw fail(
        "This invitation link is invalid or expired. Ask the organization for a new invitation.",
      );
    // The challenge is bound to this exact person and email; re-verify the
    // record has not changed incompatibly since the invitation was issued.
    const person = recheckEligible(db, org, invitation);
    const accountId = id(),
      stamp = now();
    try {
      db.prepare(
        "INSERT INTO member_accounts VALUES(?,?,?,?,?,?,?)",
      ).run(
        accountId,
        org,
        invitation.person_id,
        invitation.email,
        passwordHash(p.password),
        stamp,
        stamp,
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE"))
        throw fail(
          "This member already has an account. Sign in instead.",
          409,
        );
      throw error;
    }
    // An administrator-supplied login email becomes the record's contact email.
    if (!invitation.person_email)
      db.prepare("UPDATE people SET email=? WHERE id=? AND org_id=?").run(
        invitation.email,
        person.id,
        org,
      );
    db.prepare(
      "UPDATE member_account_invitations SET status='Accepted',updated_at=? WHERE id=?",
    ).run(stamp, invitation.id);
    db.prepare(
      "UPDATE member_account_invitations SET status='Revoked',updated_at=? WHERE person_id=? AND org_id=? AND status='Pending'",
    ).run(stamp, person.id, org);
    audit(
      db,
      { id: accountId, org_id: org },
      "member.account_activated",
      "person",
      person.id,
      { invitation_id: invitation.id, email: invitation.email },
    );
    return { id: accountId, org_id: org, person_id: person.id };
  });
}

const managerOnly = (req) => {
  if (!["owner", "admin"].includes(req.actor.role))
    throw fail(
      "Only owners and administrators can manage member account access.",
      403,
    );
};

// Owner/admin member-account access routes. Installed after the admin gate.
export function installMemberAccessRoutes(
  app,
  db,
  { env = process.env, sendMemberInvitation } = {},
) {
  const memberInvitationPath = (org, token) =>
    `/site/${encodeURIComponent(org)}/account/accept-invitation?token=${token}`;
  const ensureDeliverable = () => {
    const mode = authDeliveryMode(env);
    if (!mode.preview && !sendMemberInvitation && !mode.configured)
      throw fail(
        "Account email delivery is not configured. Contact the organization.",
        503,
      );
    return mode;
  };
  const deliver = async (req, res, result, status = 201) => {
    const mode = ensureDeliverable();
    if (mode.preview && !sendMemberInvitation)
      return res.status(status).json({
        ...result.invitation,
        delivery: "preview",
        development_link: memberInvitationPath(
          req.actor.org_id,
          result.token,
        ),
      });
    try {
      await deliverAuthLink({
        env,
        send: sendMemberInvitation,
        to: result.invitation.email,
        path: memberInvitationPath(req.actor.org_id, result.token),
        subject: "Your Athlentry member account invitation",
        text: "Activate your member account:",
        idempotency: "member-invite",
        token: result.token,
      });
      markMemberInvitationDelivered(
        db,
        req.actor.org_id,
        result.invitation.id,
      );
    } catch (error) {
      markMemberInvitationDelivered(
        db,
        req.actor.org_id,
        result.invitation.id,
        error.status ? error.message : "Delivery failed",
      );
      throw fail(
        "The invitation was saved but the email could not be sent. Resend it from the member record.",
        503,
      );
    }
    res.status(status).json({
      ...safeInvitation(
        db
          .prepare(
            "SELECT * FROM member_account_invitations WHERE id=?",
          )
          .get(result.invitation.id),
      ),
      delivery: "sent",
    });
  };
  app.get("/api/people/:id/account-access", (req, res) => {
    managerOnly(req);
    res.json(memberAccountAccess(db, req.actor.org_id, req.params.id));
  });
  app.post("/api/people/:id/account-invitations", async (req, res) => {
    managerOnly(req);
    ensureDeliverable();
    await deliver(
      req,
      res,
      inviteMemberAccount(db, req.actor, req.params.id, req.body),
    );
  });
  app.post(
    "/api/people/:id/account-invitations/:inviteId/resend",
    async (req, res) => {
      managerOnly(req);
      ensureDeliverable();
      await deliver(
        req,
        res,
        resendMemberInvitation(
          db,
          req.actor,
          req.params.id,
          req.params.inviteId,
        ),
        200,
      );
    },
  );
  app.delete("/api/people/:id/account-invitations/:inviteId", (req, res) => {
    managerOnly(req);
    res.json(
      revokeMemberInvitation(db, req.actor, req.params.id, req.params.inviteId),
    );
  });
}

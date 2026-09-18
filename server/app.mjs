import { installOrganizationSettings } from "./organization-settings.mjs";
import { installProgramStaffRoutes } from "./program-staff.mjs";
import { installTryoutRoutes } from "./tryouts.mjs";
import { installRegistrationLifecycleRoutes } from "./registration-lifecycle.mjs";
import { installScheduleOptionRoutes } from "./schedule-options.mjs";
import { installScheduleImportRoutes } from "./schedule-import-mapping.mjs";
import { installGlobalSearchRoutes } from "./global-search.mjs";
import { listRegistrations } from "./registration-list.mjs";
import { installPaymentPlanReportRoutes } from "./payment-plan-report.mjs";
import {
  installInvoiceInstallmentRoutes,
  invoiceInstallments,
  scheduledInvoiceDates,
} from "./invoice-installments.mjs";
import { installPaymentPlanRoutes } from "./payment-plans.mjs";
import { installProgramSummaryRoutes } from "./program-summary.mjs";
import { installAttendanceRoutes } from "./attendance.mjs";
import { installTeamReportRoutes } from "./team-report.mjs";
import { installMemberPropertyRoutes } from "./member-completion.mjs";
import { installStaffRoleRoutes } from "./staff-roles.mjs";
import express from "express";
import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { id, now, passwordMatches, unpack, audit } from "./db.mjs";
import {
  saveProgram,
  programStats,
  requireEntity,
  register,
  recordPayment,
  saveEvent,
  DomainError,
} from "./domain.mjs";
import { installDirectoryRoutes } from "./directory.mjs";
import { installMessagingRoutes } from "./messaging.mjs";
import { installTeamRoutes } from "./teams.mjs";
import { installRuleRoutes } from "./program-rules.mjs";
import { installCommerceRoutes } from "./commerce.mjs";
import { installPublicCommerceRoutes } from "./public-commerce.mjs";
import { installMemberStoreRoutes } from "./member-store.mjs";
import { installFormRoutes } from "./forms.mjs";
import { installStandingsRoutes } from "./standings.mjs";
import { installTerminologyRoutes } from "./terminology.mjs";
import { installMemberAuthRoutes } from "./member-auth.mjs";
import {
  installConsoleAuthRoutes,
  installAdminAccessRoutes,
  changeConsolePassword,
  issueAdminSession,
} from "./admin-users.mjs";
import { installMemberAccessRoutes } from "./member-invitations.mjs";
import {
  installPublicWebsiteRoutes,
  installWebsiteRoutes,
} from "./website.mjs";
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
export function makeApp(db, { memberAuth = {}, auth = {} } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // The CSV limit is 2 MB decoded; JSON escaping can expand it substantially.
  app.use("/api/schedule/import", express.json({ limit: "13mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "X-Frame-Options",
      req.path.startsWith("/site/") ? "SAMEORIGIN" : "DENY",
    );
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_, res) => res.json({ status: "ok" }));
  const attempts = new Map();
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.get("X-Fieldhouse-Request") !== "1")
        return res.status(403).json({ error: "Invalid request source" });
      const origin = req.get("origin");
      if (origin) {
        try {
          const developmentOrigins =
            process.env.NODE_ENV !== "production"
              ? ["http://127.0.0.1:5173", "http://localhost:5173"]
              : [];
          if (
            new URL(origin).host !== req.get("host") &&
            !developmentOrigins.includes(origin)
          )
            return res
              .status(403)
              .json({ error: "Cross-origin writes are not allowed" });
        } catch {
          return res.status(403).json({ error: "Invalid origin" });
        }
      }
    }
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("fieldhouse_session="))
      ?.split("=")[1];
    if (token)
      req.actor = db
        .prepare(
          "SELECT u.id,u.org_id,u.name,u.email,u.role FROM sessions s JOIN users u ON s.user_id=u.id AND u.active=1 WHERE s.token_hash=? AND s.expires_at>?",
        )
        .get(tokenHash(token), now());
    next();
  });
  app.post("/api/auth/login", (req, res) => {
    const { email, password } = z
      .object({ email: z.email(), password: z.string().min(1).max(256) })
      .parse(req.body);
    const key = req.ip + ":" + email.toLowerCase(),
      entry = attempts.get(key);
    if (entry && entry.count >= 8 && entry.until > Date.now())
      throw new DomainError("Too many attempts. Try again in 15 minutes.", 429);
    const user = db
      .prepare("SELECT * FROM users WHERE lower(email)=?")
      .get(email.toLowerCase());
    if (!user || !passwordMatches(password, user.password_hash)) {
      attempts.set(key, {
        count: entry?.until > Date.now() ? entry.count + 1 : 1,
        until: Date.now() + 900000,
      });
      throw new DomainError("Email or password is incorrect", 401);
    }
    if (!user.active)
      throw new DomainError(
        "This account has been deactivated. Contact an organization owner.",
        403,
      );
    attempts.delete(key);
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      tokenHash(token),
      user.id,
      new Date(Date.now() + 86400000).toISOString(),
    );
    res.cookie("fieldhouse_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 86400000,
      path: "/",
    });
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      org_id: user.org_id,
    });
  });
  installConsoleAuthRoutes(app, db, auth);
  installMemberAuthRoutes(app, db, memberAuth);
  installPublicWebsiteRoutes(app, db);
  installPublicCommerceRoutes(app, db);
  installMemberStoreRoutes(app, db);
  app.use("/api", (req, res, next) => {
    if (!req.actor)
      return res.status(401).json({ error: "Sign in to continue" });
    next();
  });
  app.post("/api/auth/logout", (req, res) => {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("fieldhouse_session="))
      ?.split("=")[1];
    if (token)
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
        tokenHash(token),
      );
    res.clearCookie("fieldhouse_session", { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/session", (req, res) =>
    res.json({
      user: req.actor,
      organization: db
        .prepare("SELECT * FROM organizations WHERE id=?")
        .get(req.actor.org_id),
    }),
  );
  app.post("/api/auth/change-password", (req, res) => {
    changeConsolePassword(db, req.actor, req.body);
    issueAdminSession(db, res, process.env, req.actor.id);
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    if (!["owner", "admin", "manager", "reporter"].includes(req.actor.role))
      return res
        .status(403)
        .json({ error: "This account does not have admin-console access" });
    if (!["GET", "HEAD"].includes(req.method) && req.actor.role === "reporter")
      return res.status(403).json({ error: "This role has read-only access" });
    next();
  });
  installOrganizationSettings(app, db);
  installAdminAccessRoutes(app, db, auth);
  installMemberAccessRoutes(app, db, auth);
  installProgramSummaryRoutes(app, db);
  installPaymentPlanRoutes(app, db);
  installInvoiceInstallmentRoutes(app, db);
  installPaymentPlanReportRoutes(app, db);
  app.get("/api/programs", (req, res) =>
    res.json(programStats(db, req.actor.org_id)),
  );
  app.get("/api/dashboard", (req, res) => {
    const org = db
      .prepare("SELECT * FROM organizations WHERE id=?")
      .get(req.actor.org_id);
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: org.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const today = formatter.format(new Date());
    const inPeriod = (value) =>
      req.query.period !== "Today" ||
      formatter.format(new Date(value)) === today;
    const payments = db
      .prepare("SELECT * FROM transactions WHERE org_id=?")
      .all(org.id)
      .filter((t) => inPeriod(t.created_at));
    const scheduleDates = scheduledInvoiceDates(db, req.actor.org_id);
    const invoices = db
      .prepare("SELECT * FROM invoices WHERE org_id=? AND voided=0")
      .all(org.id)
      .map((i) => ({ ...i, ...(scheduleDates.get(i.id) || {}) }))
      .filter(
        (i) =>
          req.query.period !== "Today" ||
          (i.due_today_cents === undefined
            ? i.due_date === today
            : i.due_today_cents > 0),
      );
    const registrations = db
      .prepare(
        "SELECT * FROM registrations WHERE org_id=? AND status!='Canceled'",
      )
      .all(org.id)
      .filter((r) => inPeriod(r.created_at));
    const events = db
      .prepare("SELECT * FROM events WHERE org_id=? AND state!='Canceled'")
      .all(org.id)
      .filter((e) => inPeriod(e.start_at));
    res.json({
      paid: payments.reduce(
        (sum, t) =>
          sum + (t.type === "refund" ? -t.amount_cents : t.amount_cents),
        0,
      ),
      due: invoices.reduce(
        (sum, i) =>
          sum +
          (req.query.period === "Today" && i.due_today_cents !== undefined
            ? i.due_today_cents
            : i.total_cents - i.paid_cents),
        0,
      ),
      registrations: registrations.length,
      events: events.length,
    });
  });
  app.post("/api/programs", (req, res) =>
    res.status(201).json(saveProgram(db, req.actor, req.body)),
  );
  app.get("/api/programs/:id", (req, res) => {
    const p = programStats(db, req.actor.org_id).find(
      (p) => p.id === req.params.id,
    );
    if (!p) throw new DomainError("Program not found", 404);
    res.json(p);
  });
  app.put("/api/programs/:id", (req, res) =>
    res.json(saveProgram(db, req.actor, req.body, req.params.id)),
  );
  installDirectoryRoutes(app, db);
  installMessagingRoutes(app, db);
  installTeamRoutes(app, db);
  installProgramStaffRoutes(app, db);
  installTryoutRoutes(app, db);
  installRegistrationLifecycleRoutes(app, db);
  installScheduleOptionRoutes(app, db);
  installScheduleImportRoutes(app, db);
  installGlobalSearchRoutes(app, db);
  installRuleRoutes(app, db);
  installCommerceRoutes(app, db);
  installFormRoutes(app, db);
  installStandingsRoutes(app, db);
  installTerminologyRoutes(app, db);
  installStaffRoleRoutes(app, db);
  installTeamReportRoutes(app, db);
  installAttendanceRoutes(app, db);
  installMemberPropertyRoutes(app, db);
  installWebsiteRoutes(app, db);
  app.get("/api/registrations", (req, res) =>
    res.json(listRegistrations(db, req.actor.org_id, typeof req.query.program_id === "string" ? req.query.program_id : undefined)),
  );
  app.post("/api/registrations", (req, res) =>
    res.status(201).json(register(db, req.actor, req.body)),
  );
  app.get("/api/invoices", (req, res) => {
    const schedules = scheduledInvoiceDates(db, req.actor.org_id);
    res.json(
      db
        .prepare(
          "SELECT i.*,p.first_name,p.last_name,p.email FROM invoices i JOIN people p ON i.person_id=p.id WHERE i.org_id=? ORDER BY i.number DESC",
        )
        .all(req.actor.org_id)
        .map((row) => ({ ...unpack(row), ...(schedules.get(row.id) || {}) })),
    );
  });
  app.get("/api/invoices/:id", (req, res) => {
    const invoice = unpack(
      requireEntity(db, "invoices", req.params.id, req.actor.org_id),
    );
    res.json({
      ...invoice,
      ...(scheduledInvoiceDates(db, req.actor.org_id).get(invoice.id) || {}),
      payment_plan: invoiceInstallments(db, req.actor.org_id, invoice.id),
      person: unpack(
        requireEntity(db, "people", invoice.person_id, req.actor.org_id),
      ),
      transactions: db
        .prepare(
          "SELECT * FROM transactions WHERE invoice_id=? ORDER BY created_at",
        )
        .all(invoice.id),
      credit_applications: db
        .prepare(
          "SELECT a.*,c.description FROM credit_applications a JOIN credits c ON c.id=a.credit_id WHERE a.invoice_id=? AND a.org_id=? ORDER BY a.created_at",
        )
        .all(invoice.id, req.actor.org_id),
    });
  });
  app.post("/api/invoices/:id/payments", (req, res) =>
    res.status(201).json(recordPayment(db, req.actor, req.params.id, req.body)),
  );
  app.get("/api/events", (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM events WHERE org_id=? ORDER BY start_at")
        .all(req.actor.org_id)
        .filter(
          (e) => !req.query.program_id || e.program_id === req.query.program_id,
        )
        .map(unpack),
    ),
  );
  app.post("/api/events", (req, res) =>
    res.status(201).json(saveEvent(db, req.actor, req.body)),
  );
  app.put("/api/events/:id", (req, res) =>
    res.json(saveEvent(db, req.actor, req.body, req.params.id)),
  );
  app.get("/api/audit", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM audit_log WHERE org_id=? ORDER BY created_at DESC LIMIT 100",
        )
        .all(req.actor.org_id),
    ),
  );
  app.use("/api", (_, res) =>
    res.status(404).json({ error: "This API route has not been implemented" }),
  );
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*path}", (_, res) => res.sendFile(resolve(dist, "index.html")));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        issues: error.issues,
      });
    if (
      error.code?.startsWith("ERR_SQLITE") &&
      error.message.includes("UNIQUE")
    )
      return res
        .status(409)
        .json({ error: "A record with these details already exists" });
    if (!error.status) console.error(error);
    res.status(error.status ?? 500).json({
      error: error.status
        ? error.message
        : "An unexpected error occurred. Your changes were not saved.",
    });
  });
  return app;
}

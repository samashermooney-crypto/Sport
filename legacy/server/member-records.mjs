import { memberTeams, renameMemberTeam } from "./team-permissions.mjs";
import {
  invoiceInstallments,
  scheduledInvoiceDates,
} from "./invoice-installments.mjs";
import { DomainError } from "./domain.mjs";
import { accessibleProfile } from "./member-profile.mjs";
import { memberRecordedFields } from "./forms.mjs";

function invoiceSummary(row, today) {
  const balance = row.voided ? 0 : row.total_cents - row.paid_cents;
  return {
    ...row,
    balance_cents: balance,
    status: row.voided
      ? "Void"
      : balance === 0
        ? "Paid"
        : row.due_date && row.due_date < today
          ? "Overdue"
          : row.paid_cents > 0
            ? "Partially paid"
            : "Unpaid",
  };
}
function todayFor(db, org) {
  const site = db
    .prepare("SELECT timezone FROM organizations WHERE id=?")
    .get(org);
  return new Intl.DateTimeFormat("en-CA", { timeZone: site.timezone }).format(
    new Date(),
  );
}
function authorized(db, account, personId) {
  try {
    accessibleProfile(db, account, personId, { allowArchived: true });
    return true;
  } catch {
    return false;
  }
}
export function memberInvoices(db, account) {
  const today = todayFor(db, account.org_id);
  const schedules = scheduledInvoiceDates(db, account.org_id);
  return db
    .prepare(
      "SELECT i.id,i.number,i.person_id,i.description,i.total_cents,i.paid_cents,i.due_date,i.voided,i.created_at,p.first_name || ' ' || p.last_name participant_name FROM invoices i JOIN people p ON p.id=i.person_id AND p.org_id=i.org_id WHERE i.org_id=? ORDER BY i.number DESC",
    )
    .all(account.org_id)
    .filter((i) => authorized(db, account, i.person_id))
    .map((i) =>
      invoiceSummary(
        {
          ...i,
          ...(schedules.has(i.id)
            ? {
                due_date: schedules.get(i.id).due_date,
                overdue_cents: schedules.get(i.id).overdue_cents,
              }
            : {}),
        },
        today,
      ),
    );
}
export function memberInvoice(db, account, invoiceId) {
  const invoice = memberInvoices(db, account).find((i) => i.id === invoiceId);
  if (!invoice) throw new DomainError("Invoice not found", 404);
  const site = db
    .prepare("SELECT name,timezone FROM organizations WHERE id=?")
    .get(account.org_id);
  const history = db
    .prepare(
      "SELECT id,amount_cents,type,method,created_at FROM transactions WHERE invoice_id=? AND org_id=? ORDER BY created_at",
    )
    .all(invoice.id, account.org_id);
  const credits = db
    .prepare(
      "SELECT id,amount_cents,created_at FROM credit_applications WHERE invoice_id=? AND org_id=? ORDER BY created_at",
    )
    .all(invoice.id, account.org_id);
  return {
    ...invoice,
    organization: site,
    payment_plan: invoiceInstallments(db, account.org_id, invoice.id),
    history: [
      ...history,
      ...credits.map((c) => ({
        ...c,
        type: "credit",
        method: "Account credit",
      })),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at)),
  };
}
export function memberRegistrationRecord(db, account, registrationId) {
  const row = db
    .prepare(
      "SELECT r.id,r.person_id,r.program_id,r.role,r.status,r.created_at,r.invoice_id,p.name program_name,m.first_name || ' ' || m.last_name participant_name,t.name team_name FROM registrations r JOIN programs p ON p.id=r.program_id AND p.org_id=r.org_id JOIN people m ON m.id=r.person_id AND m.org_id=r.org_id LEFT JOIN teams t ON t.id=r.team_id AND t.org_id=r.org_id WHERE r.id=? AND r.org_id=?",
    )
    .get(registrationId, account.org_id);
  if (!row || !authorized(db, account, row.person_id))
    throw new DomainError("Registration not found", 404);
  const stored = db
    .prepare(
      "SELECT definition,answers FROM registration_answers WHERE registration_id=? AND org_id=?",
    )
    .get(row.id, account.org_id);
  const definition = stored ? JSON.parse(stored.definition) : { fields: [] };
  const fields = memberRecordedFields(
    db,
    account.org_id,
    `program:${row.program_id}`,
    definition,
  );
  const answers = stored ? JSON.parse(stored.answers) : {};
  const waivers = db
    .prepare(
      "SELECT w.id,w.document,w.method,w.accepted_at,w.recorded_at,p.first_name || ' ' || p.last_name signer_name FROM waiver_acceptances w JOIN people p ON p.id=w.signer_id AND p.org_id=w.org_id WHERE w.registration_id=? AND w.org_id=? ORDER BY w.recorded_at",
    )
    .all(row.id, account.org_id)
    .map((w) => ({ ...w, document: JSON.parse(w.document) }));
  return {
    ...row,
    fields,
    answers: Object.fromEntries(
      Object.entries(answers).filter(([key]) =>
        fields.some((f) => f.id === key),
      ),
    ),
    waivers,
  };
}
export function installMemberRecordRoutes(app, db) {
  app.get("/api/member/:org/teams", (req, res) =>
    res.json(memberTeams(db, req.member)),
  );
  app.put("/api/member/:org/teams/:id/name", (req, res) =>
    res.json(renameMemberTeam(db, req.member, req.params.id, req.body)),
  );
  app.get("/api/member/:org/invoices", (req, res) =>
    res.json(memberInvoices(db, req.member)),
  );
  app.get("/api/member/:org/invoices/:id", (req, res) =>
    res.json(memberInvoice(db, req.member, req.params.id)),
  );
  app.get("/api/member/:org/registrations/:id", (req, res) =>
    res.json(memberRegistrationRecord(db, req.member, req.params.id)),
  );
}

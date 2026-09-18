import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, transaction, now } from "./db.mjs";
import { DomainError, register } from "./domain.mjs";
import { answersSchema, acceptanceSchema } from "./forms.mjs";

const transferSchema = z.object({
  request_key: z.uuid(),
  revision: z.string().length(64),
  invoice_action: z.enum(["keep", "void_unpaid"]),
  reason: z.string().trim().min(1).max(1000),
  destination: z.object({
    program_id: z.uuid(), team_id: z.uuid().nullable().default(null),
    role: z.string().min(1).max(80).default("Free Agent"),
    answers: answersSchema, waiver_acceptances: acceptanceSchema,
    form_version: z.number().int().positive().optional(),
    discount_code: z.string().trim().max(64).default(""),
  }),
  allow_waitlist: z.boolean().default(false),
  expected_outcome: z.object({
    status: z.enum(["Confirmed", "Pending", "Wait List"]),
    total_cents: z.number().int().nonnegative().nullable(),
    due_date: z.string().nullable(),
  }).optional(),
});

export function transferRegistration(db, actor, registrationId, input) {
  const data = transferSchema.parse(input);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const hash = createHash("sha256").update(JSON.stringify(canonical({ registrationId, data }))).digest("hex");
  let existingRequest = false;
  try { return transaction(db, () => {
    const previous = db.prepare("SELECT request_hash,result FROM registration_transfers WHERE org_id=? AND request_key=?").get(actor.org_id, data.request_key);
    if (previous) {
      existingRequest = true;
      if (previous.request_hash !== hash) throw new DomainError("This transfer request was already used with different details.", 409);
      return JSON.parse(previous.result);
    }
    const preview = cancellationPreview(db, actor, registrationId);
    if (preview.already_canceled) throw new DomainError("This registration is already canceled. Review its history before transferring.", 409);
    if (preview.registration.program_id === data.destination.program_id)
      throw new DomainError("Choose a different destination program.");
    cancelRegistration(db, actor, registrationId, data);
    const destination = register(db, actor, { ...data.destination, person_id: preview.registration.person_id });
    if (destination.status === "Wait List" && !data.allow_waitlist)
      throw new DomainError("The destination would place this participant on its waiting list. The original registration has not been changed.", 409);
    const outcome = transferOutcome(db, actor, destination);
    if (data.expected_outcome && JSON.stringify(data.expected_outcome) !== JSON.stringify(outcome))
      throw new DomainError("The destination price, payment deadline, or registration status changed. Review the transfer again.", 409);
    audit(db, actor, "transfer_registration", "registration", registrationId, {
      destination_registration_id: destination.id,
      destination_program_id: destination.program_id,
      source_invoice_id: preview.invoice?.id ?? null,
      destination_invoice_id: destination.invoice_id,
      invoice_action: data.invoice_action, reason: data.reason,
    });
    const result = { source_registration_id: registrationId, destination };
    db.prepare("INSERT INTO registration_transfers VALUES(?,?,?,?,?)").run(actor.org_id, data.request_key, hash, JSON.stringify(result), now());
    return result;
  }); } catch (error) {
    if (!existingRequest && error instanceof DomainError) error.transfer_not_saved = true;
    throw error;
  }
}

function transferOutcome(db, actor, destination) {
  const invoice = destination.invoice_id ? db.prepare("SELECT total_cents,due_date FROM invoices WHERE id=? AND org_id=?").get(destination.invoice_id, actor.org_id) : null;
  return { status: destination.status, total_cents: invoice?.total_cents ?? null, due_date: invoice?.due_date ?? null };
}

export function previewRegistrationTransfer(db, actor, registrationId, input) {
  const data = transferSchema.parse(input);
  const rollback = new Error("Rollback transfer preview");
  let result;
  try {
    transaction(db, () => {
      // A completed request should be recovered through its original result, not
      // represented as a new preview using records that may since have changed.
      if (db.prepare("SELECT 1 FROM registration_transfers WHERE org_id=? AND request_key=?").get(actor.org_id, data.request_key))
        throw new DomainError("This transfer request has already completed. Retry its original submission to recover the result.", 409);
      const transfer = transferRegistration(db, actor, registrationId, { ...data, expected_outcome: undefined });
      result = { source_registration_id: registrationId, destination_program_id: transfer.destination.program_id, outcome: transferOutcome(db, actor, transfer.destination) };
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result;
}

export function cancellationPreview(db, actor, registrationId) {
  const registration = db.prepare("SELECT * FROM registrations WHERE id=? AND org_id=?").get(registrationId, actor.org_id);
  if (!registration) throw new DomainError("Registration not found.", 404);
  const invoice = registration.invoice_id
    ? db.prepare("SELECT id,number,total_cents,paid_cents,voided FROM invoices WHERE id=? AND org_id=?").get(registration.invoice_id, actor.org_id)
    : null;
  if (registration.invoice_id && !invoice) throw new DomainError("The registration invoice is unavailable.", 409);
  const linked = invoice ? db.prepare("SELECT id FROM registrations WHERE invoice_id=? AND id!=? AND status!='Canceled'").all(invoice.id, registrationId) : [];
  const credits = invoice ? db.prepare("SELECT id FROM credit_applications WHERE invoice_id=?").all(invoice.id) : [];
  const transactions = invoice ? db.prepare("SELECT id FROM transactions WHERE invoice_id=?").all(invoice.id) : [];
  const orders = invoice ? db.prepare("SELECT id FROM product_orders WHERE invoice_id=?").all(invoice.id) : [];
  const snapshot = { registration, invoice, linked, credits, transactions, orders };
  return {
    registration,
    invoice,
    can_void_invoice: Boolean(invoice && !invoice.voided && invoice.paid_cents === 0 && !linked.length && !credits.length && !transactions.length && !orders.length),
    revision: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    already_canceled: registration.status === "Canceled",
  };
}

export function cancelRegistration(db, actor, registrationId, input) {
  const data = z.object({
    revision: z.string().length(64),
    invoice_action: z.enum(["keep", "void_unpaid"]),
    reason: z.string().trim().min(1).max(1000),
  }).parse(input);
  return transaction(db, () => {
    const preview = cancellationPreview(db, actor, registrationId);
    if (preview.already_canceled) return { registration_id: registrationId, status: "Canceled", already_canceled: true };
    if (preview.revision !== data.revision) throw new DomainError("This registration or its billing changed. Review the cancellation again.", 409);
    if (data.invoice_action === "void_unpaid" && !preview.can_void_invoice)
      throw new DomainError("Only an unpaid invoice without payment history, product orders, or other active registrations can be voided here.", 409);
    if (data.invoice_action === "void_unpaid")
      db.prepare("UPDATE invoices SET voided=1 WHERE id=? AND org_id=?").run(preview.invoice.id, actor.org_id);
    db.prepare("UPDATE registrations SET status='Canceled' WHERE id=? AND org_id=?").run(registrationId, actor.org_id);
    audit(db, actor, "cancel_registration", "registration", registrationId, {
      reason: data.reason, invoice_action: data.invoice_action,
      previous_status: preview.registration.status, invoice_id: preview.invoice?.id ?? null,
      previous_team_id: preview.registration.team_id,
    });
    return { registration_id: registrationId, status: "Canceled", invoice_action: data.invoice_action };
  });
}

export function registrationTransferResult(db, actor, registrationId, requestKey) {
  z.uuid().parse(requestKey);
  if (!db.prepare("SELECT id FROM registrations WHERE id=? AND org_id=?").get(registrationId, actor.org_id))
    throw new DomainError("Registration not found.", 404);
  const row = db.prepare("SELECT result FROM registration_transfers WHERE org_id=? AND request_key=?").get(actor.org_id, requestKey);
  if (!row) return { completed: false };
  const result = JSON.parse(row.result);
  if (result.source_registration_id !== registrationId) return { completed: false };
  return { completed: true, result };
}

export function installRegistrationLifecycleRoutes(app, db) {
  app.get("/api/registrations/:id/transfer/:requestKey", (req, res) => res.json(registrationTransferResult(db, req.actor, req.params.id, req.params.requestKey)));
  app.get("/api/registrations/:id/cancellation", (req, res) => res.json(cancellationPreview(db, req.actor, req.params.id)));
  app.post("/api/registrations/:id/cancel", (req, res) => res.json(cancelRegistration(db, req.actor, req.params.id, req.body)));
  app.post("/api/registrations/:id/transfer/preview", (req, res) => res.json(previewRegistrationTransfer(db, req.actor, req.params.id, req.body)));
  app.post("/api/registrations/:id/transfer", (req, res) => {
    const input = transferSchema.required({ expected_outcome: true }).parse(req.body);
    try { res.json(transferRegistration(db, req.actor, req.params.id, input)); }
    catch (error) {
      if (error.transfer_not_saved) return res.status(error.status || 400).json({ error: error.message, transfer_not_saved: true });
      throw error;
    }
  });
}

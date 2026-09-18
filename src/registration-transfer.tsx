import { useState } from "react";
import { api, ApiError, money } from "./api";
import { Button, Check, ErrorBox, Field, Loading, Modal, Select, useData } from "./components";
import { RegistrationQuestions, type RegistrationFormValues } from "./forms";
import type { Program, Registration, Team } from "./types";

type Source = { revision: string; already_canceled: boolean; can_void_invoice: boolean; invoice: { number: number; total_cents: number; paid_cents: number; voided: number } | null };
type Outcome = { status: string; total_cents: number | null; due_date: string | null };
export function RegistrationTransfer({ registration, onClose, onDone }: { registration: Registration; onClose: () => void; onDone: () => void }) {
  const programs = useData<Program[]>("/programs", []);
  const source = useData<Source | null>(`/registrations/${registration.id}/cancellation`, null);
  const [program, setProgram] = useState(""), [team, setTeam] = useState("");
  const teams = useData<Team[]>(`/teams${program ? `?program_id=${program}` : ""}`, []);
  const [values, setValues] = useState<RegistrationFormValues | null>(null);
  const [invoiceAction, setInvoiceAction] = useState("keep"), [reason, setReason] = useState(""), [discount, setDiscount] = useState("");
  const [waitlist, setWaitlist] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [review, setReview] = useState<{ payload: { request_key: string }; outcome: Outcome } | null>(null), [attempted, setAttempted] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const role = team ? "Team Player" : "Free Agent";
  const ready = source.data && !source.data.already_canceled && !source.loading && !source.error && program && values?.form_version && !teams.loading && !teams.error && !programs.loading && !programs.error;
  return <Modal title="Transfer registration" onClose={() => { if (!busy) onClose(); }}>
    <form className="modal-body cancellation-review" onSubmit={async event => {
      event.preventDefault(); if (busy || !ready) return;
      setBusy(true); setError("");
      try {
        if (review) {
          setAttempted(true);
          await api(`/registrations/${registration.id}/transfer`, { method: "POST", body: JSON.stringify({ ...review.payload, expected_outcome: review.outcome }) });
          onDone();
        } else {
          const payload = { request_key: crypto.randomUUID(), revision: source.data!.revision, invoice_action: invoiceAction, reason, allow_waitlist: waitlist,
            destination: { program_id: program, team_id: team || null, role, discount_code: discount, answers: values!.answers, waiver_acceptances: values!.waiver_acceptances, form_version: values!.form_version } };
          const result = await api<{ outcome: Outcome }>(`/registrations/${registration.id}/transfer/preview`, { method: "POST", body: JSON.stringify(payload) });
          setReview({ payload, outcome: result.outcome });
        }
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Transfer could not be confirmed.");
        if (caught instanceof ApiError && caught.details.transfer_not_saved === true) {
          setAttempted(false); setReview(null); setInvoiceAction("keep"); setValues(null); setFormRevision(v => v + 1); source.reload();
        } }
      finally { setBusy(false); }
    }}>
      <p>Transfer <strong>{registration.first_name} {registration.last_name}</strong> to another program. The original registration will remain in history as canceled.</p>
      <ErrorBox error={source.error || programs.error || teams.error || error} />
      {source.loading && <Loading />}
      {(error || source.error || programs.error || teams.error) && !attempted && <Button type="button" secondary disabled={busy} onClick={() => { setReview(null); setInvoiceAction("keep"); setValues(null); setFormRevision(v => v + 1); setError(""); source.reload(); teams.reload(); programs.reload(); }}>Refresh review data</Button>}
      {attempted && error && review && <Button type="button" secondary disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const status = await api<{ completed: boolean }>(`/registrations/${registration.id}/transfer/${review.payload.request_key}`);
          if (status.completed) onDone();
          else setError("No completed transfer is recorded for this request. Retry confirmation with the same details.");
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not check the transfer result. Retry checking or confirmation."); }
        finally { setBusy(false); }
      }}>Check transfer result</Button>}
      {source.data?.already_canceled && <p>This registration is already canceled. Close this dialog and review its history.</p>}
      {review ? <>
        <p><strong>Destination:</strong> {programs.data.find(p => p.id === program)?.name}</p>
        <p><strong>Registration status:</strong> {review.outcome.status}</p>
        <p><strong>New invoice:</strong> {review.outcome.total_cents === null ? "No invoice" : money(review.outcome.total_cents)}{review.outcome.due_date ? ` · Due ${review.outcome.due_date}` : ""}</p>
        <p>{!source.data?.invoice ? "There is no original invoice." : invoiceAction === "void_unpaid" ? "The original unpaid invoice will be voided." : "The original invoice and any balance will remain unchanged."} Payments are not moved or refunded by this transfer.</p>
        {attempted && error && <p>Retry confirmation with these same details to recover the result. Do not submit a second transfer while the outcome is uncertain.</p>}
      </> : <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Field label="Destination program"><Select required value={program} onChange={e => { setProgram(e.target.value); setTeam(""); setValues(null); setError(""); }} options={[{ value: "", label: "Choose a program" }, ...programs.data.filter(p => !p.grouped && p.id !== registration.program_id).map(p => ({ value: p.id, label: p.name }))]} /></Field>
        <Field label="Destination team"><Select value={team} disabled={!program || teams.loading || !!teams.error} onChange={e => { setTeam(e.target.value); setValues(null); }} options={[{ value: "", label: "Free agent — no team" }, ...teams.data.filter(t => t.program_id === program).map(t => ({ value: t.id, label: t.name }))]} /></Field>
        {source.data?.invoice && <p>Original invoice #{source.data.invoice.number}: {money(source.data.invoice.total_cents)} total, {money(source.data.invoice.paid_cents)} paid.</p>}
        <Field label="Original invoice"><Select value={invoiceAction} onChange={e => setInvoiceAction(e.target.value)} options={[{ value: "keep", label: "Keep invoice and remaining balance" }, ...(source.data?.can_void_invoice ? [{ value: "void_unpaid", label: "Void unpaid invoice" }] : [])]} /></Field>
        <Field label="Destination discount code"><input maxLength={64} value={discount} onChange={e => setDiscount(e.target.value)} /></Field>
        <Field label="Reason for transfer"><textarea required maxLength={1000} rows={3} value={reason} onChange={e => setReason(e.target.value)} onInput={e => setReason(e.currentTarget.value)} /></Field>
        <Check checked={waitlist} onChange={e => setWaitlist(e.target.checked)}>Allow transfer to the destination waiting list if full</Check>
        {program && <RegistrationQuestions key={`${program}:${role}:${formRevision}`} programId={program} personId={registration.person_id} role={role} onChange={setValues} />}
      </fieldset>}
      <div className="form-actions">
        {review && !attempted && <Button type="button" secondary disabled={busy} onClick={() => setReview(null)}>Edit details</Button>}
        <Button type="submit" disabled={busy || !ready || !reason.trim()}>{busy ? "Working…" : review ? "Confirm transfer" : "Review transfer"}</Button>
        <Button type="button" secondary disabled={busy} onClick={onClose}>Close</Button>
      </div>
    </form>
  </Modal>;
}

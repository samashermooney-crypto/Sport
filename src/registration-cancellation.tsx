import { useState } from "react";
import { api, money } from "./api";
import { Button, ErrorBox, Field, Loading, Modal, Select, useData } from "./components";

type Preview = {
  revision: string;
  already_canceled: boolean;
  can_void_invoice: boolean;
  invoice: { number: number; total_cents: number; paid_cents: number; voided: number } | null;
};

export function RegistrationCancellation({ registrationId, name, onClose, onDone }: {
  registrationId: string; name: string; onClose: () => void; onDone: () => void;
}) {
  const preview = useData<Preview | null>(`/registrations/${registrationId}/cancellation`, null);
  const [action, setAction] = useState("keep"), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [needsReview, setNeedsReview] = useState(false);
  const data = preview.data;
  return <Modal title="Cancel registration" onClose={() => { if (!busy) onClose(); }}>
    <form className="modal-body cancellation-review" onSubmit={async event => {
      event.preventDefault();
      if (!data || busy || needsReview || preview.loading || preview.error) return;
      setBusy(true); setError("");
      try {
        await api(`/registrations/${registrationId}/cancel`, { method: "POST", body: JSON.stringify({ revision: data.revision, invoice_action: action, reason }) });
        onDone();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Cancellation could not be confirmed.");
        setNeedsReview(true);
      } finally { setBusy(false); }
    }}>
      <p>Cancel the registration for <strong>{name}</strong>. It will leave the active roster and remain in registration history.</p>
      <ErrorBox error={preview.error || error} />
      {preview.loading ? <Loading /> : data && !preview.error && <>
        {data.already_canceled ? <p role="status">This registration is already canceled.</p> : <>
          {data.invoice && !data.invoice.voided ? <>
            <p>Invoice #{data.invoice.number}: {money(data.invoice.total_cents)} total, {money(data.invoice.paid_cents)} paid, {money(data.invoice.total_cents - data.invoice.paid_cents)} remaining.</p>
            <Field label="Invoice handling"><Select value={action} disabled={busy || needsReview} onChange={event => setAction(event.target.value)} options={[
              { value: "keep", label: "Keep invoice and its remaining balance" },
              ...(data.can_void_invoice ? [{ value: "void_unpaid", label: "Void the unpaid invoice" }] : []),
            ]} /></Field>
            <p>{action === "void_unpaid" ? "The invoice will no longer accept payments. Its record will be retained." : "Existing payments and the amount still owed will remain unchanged. This action does not issue a refund."}</p>
          </> : <p>{data.invoice ? "The linked invoice is already voided." : "There is no linked invoice."}</p>}
          <Field label="Reason for cancellation"><textarea required maxLength={1000} rows={3} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} onInput={event => setReason(event.currentTarget.value)} /></Field>
          <p>The reason will be saved in the audit history. Waitlisted participants will not be promoted automatically.</p>
        </>}
      </>}
      <div className="form-actions">
        {(needsReview || preview.error) && <Button type="button" secondary disabled={busy || preview.loading} onClick={() => { setAction("keep"); setNeedsReview(false); setError(""); preview.reload(); }}>Refresh review</Button>}
        <Button type="submit" disabled={busy || preview.loading || !!preview.error || !data || data.already_canceled || needsReview || !reason.trim()}>{busy ? "Canceling…" : "Confirm cancellation"}</Button>
        <Button type="button" secondary disabled={busy} onClick={onClose}>Close</Button>
      </div>
    </form>
  </Modal>;
}

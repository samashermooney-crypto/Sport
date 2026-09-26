import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "./api";
import { Button, ErrorBox, Field, Loading, useData } from "./components";
import {
  MemberRegistrationQuestions,
  type QuestionnaireData,
  type RegistrationFormValues,
} from "./forms";
import type { MemberSession } from "./member-account";

type EnrollmentPlan = {
  plan_id: string;
  plan_version: number;
  name: string;
  total_cents: number;
  available: boolean;
  unavailable_reason: string;
  installments: {
    position: number;
    due_date: string;
    amount_cents: number;
    fee_cents: number;
    total_cents: number;
  }[];
};
type Enrollment = {
  program: { id: string; name: string; fee_cents: number; waitlist: boolean };
  participant: { id: string; name: string };
  form: QuestionnaireData;
  allow_discounts: boolean;
  payment_plans: EnrollmentPlan[];
};
type Receipt = {
  id: string;
  status: string;
  program_name: string;
  participant_name: string;
  invoice: {
    id: string;
    number: number;
    total_cents: number;
    paid_cents: number;
  } | null;
};
const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export function MemberEnrollment({
  org,
  session,
}: {
  org: string;
  session: MemberSession;
}) {
  const [params] = useSearchParams(),
    programId = params.get("program") || "";
  return (
    <EnrollmentFlow
      key={programId}
      org={org}
      session={session}
      programId={programId}
    />
  );
}
function EnrollmentFlow({
  org,
  session,
  programId,
}: {
  org: string;
  session: MemberSession;
  programId: string;
}) {
  const family = useData<
    {
      id: string;
      first_name: string;
      last_name: string;
      can_register: boolean;
    }[]
  >(`/member/${org}/family`, []);
  const roles = useData<string[]>(
    `/member/${org}/enrollment-roles?program_id=${encodeURIComponent(programId)}`,
    [],
  );
  const [role, setRole] = useState("Free Agent");
  const chosenRole = roles.data.includes(role) ? role : roles.data[0] || "";
  const [person, setPerson] = useState(session.person_id),
    [password, setPassword] = useState("");
  const [context, setContext] = useState<Enrollment | null>(null),
    [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [discount, setDiscount] = useState("");
  const [planId, setPlanId] = useState("");
  const [privateCode, setPrivateCode] = useState("");
  const [lookupCode, setLookupCode] = useState("");
  const [lookupMessage, setLookupMessage] = useState("");
  const selectedPlan = context?.payment_plans.find(
    (plan) => plan.plan_id === planId,
  );
  const quotedFee =
    selectedPlan?.total_cents ?? context?.program.fee_cents ?? 0;
  const [values, setValues] = useState<RegistrationFormValues>({
    answers: {},
    waiver_acceptances: [],
    form_version: 0,
    has_waivers: false,
  });
  if (family.loading || roles.loading) return <Loading />;
  if (family.error || roles.error)
    return <ErrorBox error={family.error || roles.error} />;
  if (!programId)
    return (
      <p>
        Choose a program from{" "}
        <Link to={`/site/${org}`}>the program directory</Link>.
      </p>
    );
  if (receipt)
    return (
      <>
        <h1>
          {receipt.status === "Wait List"
            ? "Added to the wait list"
            : receipt.status === "Confirmed"
              ? "Registration confirmed"
              : "Registration received"}
        </h1>
        <p>
          {receipt.participant_name} · {receipt.program_name}
        </p>
        <p>Status: {receipt.status}</p>
        {receipt.invoice && (
          <>
            <h2>
              <Link
                to={`/site/${org}/account/invoice?id=${receipt.invoice.id}`}
              >
                Invoice #{receipt.invoice.number}
              </Link>
            </h2>
            <p>
              Amount due:{" "}
              {money(receipt.invoice.total_cents - receipt.invoice.paid_cents)}
            </p>
            {receipt.invoice.total_cents > receipt.invoice.paid_cents && (
              <p>
                Your registration is pending payment. Contact the organization
                to arrange payment.
              </p>
            )}
          </>
        )}
        <Link className="button" to={`/site/${org}/account/dashboard`}>
          Back to dashboard
        </Link>
      </>
    );
  return (
    <>
      <h1>{context ? context.program.name : "Program registration"}</h1>
      <ErrorBox error={error} />
      {!context ? (
        <form
          className="member-access-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setContext(
                await api<Enrollment>(`/member/${org}/enrollment`, {
                  method: "POST",
                  body: JSON.stringify({
                    program_id: programId,
                    person_id:
                      chosenRole === "Free Agent" ? person : session.person_id,
                    role: chosenRole,
                    password,
                  }),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Registration role" required>
            <select
              required
              value={chosenRole}
              onChange={(e) => {
                setRole(e.target.value);
                if (e.target.value !== "Free Agent")
                  setPerson(session.person_id);
              }}
            >
              {roles.data.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Who are you registering?" required>
            <select
              value={person}
              required
              onChange={(e) => setPerson(e.target.value)}
            >
              {family.data
                .filter((p) =>
                  chosenRole === "Free Agent"
                    ? p.can_register
                    : p.id === session.person_id,
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.first_name} {p.last_name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Program password (if required)">
            <input
              type="password"
              value={password}
              maxLength={64}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <p>
            <Link
              to={`/site/${org}/account/profile?program=${encodeURIComponent(programId)}&person=${person}`}
            >
              Update participant profile
            </Link>{" "}
            ·{" "}
            <Link
              to={`/site/${org}/account/child?program=${encodeURIComponent(programId)}`}
            >
              Add child
            </Link>
          </p>
          <Button disabled={busy}>{busy ? "Checking…" : "Continue"}</Button>
        </form>
      ) : (
        <form
          className="member-access-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setReceipt(
                await api<Receipt>(`/member/${org}/registrations`, {
                  method: "POST",
                  body: JSON.stringify({
                    program_id: programId,
                    person_id:
                      chosenRole === "Free Agent" ? person : session.person_id,
                    role: chosenRole,
                    password,
                    answers: values.answers,
                    waiver_acceptances: values.waiver_acceptances,
                    form_version: values.form_version,
                    expected_fee_cents: quotedFee,
                    payment_plan_id: planId || undefined,
                    payment_plan_version: selectedPlan?.plan_version,
                    private_plan_code: lookupCode,
                    discount_code: discount,
                  }),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{context.participant.name}</h2>
          <p>Role: {chosenRole}</p>
          <p>Registration fee: {money(quotedFee)}</p>
          <Field label="Payment option">
            <select
              value={planId}
              disabled={busy}
              onChange={(e) => setPlanId(e.target.value)}
            >
              <option value="">
                Pay in full — {money(context.program.fee_cents)}
              </option>
              {context.payment_plans.map((plan) => (
                <option
                  key={plan.plan_id}
                  value={plan.plan_id}
                  disabled={!plan.available}
                >
                  {plan.name} — {money(plan.total_cents)}
                  {!plan.available ? ` — ${plan.unavailable_reason}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Private payment-plan code">
            <input
              value={privateCode}
              maxLength={64}
              disabled={busy}
              onChange={(e) => setPrivateCode(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            secondary
            disabled={busy || !privateCode.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              setLookupMessage("");
              try {
                const code = privateCode.trim();
                const refreshed = await api<Enrollment>(
                  `/member/${org}/enrollment`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      program_id: programId,
                      person_id: context.participant.id,
                      role: chosenRole,
                      password,
                      private_plan_code: code,
                    }),
                  },
                );
                setContext((current) =>
                  current
                    ? { ...current, payment_plans: refreshed.payment_plans }
                    : current,
                );
                setLookupCode(code);
                setPlanId("");
                setLookupMessage(
                  "Payment options refreshed. Select an available plan above. If your plan is missing, check the code with the organization.",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Look up code
          </Button>
          {lookupMessage && <p role="status">{lookupMessage}</p>}
          {selectedPlan && (
            <>
              <h3>{selectedPlan.name}</h3>
              <p>
                Schedule before discounts. Any accepted discount will be
                reflected on your invoice.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Due date</th>
                    <th>Amount</th>
                    <th>Fees</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedPlan.installments.map((row) => (
                    <tr key={row.position}>
                      <td>{row.due_date}</td>
                      <td>{money(row.amount_cents)}</td>
                      <td>{money(row.fee_cents)}</td>
                      <td>{money(row.total_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {quotedFee > 0 && (
            <p>
              Submitting creates a pending registration and invoice. Contact the
              organization to arrange payment.
            </p>
          )}
          {context.program.waitlist && (
            <p>
              If the program reaches capacity, your registration will join the
              wait list without an invoice.
            </p>
          )}
          <MemberRegistrationQuestions
            form={context.form}
            org={org}
            onChange={setValues}
          />
          {context.allow_discounts && (
            <Field label="Discount code">
              <input
                value={discount}
                maxLength={64}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
          )}
          {context.form.waivers.length > 0 && (
            <p>Accepting as {context.form.signers?.[0]?.name}.</p>
          )}
          <Button
            disabled={
              busy ||
              !values.form_version ||
              (!!planId && !selectedPlan?.available)
            }
          >
            {busy ? "Submitting…" : "Submit registration"}
          </Button>{" "}
          <Button
            type="button"
            secondary
            disabled={busy}
            onClick={() => {
              setContext(null);
              setPlanId("");
              setPrivateCode("");
              setLookupCode("");
              setLookupMessage("");
              setError("");
              setValues((v) => ({ ...v, form_version: 0 }));
            }}
          >
            Back
          </Button>
        </form>
      )}
    </>
  );
}

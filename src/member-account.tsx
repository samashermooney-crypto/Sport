import { AccountAuth } from "./account-auth";
import { MemberRecovery } from "./member-recovery";
import { MemberTeams } from "./member-teams";
import { MemberOrders } from "./member-orders";
import {
  MemberCompletionGate,
  emptyCollectionSettings,
  type CollectionSettings,
} from "./member-properties";
import { MemberSchedule } from "./member-schedule";
import {
  MemberInvoices,
  MemberInvoice,
  MemberRegistrationDetail,
} from "./member-records";
import { MemberEnrollment } from "./member-enrollment";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ProfileQuestions, type RegistrationFormValues } from "./forms";
import { api } from "./api";
import { Button, ErrorBox, Field, Loading, useData } from "./components";

export type MemberSession = {
  id: string;
  org_id: string;
  person_id: string;
  email: string;
  first_name: string;
  last_name: string;
  birthdate: string;
};
export function MemberAccount({
  org,
  page,
  session,
  loading,
  changed,
}: {
  org: string;
  page: string;
  session: MemberSession | null;
  loading: boolean;
  changed: () => void;
}) {
  const [routeParams] = useSearchParams();
  const program = routeParams.get("program") || "";
  const resumeQuery = program ? `?program=${encodeURIComponent(program)}` : "";
  const root = `/site/${org}/account`;
  if (loading) return <Loading />;
  if (page === "accept-invitation") return <AccountAuth key={org + routeParams.get("token")} mode="accept-invitation" org={org} />;
  if (["forgot-password", "reset-password"].includes(page))
    return <MemberRecovery key={page + routeParams.get("token")} org={org} reset={page === "reset-password"} changed={changed} />;
  if (["signup", "login", "verify"].includes(page))
    return (
      <MemberAccessForm key={page} org={org} mode={page} changed={changed} />
    );
  if (!session)
    return (
      <section className="member-access">
        <h1>Member sign in</h1>
        <p>Sign in to view your family account.</p>
        <Link className="button" to={root + "/login" + resumeQuery}>
          Sign in
        </Link>
        <p>
          <Link to={root + "/signup" + resumeQuery}>Create an account</Link>
        </p>
      </section>
    );
  const PortalGate = ["profile", "child", "settings"].includes(page)
    ? PassThrough
    : MemberCompletionGate;
  return (
    <div className="member-portal">
      <aside>
        <h2>My account</h2>
        <nav aria-label="Member account">
          <Link to={root + "/dashboard"}>Dashboard</Link>
          <Link to={root + "/schedule"}>My schedule</Link>
          <Link to={root + "/teams"}>My teams</Link>
          <Link to={root + "/invoices"}>Invoices</Link>
          <Link to={root + "/orders"}>My orders</Link>
          <Link to={root + "/profile"}>My profile</Link>
          <Link to={root + "/settings"}>Account settings</Link>
        </nav>
      </aside>
      <section>
        <PortalGate key={page} org={org}>
          {page === "settings" ? (
            <MemberPassword org={org} />
          ) : page === "teams" ? (
            <MemberTeams org={org} />
          ) : page === "schedule" ? (
            <MemberSchedule org={org} />
          ) : page === "invoices" ? (
            <MemberInvoices org={org} />
          ) : page === "orders" ? (
            <MemberOrders org={org} />
          ) : page === "invoice" ? (
            <MemberInvoice org={org} />
          ) : page === "registration" ? (
            <MemberRegistrationDetail org={org} />
          ) : page === "register" ? (
            <MemberEnrollment org={org} session={session} />
          ) : page === "profile" || page === "child" ? (
            <MemberProfile
              key={page}
              org={org}
              session={session}
              child={page === "child"}
            />
          ) : (
            <MemberDashboard org={org} session={session} />
          )}
        </PortalGate>
      </section>
    </div>
  );
}
function PassThrough({ children }: { children: React.ReactNode; org: string }) {
  return <>{children}</>;
}
function MemberAccessForm({
  org,
  mode,
  changed,
}: {
  org: string;
  mode: string;
  changed: () => void;
}) {
  const navigate = useNavigate(),
    [params] = useSearchParams();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""),
    [preview, setPreview] = useState("");
  const [form, setForm] = useState({
    email: "",
    password: "",
    first_name: "",
    last_name: "",
    birthdate: "",
    address: "",
    city: "",
    state: "",
    postal: "",
    phone: "",
    secondary_email: "",
  });
  const signupSettings = useData<CollectionSettings>(
    `/member/${org}/signup-settings`,
    emptyCollectionSettings,
  );
  const root = `/site/${org}/account`;
  const destination = new URLSearchParams();
  for (const key of ["program", "return_page", "return_team"]) {
    const value = params.get(key);
    if (value) destination.set(key, value);
  }
  const resumeQuery = destination.size ? `?${destination}` : "";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await api<{ message?: string; development_link?: string }>(
        `/member/${org}/${mode}`,
        {
          method: "POST",
          body: JSON.stringify(
            mode === "verify"
              ? { token: params.get("token") || "" }
              : { ...form, ...Object.fromEntries(destination) },
          ),
        },
      );
      if (mode === "signup") {
        setMessage(result.message || "Check your email.");
        setPreview(result.development_link || "");
        setForm((f) => ({ ...f, password: "" }));
      } else {
        changed();
        navigate(
          params.get("return_team")
            ? `/site/${org}/teams/${encodeURIComponent(params.get("return_team")!)}`
            : params.get("return_page")
            ? `/site/${org}/pages/${encodeURIComponent(params.get("return_page")!)}`
            : root +
                (params.get("program")
                  ? `/register?program=${encodeURIComponent(params.get("program")!)}`
                  : "/dashboard"),
          { replace: true },
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title =
    mode === "signup"
      ? "Create your account"
      : mode === "verify"
        ? "Verify your email"
        : "Member sign in";
  return (
    <section className="member-access">
      <h1>{title}</h1>
      {mode === "login" && <p><Link to={root + "/forgot-password"}>Forgot your password?</Link></p>}
      <ErrorBox error={error} />
      {message ? (
        <>
          <p role="status">{message}</p>
          {preview && (
            <div className="member-email-preview">
              <strong>Local development email preview</strong>
              <p>
                Email was not sent. This link lets you test account verification
                in this local workspace.
              </p>
              <Link className="button" to={preview}>
                Verify this demo account
              </Link>
            </div>
          )}
          <p>
            <Link to={root + "/login" + resumeQuery}>Back to sign in</Link>
          </p>
        </>
      ) : (
        <form onSubmit={submit}>
          {mode === "verify" ? (
            <p>
              Confirm this email verification link to finish creating your
              account.
            </p>
          ) : (
            <>
              {mode === "signup" && (
                <>
                  <p>
                    Create your own adult account first. Children belong in a
                    family account.
                  </p>
                  <div className="form-grid">
                    {(
                      [
                        ["first_name", "First name"],
                        ["last_name", "Last name"],
                      ] as const
                    ).map(([key, label]) => (
                      <Field label={label} required key={key}>
                        <input
                          required
                          maxLength={100}
                          autoComplete={
                            key === "first_name" ? "given-name" : "family-name"
                          }
                          value={form[key]}
                          onChange={(e) =>
                            setForm({ ...form, [key]: e.target.value })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                  <Field label="Your birthdate" required>
                    <input
                      type="date"
                      required
                      autoComplete="bday"
                      value={form.birthdate}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        setForm((f) => ({ ...f, birthdate: value }));
                      }}
                      onChange={(e) => {
                        const value = e.target.value;
                        setForm((f) => ({ ...f, birthdate: value }));
                      }}
                    />
                  </Field>
                  <ErrorBox error={signupSettings.error} />
                  {signupSettings.data.collect_secondary_email && (
                    <Field
                      label="Secondary email address"
                      required={signupSettings.data.require_secondary_email}
                    >
                      <input
                        type="email"
                        maxLength={254}
                        required={signupSettings.data.require_secondary_email}
                        value={form.secondary_email}
                        onChange={(e) =>
                          setForm({ ...form, secondary_email: e.target.value })
                        }
                      />
                    </Field>
                  )}
                  {signupSettings.data.collect_adult_mobile && (
                    <Field
                      label="Mobile number"
                      required={signupSettings.data.require_adult_mobile}
                    >
                      <input
                        type="tel"
                        autoComplete="tel"
                        maxLength={50}
                        required={signupSettings.data.require_adult_mobile}
                        value={form.phone}
                        onChange={(e) =>
                          setForm({ ...form, phone: e.target.value })
                        }
                      />
                    </Field>
                  )}
                  {signupSettings.data.require_address &&
                    (
                      [
                        ["address", "Address"],
                        ["city", "City"],
                        ["state", "State"],
                        ["postal", "Postal code"],
                      ] as const
                    ).map(([key, label]) => (
                      <Field key={key} label={label} required>
                        <input
                          required
                          value={form[key]}
                          onChange={(e) =>
                            setForm({ ...form, [key]: e.target.value })
                          }
                        />
                      </Field>
                    ))}
                </>
              )}
              <Field label="Email" required>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  maxLength={254}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </Field>
              <Field label="Password" required>
                <input
                  type="password"
                  required
                  minLength={mode === "signup" ? 12 : 1}
                  maxLength={128}
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                />
              </Field>
              {mode === "signup" && <p>Use at least 12 characters.</p>}
            </>
          )}
          <Button disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "verify"
                ? "Verify email and continue"
                : mode === "signup"
                  ? "Create account"
                  : "Sign in"}
          </Button>
          <p>
            {mode === "login" ? (
              <Link to={root + "/signup" + resumeQuery}>Create an account</Link>
            ) : (
              <Link to={root + "/login" + resumeQuery}>
                Already have an account? Sign in
              </Link>
            )}
          </p>
        </form>
      )}
    </section>
  );
}
function MemberDashboard({
  org,
  session,
}: {
  org: string;
  session: MemberSession;
}) {
  const { data, error, loading } = useData<
    {
      id: string;
      first_name: string;
      last_name: string;
      household_role: string;
      self: boolean;
      can_register: boolean;
    }[]
  >(`/member/${org}/family`, []);
  const registrations = useData<
    {
      id: string;
      program_name: string;
      participant_name: string;
      status: string;
      invoice_number: number | null;
      total_cents: number | null;
      paid_cents: number | null;
      voided: number | null;
    }[]
  >(`/member/${org}/registrations`, []);
  return (
    <>
      <h1>Dashboard</h1>
      <p>Welcome, {session.first_name}.</p>
      <h2>My family account</h2>
      <p>
        <Link className="button" to={`/site/${org}/account/child`}>
          Add child
        </Link>
      </p>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : (
        <ul className="member-family-list">
          {data.map((p) => (
            <li key={p.id}>
              <Link to={`/site/${org}/account/profile?person=${p.id}`}>
                {p.first_name} {p.last_name}
              </Link>
              <span>
                {p.household_role === "Supervisor"
                  ? "Parent / guardian"
                  : "Family member"}
                {p.self ? " · You" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2>My registrations</h2>
      <ErrorBox error={registrations.error} />
      {registrations.loading ? (
        <Loading />
      ) : registrations.data.length ? (
        <ul className="member-family-list">
          {registrations.data.map((r) => (
            <li key={r.id}>
              <Link to={`/site/${org}/account/registration?id=${r.id}`}>
                {r.program_name}
              </Link>
              <span>
                {r.participant_name} · {r.status}
              </span>
              {r.invoice_number && (
                <span>
                  Invoice #{r.invoice_number} ·{" "}
                  {r.voided
                    ? "Void"
                    : new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: "USD",
                      }).format(
                        ((r.total_cents || 0) - (r.paid_cents || 0)) / 100,
                      ) + " due"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No registrations yet.</p>
      )}
      <p>
        <Link to={`/site/${org}`}>Browse programs</Link>
      </p>
    </>
  );
}
function MemberPassword({ org }: { org: string }) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <h1>Account settings</h1>
      <h2>Change password</h2>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      <form
        className="member-access-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await api(`/member/${org}/password`, {
              method: "POST",
              body: JSON.stringify({
                current_password: current,
                new_password: next,
              }),
            });
            setCurrent("");
            setNext("");
            setNotice(
              "Password changed. Other member sessions have been signed out.",
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Current password" required>
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password" required>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Button disabled={busy}>{busy ? "Saving…" : "Change password"}</Button>
      </form>
    </>
  );
}

const emptyProfile = {
  first_name: "",
  last_name: "",
  birthdate: "",
  gender: "Unknown",
  phone: "",
  secondary_email: "",
  address: "",
  city: "",
  state: "",
  postal: "",
  email: "",
  kind: "player",
};
function MemberProfile({
  org,
  session,
  child,
}: {
  org: string;
  session: MemberSession;
  child: boolean;
}) {
  const [params] = useSearchParams();
  const personId = child
    ? undefined
    : params.get("person") || session.person_id;
  const { data, loading, error } = useData<typeof emptyProfile>(
    `/member/${org}/profiles/${personId || session.person_id}`,
    emptyProfile,
  );
  const properties = useData<CollectionSettings>(
    `/member/${org}/profile-properties`,
    emptyCollectionSettings,
  );
  const houses = useData<{ id: string; name: string }[]>(
    `/member/${org}/households`,
    [],
  );
  if (loading || houses.loading || properties.loading) return <Loading />;
  if (error || houses.error || properties.error)
    return <ErrorBox error={error || houses.error || properties.error} />;
  return (
    <MemberProfileEditor
      key={personId || "child"}
      org={org}
      personId={personId}
      initial={child ? emptyProfile : data}
      households={houses.data}
      properties={properties.data}
    />
  );
}
function MemberProfileEditor({
  org,
  personId,
  initial,
  households,
  properties,
}: {
  org: string;
  personId?: string;
  initial: typeof emptyProfile;
  households: { id: string; name: string }[];
  properties: CollectionSettings;
}) {
  const navigate = useNavigate();
  const [returnParams] = useSearchParams();
  const returnProgram = returnParams.get("program");
  const returnPath =
    `/site/${org}/account/` +
    (returnProgram
      ? `register?program=${encodeURIComponent(returnProgram)}`
      : "dashboard");
  const [form, setForm] = useState(initial),
    [household, setHousehold] = useState(households[0]?.id || "");
  const [y, m, d] = form.birthdate.split("-").map(Number),
    [cy, cm, cd] = properties.today.split("-").map(Number);
  const isChild =
    !personId ||
    (!!y && cy - y - (cm < m || (cm === m && cd < d) ? 1 : 0) < 18);
  const collectSecondary = !isChild && properties.collect_secondary_email;
  const collectPhone = isChild
    ? properties.collect_child_mobile
    : properties.collect_adult_mobile;
  const requiredFields = [
    "first_name",
    "last_name",
    "birthdate",
    ...(collectSecondary && properties.require_secondary_email
      ? ["secondary_email"]
      : []),
    ...(properties.require_address
      ? ["address", "city", "state", "postal"]
      : []),
    ...(!isChild && collectPhone && properties.require_adult_mobile
      ? ["phone"]
      : []),
  ];
  const [questions, setQuestions] = useState<RegistrationFormValues>({
    answers: {},
    waiver_acceptances: [],
    form_version: 0,
    has_waivers: false,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useState(0);
  return (
    <>
      <h1>{personId ? "Edit profile" : "Add child"}</h1>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      <form
        className="member-access-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await api(
              `/member/${org}/${personId ? `profiles/${personId}` : "children"}`,
              {
                method: personId ? "PUT" : "POST",
                body: JSON.stringify({
                  ...form,
                  household_id: household,
                  profile_answers: questions.answers,
                  profile_form_version: questions.form_version,
                  profile_record_version: questions.profile_record_version,
                }),
              },
            );
            if (!personId) navigate(returnPath);
            else {
              setNotice("Profile saved.");
              setQuestions((q) => ({ ...q, form_version: 0 }));
              setRevision((r) => r + 1);
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!personId && (
          <Field label="Family" required>
            <select
              value={household}
              required
              onChange={(e) => setHousehold(e.target.value)}
            >
              {households.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="form-grid">
          {(
            [
              ["first_name", "First name"],
              ["last_name", "Last name"],
              ["birthdate", "Birthdate"],
              ["phone", "Mobile number"],
              ["secondary_email", "Secondary email address"],
              ["address", "Address"],
              ["city", "City"],
              ["state", "State"],
              ["postal", "Postal code"],
            ] as const
          )
            .filter(
              ([key]) =>
                (key !== "phone" || collectPhone) &&
                (key !== "secondary_email" || collectSecondary),
            )
            .map(([key, label]) => (
              <Field
                key={key}
                label={label}
                required={requiredFields.includes(key)}
              >
                <input
                  type={
                    key === "birthdate"
                      ? "date"
                      : key === "phone"
                        ? "tel"
                        : key === "secondary_email"
                          ? "email"
                          : "text"
                  }
                  required={requiredFields.includes(key)}
                  value={form[key]}
                  onInput={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, [key]: value }));
                  }}
                  onChange={(e) => {
                    const value = e.target.value;
                    setForm((f) => ({ ...f, [key]: value }));
                  }}
                />
              </Field>
            ))}
          <Field label="Gender">
            <select
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value })}
            >
              {["Unknown", "Male", "Female", "Nonbinary"].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
        </div>
        {personId && form.email && <p>Email: {form.email}</p>}
        <ProfileQuestions
          key={revision}
          memberOrg={org}
          personId={personId}
          birthdate={form.birthdate}
          kind={form.kind}
          onChange={setQuestions}
        />
        <div className="form-actions start">
        <Button
          disabled={
            busy || !questions.form_version || (!personId && !household)
          }
        >
          {busy ? "Saving…" : personId ? "Save profile" : "Add child"}
        </Button>
        <Link to={returnPath}>
          {returnProgram ? "Back to registration" : "Back to dashboard"}
        </Link>
        </div>
      </form>
    </>
  );
}

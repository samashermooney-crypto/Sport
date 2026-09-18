import type { StaffRoleSettings } from "./staff-roles";
import { useTerminology } from "./terminology";
import { useEffect, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Copy, Mail, Trash2 } from "lucide-react";
import { api, shortDate } from "./api";
import {
  Button,
  DateInput,
  Check,
  DataTable,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  Tabs,
  useData,
} from "./components";
import { RichText, HtmlContent } from "./rich-text";
import type { Program, Location, Team } from "./types";

type Targets = {
  group: string;
  members: boolean;
  contacts: boolean;
  person_ids: string[];
  team_ids: string[];
  program_ids: string[];
  program_states: string[];
  sports: string[];
  seasons: string[];
  exclude_programs: boolean;
  gender: string;
  roles: string[];
  statuses: string[];
  payment: string;
  waiver: string;
  city: string;
  by_games: boolean;
  game_from: string;
  game_to: string;
  location_ids: string[];
  game_types: string[];
  include_admins: boolean;
  newsletter: boolean;
  copy_self: boolean;
};
type Draft = {
  id?: string;
  subject: string;
  body: string;
  channel: string;
  from_name: string;
  targets: Targets;
  mobile: boolean;
  expires: string;
  include_header: boolean;
  include_footer: boolean;
};
type Recipient = {
  id: string;
  name: string;
  address: string;
  channel: string;
  status: string;
  error: string;
  completed_at: string;
  provider_id?: string;
};
type Preview = {
  recipients: Recipient[];
  skipped: { name: string; reason: string }[];
  matched_members: number;
  email: number;
  sms: number;
};
type Message = Draft & {
  id: string;
  status: string;
  sender: string;
  created_at: string;
  queued_at: string;
  recipient_count: number;
  accepted_count: number;
  recipients: Recipient[];
};
type Configuration = {
  from_name: string;
  reply_to: string;
  header: string;
  footer: string;
  delivery: { email: boolean; sms: boolean; enabled: boolean };
};
type Template = { id: string; name: string; subject: string; body: string };
const emptyTarget: Targets = {
  group: "site",
  members: true,
  contacts: false,
  person_ids: [],
  team_ids: [],
  program_ids: [],
  program_states: ["Upcoming", "Live"],
  sports: [],
  seasons: [],
  exclude_programs: false,
  gender: "",
  roles: [
    "Team Captain",
    "Team Player",
    "Free Agent",
    "Captain",
    "Coach",
    "Volunteer",
  ],
  statuses: ["Confirmed", "Pending", "Wait List"],
  payment: "",
  waiver: "",
  city: "",
  by_games: false,
  game_from: "",
  game_to: "",
  location_ids: [],
  game_types: [],
  include_admins: false,
  newsletter: false,
  copy_self: false,
};
const blank: Draft = {
  subject: "",
  body: "",
  channel: "email",
  from_name: "",
  targets: emptyTarget,
  mobile: true,
  expires: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  include_header: false,
  include_footer: false,
};
const emptyPreview: Preview = {
  recipients: [],
  skipped: [],
  matched_members: 0,
  email: 0,
  sms: 0,
};
const configDefault: Configuration = {
  from_name: "",
  reply_to: "",
  header: "",
  footer: "",
  delivery: { email: false, sms: false, enabled: false },
};
function MessageActions() {
  return (
    <aside className="message-actions">
      <h3>More Message Actions</h3>
      <h4>Email</h4>
      {[
        ["Add Email Contacts", "/messaging/contacts"],
        ["Email Settings", "/settings/email"],
        ["Email Templates", "/messaging/templates"],
        ["View All Sent Emails", "/messaging/sent"],
      ].map(([label, to]) => (
        <Link key={to} to={to}>
          › {label}
        </Link>
      ))}
      <h4>Text</h4>
      <Link to="/settings/sms">› Text Message Settings</Link>
      <Link to="/messaging/texts">› View All Sent Texts</Link>
    </aside>
  );
}
function Multi({
  label,
  values,
  onChange,
  options,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Field label={label}>
      <select
        multiple
        size={Math.min(8, Math.max(3, options.length))}
        value={values}
        onChange={(e) =>
          onChange(Array.from(e.target.selectedOptions, (o) => o.value))
        }
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
const opts = (items: string[]) => items.map((v) => ({ value: v, label: v }));
export function Composer() {
  const terminology = useTerminology();
  const seasonField = terminology.data?.fields.find((f) => f.key === "season");
  const { id } = useParams(),
    [search] = useSearchParams(),
    navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => ({
      ...blank,
      targets: {
        ...emptyTarget,
        person_ids: search.get("person") ? [search.get("person")!] : [],
        program_ids: search.get("program") ? [search.get("program")!] : [],
        team_ids: search.getAll("team"),
        ...(search.has("team")
          ? { roles: [], statuses: ["Confirmed", "Pending"] }
          : {}),
        group: search.has("team")
          ? "teams"
          : search.get("program")
            ? "programs"
            : "site",
      },
    })),
    [stage, setStage] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<Preview>(emptyPreview),
    [previewReady, setPreviewReady] = useState(false),
    [review, setReview] = useState(false),
    [showPreview, setShowPreview] = useState(false),
    [templateName, setTemplateName] = useState(""),
    [templateModal, setTemplateModal] = useState(false),
    [notice, setNotice] = useState("");
  const programs = useData<Program[]>("/programs", []),
    staffRoles = useData<StaffRoleSettings>("/settings/staff-roles", {
      version: 1,
      roles: [],
    }),
    teams = useData<(Team & { program_name?: string })[]>("/teams", []),
    locations = useData<Location[]>("/locations", []),
    config = useData<Configuration>("/messaging/configuration", configDefault),
    templates = useData<Template[]>("/messaging/templates", []);
  useEffect(() => {
    if (id)
      api<Message>("/messaging/messages/" + id)
        .then((m) => {
          setDraft({ ...m, targets: { ...emptyTarget, ...m.targets } });
          setStage(1);
        })
        .catch((e) => setError(e.message));
  }, [id]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const target = <K extends keyof Targets>(key: K, value: Targets[K]) =>
    setDraft((d) => ({ ...d, targets: { ...d.targets, [key]: value } }));
  const toggle = (key: "program_states" | "roles" | "statuses", v: string) =>
    target(
      key,
      draft.targets[key].includes(v)
        ? draft.targets[key].filter((x) => x !== v)
        : [...draft.targets[key], v],
    );
  useEffect(() => setPreviewReady(false), [draft.targets, draft.channel]);
  const requestPreview = async () => {
    const result = await api<Preview>("/messaging/preview", {
      method: "POST",
      body: JSON.stringify(draft),
    });
    setPreview(result);
    setPreviewReady(true);
    return result;
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const saved = await api<Message>(
      "/messaging/messages" + (draft.id ? "/" + draft.id : ""),
      {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify({
          ...draft,
          from_name: draft.from_name || config.data.from_name,
        }),
      },
    );
    setDraft(saved);
    return saved;
  };
  const delivery = config.data.delivery,
    canSend =
      delivery.enabled &&
      (draft.channel === "email"
        ? delivery.email
        : draft.channel === "sms"
          ? delivery.sms
          : delivery.email && delivery.sms);
  const t = draft.targets;
  return (
    <>
      <PageTitle title="Compose message" />
      <main className="content-page message-layout">
        <div className="message-main">
          <ErrorBox error={error || config.error || programs.error} />
          {notice && (
            <div className="success-box" role="status">
              {notice}
            </div>
          )}
          {stage === 0 ? (
            <>
              <h2>Create Target Grouping</h2>
              <p className="hint">
                Messages for youth members are sent to all parents in their
                family account. Duplicate addresses are removed.
              </p>
              {t.person_ids.length > 0 ? (
                <div className="notice">
                  A specific member is selected.{" "}
                  <button
                    className="text-button"
                    onClick={() => target("person_ids", [])}
                  >
                    Choose a different audience
                  </button>
                </div>
              ) : (
                <>
                  <label className="check">
                    <input
                      type="radio"
                      name="recipient-group"
                      checked={t.group === "teams"}
                      onChange={() =>
                        setDraft((d) => ({
                          ...d,
                          targets: {
                            ...d.targets,
                            group: "teams",
                            roles: [],
                            statuses: ["Confirmed", "Pending"],
                          },
                        }))
                      }
                    />
                    Send to Teams
                  </label>
                  {t.group === "teams" && (
                    <div className="recipient-section">
                      <ErrorBox error={teams.error} />
                      <Multi
                        label="Teams"
                        values={t.team_ids}
                        onChange={(v) => target("team_ids", v)}
                        options={teams.data.map((team) => ({
                          value: team.id,
                          label: `${team.name} — ${team.program_name || ""}`,
                        }))}
                      />
                      <Multi
                        label="Team recipient roles"
                        values={t.roles}
                        onChange={(roles) => target("roles", roles)}
                        options={opts([
                          ...new Set([
                            "Team Player",
                            "Free Agent",
                            ...staffRoles.data.roles.map((r) => r.name),
                            ...t.roles,
                          ]),
                        ])}
                      />
                      <ErrorBox error={staffRoles.error} />
                      <small>
                        Select at least one team. No role selection includes all
                        player and assigned staff roles; youth messages go to
                        parents.
                      </small>
                      {["Confirmed", "Pending", "Wait List"].map((status) => (
                        <Check
                          key={status}
                          checked={t.statuses.includes(status)}
                          onChange={() => toggle("statuses", status)}
                        >
                          {status}
                        </Check>
                      ))}
                    </div>
                  )}
                  <label className="check">
                    <input
                      type="radio"
                      name="recipient-group"
                      checked={t.group === "site"}
                      onChange={() => target("group", "site")}
                    />
                    Send to Site Members
                  </label>
                  {t.group === "site" && (
                    <div className="recipient-section">
                      <Check
                        checked={t.members}
                        onChange={(e) => target("members", e.target.checked)}
                      >
                        All Site Members
                      </Check>
                      <Check
                        checked={t.contacts}
                        onChange={(e) => target("contacts", e.target.checked)}
                      >
                        All Email Contacts
                      </Check>
                    </div>
                  )}
                  <label className="check">
                    <input
                      type="radio"
                      name="recipient-group"
                      checked={t.group === "programs"}
                      onChange={() => target("group", "programs")}
                    />
                    Filter by Programs and Games
                  </label>
                  {t.group === "programs" && (
                    <div className="recipient-section">
                      <h4>by Programs and Teams</h4>
                      <div className="check-row">
                        {["Upcoming", "Live", "Completed", "Unpublished"].map(
                          (s) => (
                            <Check
                              key={s}
                              checked={t.program_states.includes(s)}
                              onChange={() => toggle("program_states", s)}
                            >
                              {s}
                            </Check>
                          ),
                        )}
                      </div>
                      <div className="target-programs">
                        <Multi
                          label="Sports"
                          values={t.sports}
                          onChange={(v) => target("sports", v)}
                          options={opts([
                            ...new Set(programs.data.map((p) => p.sport)),
                          ])}
                        />
                        <Multi
                          label={seasonField?.label || "Season"}
                          values={t.seasons}
                          onChange={(v) => target("seasons", v)}
                          options={opts([...new Set([
                            ...(seasonField?.options.map((o) => o.label) || []),
                            ...programs.data.map((p) => p.season),
                            ...t.seasons,
                          ])].filter(Boolean))}
                        />
                        <Multi
                          label="Programs"
                          values={t.program_ids}
                          onChange={(v) => target("program_ids", v)}
                          options={programs.data.map((p) => ({
                            value: p.id,
                            label: p.name,
                          }))}
                        />
                      </div>
                      <small>
                        No selection includes all matching programs.
                      </small>
                      <Check
                        checked={t.exclude_programs}
                        onChange={(e) =>
                          target("exclude_programs", e.target.checked)
                        }
                      >
                        Exclude the programs matching these filters
                      </Check>
                      <Check
                        checked={t.by_games}
                        onChange={(e) => target("by_games", e.target.checked)}
                      >
                        by Games (search by date and time)
                      </Check>
                      {t.by_games && (
                        <div className="form-grid">
                          <Field label="Beginning at">
                            <DateInput
                              type="datetime-local"
                              value={t.game_from ? localDate(t.game_from) : ""}
                              onChange={(e) =>
                                target(
                                  "game_from",
                                  e.target.value
                                    ? new Date(e.target.value).toISOString()
                                    : "",
                                )
                              }
                            />
                          </Field>
                          <Field label="Ending at">
                            <DateInput
                              type="datetime-local"
                              value={t.game_to ? localDate(t.game_to) : ""}
                              onChange={(e) =>
                                target(
                                  "game_to",
                                  e.target.value
                                    ? new Date(e.target.value).toISOString()
                                    : "",
                                )
                              }
                            />
                          </Field>
                          <Multi
                            label="Game locations"
                            values={t.location_ids}
                            onChange={(v) => target("location_ids", v)}
                            options={locations.data.map((l) => ({
                              value: l.id,
                              label: l.name,
                            }))}
                          />
                        </div>
                      )}
                      <h4>by Roles, Status and Payment Status</h4>
                      <div className="check-row">
                        {[
                          "Team Captain",
                          "Team Player",
                          "Free Agent",
                          "Captain",
                          "Coach",
                          "Volunteer",
                        ].map((r) => (
                          <Check
                            key={r}
                            checked={t.roles.includes(r)}
                            onChange={() => toggle("roles", r)}
                          >
                            {r}
                          </Check>
                        ))}
                      </div>
                      <div className="check-row">
                        {["Confirmed", "Pending", "Wait List"].map((s) => (
                          <Check
                            key={s}
                            checked={t.statuses.includes(s)}
                            onChange={() => toggle("statuses", s)}
                          >
                            {s === "Confirmed"
                              ? "Spot Reserved"
                              : s === "Pending"
                                ? "Spot Pending"
                                : "Waiting List"}
                          </Check>
                        ))}
                      </div>
                      <div className="form-grid">
                        <Field label="Payment">
                          <Select
                            value={t.payment}
                            onChange={(e) => target("payment", e.target.value)}
                            options={[
                              { value: "", label: "Any payment status" },
                              { value: "None", label: "Not invoiced" },
                              { value: "Owes", label: "Still owe fees" },
                              { value: "Paid", label: "Fully paid" },
                            ]}
                          />
                        </Field>
                        <Field label="Waiver">
                          <Select
                            value={t.waiver}
                            onChange={(e) => target("waiver", e.target.value)}
                            options={[
                              { value: "", label: "Any waiver status" },
                              ...opts(["Accepted", "Not accepted"]),
                            ]}
                          />
                        </Field>
                      </div>
                    </div>
                  )}
                  <label className="check">
                    <input
                      type="radio"
                      name="recipient-group"
                      checked={t.group === "admins"}
                      onChange={() => target("group", "admins")}
                    />
                    Send to Admins only
                  </label>
                  {t.group !== "admins" && (
                    <div className="form-grid recipient-section">
                      <Field label="Gender">
                        <Select
                          value={t.gender}
                          onChange={(e) => target("gender", e.target.value)}
                          options={[
                            { value: "", label: "All genders" },
                            ...opts([
                              "Male",
                              "Female",
                              "Non-binary",
                              "Unknown",
                            ]),
                          ]}
                        />
                      </Field>
                      <Field label="Member city">
                        <input
                          value={t.city}
                          onChange={(e) => target("city", e.target.value)}
                          placeholder="All member locations"
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
              <div className="message-divider">
                <Check
                  checked={t.include_admins}
                  onChange={(e) => target("include_admins", e.target.checked)}
                >
                  Also send to admins
                </Check>
                <Check
                  checked={t.newsletter}
                  onChange={(e) => target("newsletter", e.target.checked)}
                >
                  Send as Opt-Out newsletter (excludes opt-out members, email
                  only)
                </Check>
                <Check
                  checked={t.copy_self}
                  onChange={(e) => target("copy_self", e.target.checked)}
                >
                  Also send me a copy
                </Check>
              </div>
              <h2>Message Type</h2>
              {[
                ["email", "An email"],
                ["both", "An email & a text message"],
                ["sms", "A text message only"],
              ].map(([value, label]) => (
                <label className="check" key={value}>
                  <input
                    type="radio"
                    name="channel"
                    checked={draft.channel === value}
                    onChange={() => set("channel", value)}
                  />
                  {label}
                </label>
              ))}
              {draft.channel !== "email" && (
                <p className="hint">
                  Text recipients need an international phone number and
                  recorded SMS consent.
                </p>
              )}
              <Check
                checked={draft.mobile}
                onChange={(e) => set("mobile", e.target.checked)}
              >
                Also share this message in the member announcement feed
              </Check>
              {draft.mobile && (
                <Field label="Announcement expiration">
                  <DateInput
                    type="date"
                    value={draft.expires}
                    onChange={(e) => set("expires", e.target.value)}
                  />
                </Field>
              )}
              <div className="form-actions">
                <Button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await requestPreview();
                      setStage(1);
                    })
                  }
                >
                  Compose Message
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="recipient-summary">
                <h2>Recipients</h2>
                <button className="text-button" onClick={() => setStage(0)}>
                  Edit Recipients
                </button>
                <span>
                  {previewReady
                    ? `${preview.email} email addresses · ${preview.sms} text recipients`
                    : "Refresh recipients to see the current audience"}
                </span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await requestPreview();
                      setShowPreview(true);
                    })
                  }
                >
                  View Recipients
                </button>
              </div>
              <div className="message-editor-form">
                <Field label="From Name">
                  <input
                    value={draft.from_name || config.data.from_name}
                    onChange={(e) => set("from_name", e.target.value)}
                  />
                </Field>
                <Field label="Subject Line" required={draft.channel !== "sms"}>
                  <input
                    value={draft.subject}
                    maxLength={255}
                    onChange={(e) => set("subject", e.target.value)}
                  />
                </Field>
                {templates.data.length > 0 && (
                  <Field label="Use a template">
                    <Select
                      value=""
                      onChange={(e) => {
                        const temp = templates.data.find(
                          (t) => t.id === e.target.value,
                        );
                        if (temp)
                          setDraft((d) => ({
                            ...d,
                            subject: temp.subject,
                            body: temp.body,
                          }));
                      }}
                      options={[
                        { value: "", label: "Choose template" },
                        ...templates.data.map((t) => ({
                          value: t.id,
                          label: t.name,
                        })),
                      ]}
                    />
                  </Field>
                )}
                <RichText value={draft.body} onChange={(v) => set("body", v)} />
                <Check
                  checked={draft.include_header}
                  onChange={(e) => set("include_header", e.target.checked)}
                >
                  Include custom email header
                </Check>
                <Check
                  checked={draft.include_footer}
                  onChange={(e) => set("include_footer", e.target.checked)}
                >
                  Include custom email footer
                </Check>
                <Link to="/settings/email">Edit header and footer</Link>
                {!canSend && (
                  <p className="notice">
                    Delivery is not configured. You can save a draft or place
                    this message in the outbox for later release.
                  </p>
                )}
                <div className="form-actions">
                  <Button secondary onClick={() => setShowPreview(true)}>
                    Preview Email
                  </Button>
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await save();
                        setNotice("Draft saved.");
                      })
                    }
                  >
                    Save Draft
                  </Button>
                  <Button secondary onClick={() => setTemplateModal(true)}>
                    Save as Template
                  </Button>
                  <Button
                    disabled={busy || draft.body.length > 65500}
                    onClick={() =>
                      perform(async () => {
                        await requestPreview();
                        setReview(true);
                      })
                    }
                  >
                    {canSend ? "Send This Message" : "Save to Outbox"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
        <MessageActions />
      </main>
      {showPreview && (
        <Modal
          title="Message preview"
          wide
          onClose={() => setShowPreview(false)}
        >
          <div className="modal-body">
            <h3>{draft.subject || "(No subject)"}</h3>
            <p>From: {draft.from_name || config.data.from_name}</p>
            <HtmlContent
              html={
                (draft.include_header ? config.data.header : "") +
                draft.body +
                (draft.include_footer ? config.data.footer : "")
              }
            />
            <h3>
              Recipients · {preview.email} email · {preview.sms} text
            </h3>
            <RecipientTable recipients={preview.recipients} />
            {preview.skipped.length > 0 && (
              <p>
                {preview.skipped.length} addresses excluded by consent or
                suppression settings.
              </p>
            )}
          </div>
        </Modal>
      )}
      {review && (
        <Modal
          title={canSend ? "Review and send message" : "Review outbox message"}
          onClose={() => setReview(false)}
        >
          <div className="modal-body">
            <h3>{draft.subject || "Text message"}</h3>
            <p>
              {preview.email} unique email addresses and {preview.sms} text
              recipients.
            </p>
            <p>
              {canSend
                ? "This message will be queued for delivery."
                : "No messages will be sent. This message will wait for delivery configuration and manual release."}
            </p>
            <ErrorBox error={error} />
            <div className="form-actions">
              <Button secondary onClick={() => setReview(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy || !preview.recipients.length}
                onClick={() =>
                  perform(async () => {
                    const saved = await save();
                    await api("/messaging/messages/" + saved.id + "/queue", {
                      method: "POST",
                    });
                    navigate("/messaging/sent?view=Outbox");
                  })
                }
              >
                {busy ? "Saving…" : canSend ? "Confirm Send" : "Save to Outbox"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {templateModal && (
        <Modal
          title="Save email template"
          onClose={() => setTemplateModal(false)}
        >
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                await api("/messaging/templates", {
                  method: "POST",
                  body: JSON.stringify({
                    name: templateName,
                    subject: draft.subject,
                    body: draft.body,
                  }),
                });
                templates.reload();
                setTemplateModal(false);
                setNotice("Template saved.");
              });
            }}
          >
            <Field label="Template name">
              <input
                required
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </Field>
            <ErrorBox error={error} />
            <div className="form-actions">
              <Button disabled={busy}>Save Template</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function localDate(value: string) {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function RecipientTable({ recipients }: { recipients: Recipient[] }) {
  return (
    <DataTable
      pagination
      rows={recipients.map((r, i) => ({ ...r, id: r.id || String(i) }))}
      columns={[
        { key: "name", label: "Name" },
        { key: "address", label: "Email / phone" },
        { key: "channel", label: "Channel" },
        {
          key: "status",
          label: "Status",
          render: (r) => r.status || "Selected",
        },
        { key: "error", label: "Details" },
      ]}
    />
  );
}
export function MessageHistory() {
  const [search] = useSearchParams(),
    location = useLocation(),
    text = location.pathname === "/messaging/texts",
    data = useData<Message[]>("/messaging/messages", []),
    [tab, setTab] = useState(search.get("view") || "Sent"),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(""),
    navigate = useNavigate();
  const rows = data.data.filter(
    (m) =>
      (text ? m.channel !== "email" : m.channel !== "sms") &&
      (tab === "Drafts"
        ? m.status === "Draft"
        : tab === "Outbox"
          ? ["Queued", "Awaiting configuration", "Processing"].includes(
              m.status,
            )
          : ![
              "Draft",
              "Queued",
              "Awaiting configuration",
              "Processing",
            ].includes(m.status)),
  );
  return (
    <>
      <PageTitle title={text ? "Sent Text Messages" : "Sent Email Messages"} />
      <main className="content-page">
        <p>
          Each address appears once per message, including parents in family
          accounts. Provider acceptance is shown separately from delivery.
        </p>
        <ErrorBox error={error || data.error} />
        <div className="page-tools">
          <Tabs
            items={["Sent", "Outbox", "Drafts"]}
            value={tab}
            onChange={setTab}
          />
          <Link className="button" to="/messaging/compose">
            Compose a Message
          </Link>
        </div>
        <DataTable
          pagination
          rows={rows}
          columns={[
            {
              key: "subject",
              label: "Subject",
              render: (m) => <strong>{m.subject || "(No subject)"}</strong>,
            },
            { key: "sender", label: "Sender" },
            { key: "type", label: "Type", render: () => "Broadcast Message" },
            {
              key: "created_at",
              label: "Date Created",
              render: (m) => shortDate(m.created_at),
            },
            { key: "status", label: "Status" },
            {
              key: "accepted_count",
              label: "Accepted / Recipients",
              render: (m) => `${m.accepted_count} / ${m.recipient_count}`,
            },
            {
              key: "actions",
              label: "Actions",
              render: (m) => (
                <div className="row-actions">
                  {m.status === "Draft" ? (
                    <Link to={"/messaging/compose/" + m.id}>Edit Draft</Link>
                  ) : (
                    <Link to={"/messaging/messages/" + m.id}>
                      Tracking Details
                    </Link>
                  )}
                  <button
                    className="text-button"
                    onClick={() => setExpanded(expanded === m.id ? "" : m.id)}
                  >
                    View Message
                  </button>
                  <button
                    title="Copy message"
                    onClick={async () => {
                      try {
                        const copy = await api<Message>(
                          "/messaging/messages/" + m.id + "/copy",
                          { method: "POST" },
                        );
                        navigate("/messaging/compose/" + copy.id);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <Copy size={14} />
                  </button>
                </div>
              ),
            },
          ]}
        />
        {expanded && (
          <div className="message-inline">
            <Button secondary onClick={() => setExpanded("")}>
              Close Message
            </Button>
            <HtmlContent
              html={data.data.find((m) => m.id === expanded)?.body || ""}
            />
          </div>
        )}
      </main>
    </>
  );
}
export function MessageDetail() {
  const { id } = useParams(),
    data = useData<Message | null>("/messaging/messages/" + id, null),
    config = useData<Configuration>("/messaging/configuration", configDefault),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState("");
  if (data.loading) return <Loading />;
  if (!data.data) return <ErrorBox error={data.error} />;
  const m = data.data;
  const action = async (path: string) => {
    setBusy(true);
    try {
      await api("/messaging/messages/" + id + "/" + path, { method: "POST" });
      data.reload();
      setConfirm("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const configured =
    config.data.delivery.enabled &&
    (m.channel === "email"
      ? config.data.delivery.email
      : m.channel === "sms"
        ? config.data.delivery.sms
        : config.data.delivery.email && config.data.delivery.sms);
  return (
    <>
      <PageTitle
        title="Message Tracking Details"
        crumbs={[{ label: "Messages", to: "/messaging/sent" }]}
      />
      <main className="content-page">
        <ErrorBox error={error || data.error} />
        <h2>{m.subject || "Text message"}</h2>
        <div className="page-tools">
          <span className="status-pill">{m.status}</span>
          {m.status === "Awaiting configuration" && (
            <Button
              disabled={!configured || busy}
              onClick={() => setConfirm("queue")}
            >
              Release Message
            </Button>
          )}
          {["Draft", "Queued", "Awaiting configuration"].includes(m.status) && (
            <Button
              secondary
              disabled={busy}
              onClick={() => setConfirm("cancel")}
            >
              Cancel Message
            </Button>
          )}
        </div>
        {m.status === "Awaiting configuration" && (
          <p className="notice">
            Delivery is not configured. The message is held in the outbox until
            it is explicitly released.
          </p>
        )}
        <HtmlContent html={m.body} />
        <h3>Recipients ({m.recipients.length})</h3>
        <RecipientTable recipients={m.recipients} />
        <p className="hint">
          Accepted means the provider accepted the request. Delivery, open, and
          click events require provider webhook processing.
        </p>
      </main>
      {confirm && (
        <Modal
          title={
            confirm === "cancel"
              ? "Cancel queued message"
              : "Release message for delivery"
          }
          onClose={() => setConfirm("")}
        >
          <div className="modal-body">
            <p>
              {confirm === "cancel"
                ? "Recipients that have not been sent will be canceled."
                : "The message will be released to the delivery worker."}
            </p>
            <ErrorBox error={error} />
            <Button disabled={busy} onClick={() => action(confirm)}>
              Confirm
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function EmailContacts() {
  const data = useData<
      { id: string; email: string; status: string; created_at: string }[]
    >("/messaging/contacts", []),
    [adding, setAdding] = useState(false),
    [addresses, setAddresses] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState("");
  const update = async (id: string, status: string) => {
    try {
      await api("/messaging/contacts/" + id, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      data.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <PageTitle title="Email Contacts" />
      <main className="content-page">
        <ErrorBox error={error || data.error} />
        {adding ? (
          <form
            className="contact-add"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api("/messaging/contacts", {
                  method: "POST",
                  body: JSON.stringify({
                    emails: addresses
                      .split(/[,;\n]/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  }),
                });
                setAdding(false);
                setAddresses("");
                data.reload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Add new email addresses (comma separated)">
              <textarea
                rows={6}
                value={addresses}
                onChange={(e) => setAddresses(e.target.value)}
                required
              />
            </Field>
            <div className="form-actions">
              <Button disabled={busy}>Add</Button>
              <Button secondary type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="page-tools">
            <Button onClick={() => setAdding(true)}>Add Contacts</Button>
          </div>
        )}
        <DataTable
          pagination
          rows={data.data}
          columns={[
            { key: "email", label: "Email Address" },
            {
              key: "created_at",
              label: "Date Added",
              render: (r) => shortDate(r.created_at),
            },
            { key: "status", label: "Status" },
            {
              key: "actions",
              label: "Actions",
              render: (r) => (
                <div className="row-actions">
                  <button
                    className="text-button"
                    onClick={() =>
                      update(
                        r.id,
                        r.status === "Subscribed"
                          ? "Unsubscribed"
                          : "Subscribed",
                      )
                    }
                  >
                    {r.status === "Subscribed" ? "Unsubscribe" : "Subscribe"}
                  </button>
                  <button
                    aria-label={"Remove " + r.email}
                    onClick={() => setRemove(r.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ),
            },
          ]}
        />
      </main>
      {remove && (
        <Modal title="Remove email contact" onClose={() => setRemove("")}>
          <div className="modal-body">
            <p>Remove this address from the contact list?</p>
            <Button
              onClick={async () => {
                await api("/messaging/contacts/" + remove, {
                  method: "DELETE",
                });
                setRemove("");
                data.reload();
              }}
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function MessagingSettings({ sms = false }: { sms?: boolean }) {
  const data = useData<Configuration>(
      "/messaging/configuration",
      configDefault,
    ),
    [form, setForm] = useState(configDefault),
    [saved, setSaved] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setForm(data.data);
  }, [data.data]);
  return (
    <>
      <PageTitle title={sms ? "Text Message Settings" : "Email Settings"} />
      <main className="content-page message-layout">
        <div className="message-main">
          <ErrorBox error={error || data.error} />
          {sms ? (
            <>
              <h2>Text Messaging</h2>
              <p className="notice">
                {data.data.delivery.sms && data.data.delivery.enabled
                  ? "Text delivery is configured."
                  : "Text delivery is not configured."}
              </p>
              <p>
                Text messages go to members who have opted in and have a valid
                international mobile number. Manage an individual member’s SMS
                consent from their profile.
              </p>
              <Link to="/messaging/texts">View All Sent Texts</Link>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api("/messaging/configuration", {
                    method: "PUT",
                    body: JSON.stringify(form),
                  });
                  setSaved(true);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <h2>Email Defaults</h2>
              <p className="notice">
                {data.data.delivery.email && data.data.delivery.enabled
                  ? "Email delivery is configured."
                  : "Email delivery is not configured."}
              </p>
              <Field label="Default From Name">
                <input
                  required
                  value={form.from_name}
                  onChange={(e) =>
                    setForm({ ...form, from_name: e.target.value })
                  }
                />
              </Field>
              <Field label="Reply-to Email">
                <input
                  type="email"
                  value={form.reply_to}
                  onChange={(e) =>
                    setForm({ ...form, reply_to: e.target.value })
                  }
                />
              </Field>
              <h3>Custom Email Header</h3>
              <RichText
                label="Email header"
                value={form.header}
                onChange={(v) => setForm({ ...form, header: v })}
                maxLength={10000}
              />
              <h3>Custom Email Footer</h3>
              <RichText
                label="Email footer"
                value={form.footer}
                onChange={(v) => setForm({ ...form, footer: v })}
                maxLength={10000}
              />
              <div className="form-actions">
                <Button>Save Settings</Button>
                {saved && <span role="status">Settings saved.</span>}
              </div>
            </form>
          )}
        </div>
        <MessageActions />
      </main>
    </>
  );
}
export function EmailTemplates() {
  const data = useData<Template[]>("/messaging/templates", []),
    navigate = useNavigate(),
    [error, setError] = useState("");
  return (
    <>
      <PageTitle title="Email Templates" />
      <main className="content-page">
        <ErrorBox error={error || data.error} />
        <div className="page-tools">
          <Link className="button" to="/messaging/compose">
            Create a Template in Composer
          </Link>
        </div>
        <DataTable
          rows={data.data}
          columns={[
            { key: "name", label: "Template Name" },
            { key: "subject", label: "Subject" },
            {
              key: "actions",
              label: "Actions",
              render: (t) => (
                <Button
                  secondary
                  onClick={async () => {
                    try {
                      const m = await api<Message>("/messaging/messages", {
                        method: "POST",
                        body: JSON.stringify({
                          ...blank,
                          subject: t.subject,
                          body: t.body,
                        }),
                      });
                      navigate("/messaging/compose/" + m.id);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Mail size={14} />
                  Use Template
                </Button>
              ),
            },
          ]}
        />
      </main>
    </>
  );
}

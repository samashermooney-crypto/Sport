import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Plus, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { api, money, shortDate } from "./api";
import {
  Button,
  Check,
  DataTable,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  Tabs,
  useData,
} from "./components";
import { HtmlContent, RichText } from "./rich-text";
import { EventResult, type GameResult } from "./event-result";
import { MemberAccount, type MemberSession } from "./member-account";
import { PublicStore } from "./public-store";

type Page = {
  id: string;
  org_id: string;
  name: string;
  title: string;
  slug: string;
  kind: string;
  external_url: string;
  published: boolean;
  requires_login: boolean;
  menu_enabled: boolean;
  menu_label: string;
  menu_parent_id: string | null;
  menu_order: number;
  version?: number;
  content: string;
  meta_description: string;
  meta_keywords: string;
  template: string;
  mobile_intro: string;
  mobile_summary: string;
  mobile_cta: boolean;
  mobile_url: string;
  mobile_image_id: string;
  created_at: string;
  updated_at: string;
};
type Theme = {
  primary: string;
  secondary: string;
  facebook: string;
  instagram: string;
  x: string;
  registration_filters: boolean;
  version?: number;
};
type Website = { org_id: string; pages: Page[]; theme: Theme };
const emptyTheme: Theme = {
  primary: "#3a67b2",
  secondary: "#252b2e",
  facebook: "",
  instagram: "",
  x: "",
  registration_filters: true,
};
const emptyWebsite: Website = { org_id: "", pages: [], theme: emptyTheme };
const blankPage: Page = {
  id: "",
  org_id: "",
  name: "",
  title: "",
  slug: "",
  kind: "custom",
  external_url: "",
  published: false,
  requires_login: false,
  menu_enabled: false,
  menu_label: "",
  menu_parent_id: null,
  menu_order: 0,
  content: "",
  meta_description: "",
  meta_keywords: "",
  template: "Standard",
  mobile_intro: "",
  mobile_summary: "",
  mobile_cta: false,
  mobile_url: "",
  mobile_image_id: "",
  created_at: "",
  updated_at: "",
};
const pageLink = (org: string, p: { slug: string }) =>
  `/site/${org}/pages/${p.slug}`;

export function WebsitePages() {
  const { data, loading, error, reload } = useData<Website>(
    "/website",
    emptyWebsite,
  );
  const [filter, setFilter] = useState("All Pages"),
    [sort, setSort] = useState("Created"),
    [applied, setApplied] = useState({ filter: "All Pages", sort: "Created" }),
    [removing, setRemoving] = useState<Page | null>(null),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  const rows = data.pages
    .filter(
      (p) =>
        applied.filter === "All Pages" ||
        (applied.filter === "Custom Pages"
          ? p.kind === "custom"
          : p.kind !== "custom"),
    )
    .sort((a, b) =>
      applied.sort === "Name"
        ? a.name.localeCompare(b.name)
        : applied.sort === "Updated"
          ? b.updated_at.localeCompare(a.updated_at)
          : a.created_at.localeCompare(b.created_at),
    );
  return (
    <>
      <PageTitle title="Manage Your Pages" />
      <main className="content-page">
        <ErrorBox error={error || failure} />
        <div className="website-columns">
          <section>
            <div className="filter-row">
              <span>Show</span>
              <Select
                aria-label="Show pages"
                options={["All Pages", "Custom Pages", "Default Pages"]}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <span>Sorted by</span>
              <Select
                aria-label="Sort pages"
                options={["Created", "Updated", "Name"]}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              />
              <Button secondary onClick={() => setApplied({ filter, sort })}>
                Apply
              </Button>
            </div>
            <div className="website-list-actions">
              <Check
                checked={data.theme.registration_filters}
                disabled={busy || loading}
                onChange={async (e) => {
                  setBusy(true);
                  try {
                    await api("/website/theme", {
                      method: "PUT",
                      body: JSON.stringify({
                        ...data.theme,
                        registration_filters: e.target.checked,
                      }),
                    });
                    reload();
                  } catch (e) {
                    setFailure((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Display registration listing filters?
              </Check>
              <Link className="button" to="/website/pages/new">
                <Plus size={14} /> New Page
              </Link>
            </div>
            {loading ? (
              <Loading />
            ) : (
              <DataTable
                rows={rows}
                columns={[
                  {
                    key: "name",
                    label: "Page Name",
                    render: (p) => (
                      <>
                        <Link to={`/website/pages/${p.id}/edit`}>{p.name}</Link>
                        {!p.published && (
                          <small className="cell-sub">Unpublished</small>
                        )}
                      </>
                    ),
                  },
                  {
                    key: "external",
                    label: "External",
                    render: (p) => (p.external_url ? "Yes" : "No"),
                  },
                  {
                    key: "kind",
                    label: "Type",
                    render: (p) => (p.kind === "custom" ? "Custom" : "Default"),
                  },
                  {
                    key: "menu",
                    label: "Menu",
                    render: (p) =>
                      p.menu_enabled ? p.menu_label || p.name : "—",
                  },
                  {
                    key: "created_at",
                    label: "Created",
                    render: (p) => shortDate(p.created_at),
                  },
                  {
                    key: "updated_at",
                    label: "Updated",
                    render: (p) => shortDate(p.updated_at),
                  },
                  {
                    key: "actions",
                    label: "Actions",
                    render: (p) => (
                      <div className="row-actions">
                        <Link
                          className="square-action"
                          aria-label={`Edit ${p.name}`}
                          to={`/website/pages/${p.id}/edit`}
                        >
                          <Pencil size={13} />
                        </Link>
                        {p.published && (
                          <Link
                            className="square-action"
                            aria-label={`View ${p.name}`}
                            to={pageLink(data.org_id, p)}
                          >
                            <ExternalLink size={13} />
                          </Link>
                        )}
                        {p.kind === "custom" && (
                          <button
                            className="square-action"
                            aria-label={`Delete ${p.name}`}
                            onClick={() => setRemoving(p)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </section>
          <aside className="website-help">
            <h3>Default and custom pages</h3>
            <p>
              Default pages provide your program listings, calendar, and other
              site features. Add custom pages for information about your
              organization.
            </p>
            <h3>Internal and external pages</h3>
            <p>
              Internal pages contain content you manage here. External pages
              link visitors to another website.
            </p>
            <h3>Your site</h3>
            <p>
              Published pages are available to visitors. Unpublished pages
              remain in your console.
            </p>
            {data.org_id && (
              <Link to={`/site/${data.org_id}`}>Visit your website →</Link>
            )}
          </aside>
        </div>
      </main>
      {removing && (
        <Modal title="Delete page" onClose={() => setRemoving(null)}>
          <div className="modal-body">
            <p>
              Delete “{removing.name}” and its revision history? Child menu
              items will move to the top level.
            </p>
            <ErrorBox error={failure} />
            <div className="form-actions">
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/website/pages/${removing.id}`, {
                      method: "DELETE",
                      body: JSON.stringify({ version: removing.version }),
                    });
                    setRemoving(null);
                    reload();
                  } catch (e) {
                    setFailure((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Delete page
              </Button>
              <Button secondary onClick={() => setRemoving(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function WebsitePageEditor({ mobile = false }: { mobile?: boolean }) {
  const { id } = useParams(),
    { data, loading, error } = useData<Website>("/website", emptyWebsite);
  const page = mobile
    ? data.pages.find((p) => p.kind === "home")
    : data.pages.find((p) => p.id === id);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if ((id || mobile) && !page) return <Empty>Page not found.</Empty>;
  return (
    <PageForm
      key={page?.id || "new"}
      initial={page || blankPage}
      site={data}
      mobile={mobile}
    />
  );
}
function PageForm({
  initial,
  site,
  mobile,
}: {
  initial: Page;
  site: Website;
  mobile: boolean;
}) {
  const [p, setP] = useState(initial),
    [external, setExternal] = useState(!!initial.external_url),
    [tab, setTab] = useState(mobile ? "Mobile Content" : "Page Content"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false),
    [history, setHistory] = useState(false),
    [saved, setSaved] = useState(false);
  const navigate = useNavigate();
  const set = <K extends keyof Page>(key: K, value: Page[K]) => {
    setP((old) => ({ ...old, [key]: value }));
    setSaved(false);
  };
  const parentOptions = site.pages.filter((candidate) => {
    let q: Page | undefined = candidate;
    const visited = new Set<string>();
    while (q) {
      if (q.id === p.id || visited.has(q.id)) return false;
      visited.add(q.id);
      q = site.pages.find((row) => row.id === q?.menu_parent_id);
    }
    return true;
  });
  const tabs = [
    "Page Content",
    "Advanced Properties",
    ...(p.kind === "home" ? ["Mobile Content"] : []),
  ];
  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const result = await api<Page>(
        p.id ? `/website/pages/${p.id}` : "/website/pages",
        {
          method: p.id ? "PUT" : "POST",
          body: JSON.stringify({
            ...p,
            external_url: external ? p.external_url : "",
            menu_label: p.menu_label || p.name,
            menu_order: p.menu_order || site.pages.length + 1,
          }),
        },
      );
      setP(result);
      setSaved(true);
      if (!p.id) navigate(`/website/pages/${result.id}/edit`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle title={p.id ? `Edit Page › ${p.name}` : "Create a New Page"} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="content-page"
      >
        <ErrorBox error={error} />
        {saved && (
          <p className="notice" role="status">
            Page saved.
          </p>
        )}
        {p.kind === "custom" && (
          <div className="filter-row">
            <label>
              <input
                type="radio"
                name="page-type"
                checked={!external}
                onChange={() => setExternal(false)}
              />{" "}
              Internal Page
            </label>
            <label>
              <input
                type="radio"
                name="page-type"
                checked={external}
                onChange={() => setExternal(true)}
              />{" "}
              External Page
            </label>
          </div>
        )}
        <div className="website-columns">
          <section>
            <div className="website-form-grid">
              <Field label="Page Name" required>
                <input
                  required
                  maxLength={100}
                  value={p.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field label="Page Title" required>
                <input
                  required
                  maxLength={160}
                  value={p.title}
                  onChange={(e) => set("title", e.target.value)}
                />
              </Field>
              <Field
                label="Internal URI"
                required
                hint="Use letters, numbers and hyphens."
              >
                <div className="uri-field">
                  <span>/pages/</span>
                  <input
                    required
                    pattern="[a-z0-9][a-z0-9-]{0,99}"
                    disabled={p.kind !== "custom"}
                    value={p.slug}
                    onChange={(e) => set("slug", e.target.value.toLowerCase())}
                  />
                </div>
              </Field>
              <div>
                <Check
                  checked={p.menu_enabled}
                  onChange={(e) => set("menu_enabled", e.target.checked)}
                >
                  Link to this page from main menu.
                </Check>
                <div className="website-form-grid compact">
                  <Field label="Under">
                    <Select
                      disabled={!p.menu_enabled}
                      options={[
                        { value: "", label: "Top level" },
                        ...parentOptions.map((q) => ({
                          value: q.id,
                          label: q.name,
                        })),
                      ]}
                      value={p.menu_parent_id || ""}
                      onChange={(e) =>
                        set("menu_parent_id", e.target.value || null)
                      }
                    />
                  </Field>
                  <Field label="Menu Label">
                    <input
                      disabled={!p.menu_enabled}
                      value={p.menu_label}
                      placeholder={p.name}
                      maxLength={100}
                      onChange={(e) => set("menu_label", e.target.value)}
                    />
                  </Field>
                </div>
              </div>
              <Field label="Requires Login">
                <Select
                  options={[
                    { value: "no", label: "No" },
                    { value: "yes", label: "Yes" },
                  ]}
                  value={p.requires_login ? "yes" : "no"}
                  onChange={(e) =>
                    set("requires_login", e.target.value === "yes")
                  }
                />
              </Field>
              <Field label="Visibility">
                <Select
                  options={["Unpublished", "Published"]}
                  value={p.published ? "Published" : "Unpublished"}
                  onChange={(e) =>
                    set("published", e.target.value === "Published")
                  }
                />
              </Field>
            </div>
            {external ? (
              <Field
                label="External URL"
                required
                hint="A complete https:// address or a path on this site."
              >
                <input
                  required
                  value={p.external_url}
                  maxLength={2000}
                  onChange={(e) => set("external_url", e.target.value)}
                />
              </Field>
            ) : (
              <>
                <Tabs items={tabs} value={tab} onChange={setTab} />
                {tab === "Page Content" && (
                  <RichText
                    label="Page Content"
                    value={p.content}
                    maxLength={100000}
                    onChange={(v) => set("content", v)}
                  />
                )}{" "}
                {tab === "Advanced Properties" && (
                  <>
                    <Field
                      label="META Description"
                      hint="A short description for search engines."
                    >
                      <textarea
                        rows={4}
                        maxLength={320}
                        value={p.meta_description}
                        onChange={(e) =>
                          set("meta_description", e.target.value)
                        }
                      />
                    </Field>
                    <Field label="META Keywords">
                      <textarea
                        rows={3}
                        maxLength={500}
                        value={p.meta_keywords}
                        onChange={(e) => set("meta_keywords", e.target.value)}
                      />
                    </Field>
                  </>
                )}
                {tab === "Mobile Content" && (
                  <>
                    <h2>Edit Mobile Homepage Content</h2>
                    <p>
                      Use a short introduction and summary on small screens.
                      Leave these fields empty to use the regular page content.
                    </p>
                    <Check
                      checked={p.mobile_cta}
                      onChange={(e) => set("mobile_cta", e.target.checked)}
                    >
                      Display call-to-action button on homepage?
                    </Check>
                    <Field label={p.mobile_cta ? "Button text" : "Intro text"}>
                      <input
                        value={p.mobile_intro}
                        maxLength={160}
                        onChange={(e) => set("mobile_intro", e.target.value)}
                      />
                    </Field>
                    {p.mobile_cta && (
                      <Field label="Button URL" required>
                        <input
                          required
                          value={p.mobile_url}
                          onChange={(e) => set("mobile_url", e.target.value)}
                        />
                      </Field>
                    )}
                    <Field label="Choose Background Image">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={busy}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 5 * 1024 * 1024) {
                            setError("Images must be 5MB or smaller.");
                            return;
                          }
                          setBusy(true);
                          try {
                            const asset = await api<{ id: string }>("/assets", {
                              method: "POST",
                              headers: { "Content-Type": file.type },
                              body: file,
                            });
                            set("mobile_image_id", asset.id);
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                            e.target.value = "";
                          }
                        }}
                      />
                    </Field>
                    {p.mobile_image_id && (
                      <div>
                        <img
                          className="website-image-preview"
                          alt="Mobile homepage background"
                          src={`/api/assets/${p.mobile_image_id}`}
                        />
                        <Button
                          type="button"
                          secondary
                          onClick={() => set("mobile_image_id", "")}
                        >
                          Remove image
                        </Button>
                      </div>
                    )}
                    <Field
                      label="Brief Site Summary"
                      hint={`${500 - p.mobile_summary.length} characters left`}
                    >
                      <textarea
                        rows={6}
                        maxLength={500}
                        value={p.mobile_summary}
                        onChange={(e) => set("mobile_summary", e.target.value)}
                      />
                    </Field>
                  </>
                )}
              </>
            )}
          </section>
          <aside>
            <div className="website-actions">
              <Button disabled={busy}>
                {busy ? "Saving…" : p.id ? "Update" : "Create"}
              </Button>
              <Button type="button" secondary onClick={() => setPreview(true)}>
                Preview
              </Button>
              {p.id && (
                <Button
                  type="button"
                  secondary
                  onClick={() => setHistory(true)}
                >
                  Revision history
                </Button>
              )}
              <Link className="button secondary" to="/website/pages">
                Cancel
              </Link>
            </div>
            {!external && (
              <div className="website-help">
                <h3>Page Template</h3>
                <p>Choose a starting layout for this page.</p>
                {["Standard", "Home Page", "FAQ", "Team Roster"].map(
                  (template) => (
                    <button
                      type="button"
                      key={template}
                      className={`website-template ${p.template === template ? "selected" : ""}`}
                      onClick={() => {
                        set("template", template);
                        if (!p.content) {
                          set(
                            "content",
                            template === "FAQ"
                              ? "<h2>Frequently asked questions</h2><h3>How do I register?</h3><p>Browse our programs and select a season.</p>"
                              : template === "Team Roster"
                                ? "<h2>Our team</h2><p>Add the information your organization has permission to publish.</p>"
                                : template === "Home Page"
                                  ? "<h2>Welcome to our community.</h2><p>Find a program and get ready to play.</p>"
                                  : "",
                          );
                        }
                      }}
                    >
                      <span className="template-thumbnail">
                        <i />
                        <i />
                        <i />
                      </span>
                      {template}
                    </button>
                  ),
                )}
              </div>
            )}
          </aside>
        </div>
      </form>
      {preview && (
        <Modal
          wide
          title="Page preview · unsaved content"
          onClose={() => setPreview(false)}
        >
          <div className="modal-body">
            <h1>{p.title || "Untitled page"}</h1>
            {external ? (
              <p>Links to: {p.external_url || "No URL entered"}</p>
            ) : (
              <HtmlContent
                html={tab === "Mobile Content" ? p.mobile_summary : p.content}
              />
            )}
          </div>
        </Modal>
      )}
      {history && (
        <PageHistory
          page={p}
          onClose={() => setHistory(false)}
          restored={(result) => {
            setP(result);
            setHistory(false);
            setSaved(true);
          }}
        />
      )}
    </>
  );
}
function PageHistory({
  page,
  onClose,
  restored,
}: {
  page: Page;
  onClose: () => void;
  restored: (p: Page) => void;
}) {
  const { data, loading, error } = useData<
      { id: string; version: number; created_at: string }[]
    >(`/website/pages/${page.id}/revisions`, []),
    [chosen, setChosen] = useState(""),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  return (
    <Modal title="Page revision history" onClose={onClose}>
      <div className="modal-body">
        <p>
          Restoring creates a new revision. The selected revision’s content,
          publication status, and menu placement will replace the current
          values.
        </p>
        <ErrorBox error={error || failure} />
        {loading ? (
          <Loading />
        ) : (
          <Field label="Revision">
            <Select
              options={[
                { value: "", label: "Choose a revision" },
                ...data
                  .filter((r) => r.version !== page.version)
                  .map((r) => ({
                    value: r.id,
                    label: `Version ${r.version} · ${new Date(r.created_at).toLocaleString()}`,
                  })),
              ]}
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
            />
          </Field>
        )}
        <div className="form-actions">
          <Button
            disabled={!chosen || busy}
            onClick={async () => {
              setBusy(true);
              try {
                restored(
                  await api(`/website/pages/${page.id}/restore`, {
                    method: "POST",
                    body: JSON.stringify({
                      revision_id: chosen,
                      version: page.version,
                    }),
                  }),
                );
              } catch (e) {
                setFailure((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Restore revision
          </Button>
          <Button secondary onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function WebsiteMenu() {
  const { data, loading, error } = useData<Website>("/website", emptyWebsite);
  return (
    <>
      <PageTitle title="Edit your Site’s Menu Items" />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <MenuForm site={data} />
      )}
    </>
  );
}
function MenuForm({ site }: { site: Website }) {
  const [rows, setRows] = useState(site.pages),
    [level, setLevel] = useState(""),
    [applied, setApplied] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  const visible = rows.filter((p) => (p.menu_parent_id || "") === applied),
    set = (id: string, key: keyof Page, value: unknown) => {
      setRows((old) =>
        old.map((p) => (p.id === id ? { ...p, [key]: value } : p)),
      );
      setSaved(false);
    };
  return (
    <main className="content-page website-menu-editor">
      <div className="filter-row">
        <span>Filter by level:</span>
        <Select
          aria-label="Menu level"
          options={[
            { value: "", label: "Top level" },
            ...rows.map((p) => ({
              value: p.id,
              label: p.menu_label || p.name,
            })),
          ]}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        />
        <Button secondary onClick={() => setApplied(level)}>
          Apply
        </Button>
      </div>
      <ErrorBox error={error} />
      {saved && (
        <p role="status" className="notice">
          Menu updated.
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            setRows(
              await api("/website/menu", {
                method: "PUT",
                body: JSON.stringify(
                  visible.map((p) => ({
                    id: p.id,
                    version: p.version,
                    menu_order: p.menu_order,
                    menu_label: p.menu_label || p.name,
                    menu_enabled: p.menu_enabled,
                  })),
                ),
              }),
            );
            setSaved(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <DataTable
          rows={visible}
          columns={[
            {
              key: "order",
              label: "Order",
              render: (p) => (
                <input
                  className="order-input"
                  aria-label={`Order for ${p.name}`}
                  required
                  type="number"
                  min={0}
                  max={10000}
                  value={p.menu_order}
                  onChange={(e) => set(p.id, "menu_order", +e.target.value)}
                />
              ),
            },
            {
              key: "label",
              label: "Label",
              render: (p) => (
                <input
                  aria-label={`Menu label for ${p.name}`}
                  required
                  maxLength={100}
                  value={p.menu_label || p.name}
                  onChange={(e) => set(p.id, "menu_label", e.target.value)}
                />
              ),
            },
            {
              key: "page",
              label: "Page",
              render: (p) => (
                <Link to={`/website/pages/${p.id}/edit`}>{p.title}</Link>
              ),
            },
            {
              key: "updated_at",
              label: "Last Updated",
              render: (p) => shortDate(p.updated_at),
            },
            {
              key: "active",
              label: "Active",
              render: (p) => (
                <input
                  type="checkbox"
                  aria-label={`Active ${p.name}`}
                  checked={p.menu_enabled}
                  onChange={(e) => set(p.id, "menu_enabled", e.target.checked)}
                />
              ),
            },
          ]}
        />
        <div className="form-actions">
          <Button disabled={busy || !visible.length}>
            {busy ? "Updating…" : "Update"}
          </Button>
          <Link to={`/site/${site.org_id}`}>View your site</Link>
        </div>
      </form>
    </main>
  );
}

export function WebsiteTheme() {
  const { data, loading, error } = useData<Website>("/website", emptyWebsite);
  return (
    <>
      <PageTitle title="Design › Branding and theme editor" />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <ThemeForm site={data} />
      )}
    </>
  );
}
function ThemeForm({ site }: { site: Website }) {
  const [t, setT] = useState(site.theme),
    [mobilePreview, setMobilePreview] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const set = (key: keyof Theme, value: string) => {
    setT((old) => ({ ...old, [key]: value }));
    setSaved(false);
  };
  return (
    <main className="content-page">
      <div className="website-theme-intro">
        <h2>Branding and theme editor</h2>
        <p>Set the colors and social links for your registration site.</p>
        <Link to={`/site/${site.org_id}`} className="button secondary">
          Preview site <ExternalLink size={13} />
        </Link>
        <Button type="button" secondary onClick={() => setMobilePreview(true)}>
          Preview mobile site
        </Button>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            setT(
              await api("/website/theme", {
                method: "PUT",
                body: JSON.stringify(t),
              }),
            );
            setSaved(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        {saved && (
          <p role="status" className="notice">
            Theme saved.
          </p>
        )}
        <div className="website-theme-grid">
          <section className="website-theme-panel">
            <h3>Colors</h3>
            <p>Choose two colors for your theme.</p>
            {(
              [
                ["primary", "Primary color"],
                ["secondary", "Secondary color"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <div className="website-color">
                  <input
                    aria-label={`${label} picker`}
                    type="color"
                    value={t[key]}
                    onInput={(e) => set(key, e.currentTarget.value)}
                    onChange={(e) => set(key, e.target.value)}
                  />
                  <input
                    required
                    pattern="#[0-9a-fA-F]{6}"
                    aria-label={label}
                    value={t[key]}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </div>
              </Field>
            ))}
          </section>
          <section className="website-theme-panel">
            <h3>Social media</h3>
            <p>Add complete addresses for your public profiles.</p>
            {(
              [
                ["facebook", "Facebook"],
                ["x", "X"],
                ["instagram", "Instagram"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  type="url"
                  placeholder={`https://${key === "x" ? "x" : key}.com/`}
                  value={t[key]}
                  onChange={(e) => set(key, e.target.value)}
                />
              </Field>
            ))}
          </section>
        </div>
        <div className="form-actions">
          <Button disabled={busy}>Save theme</Button>
        </div>
      </form>
      {mobilePreview && (
        <Modal
          title="Mobile site preview"
          onClose={() => setMobilePreview(false)}
        >
          <div className="modal-body">
            <p>Preview of your saved website, sized to fit this window.</p>
            <iframe
              className="mobile-site-preview"
              title="Mobile website"
              src={`/site/${site.org_id}`}
            />
          </div>
        </Modal>
      )}
    </main>
  );
}

type PublicSite = {
  terminology?: { season: string; level: string };
  organization: {
    id: string;
    name: string;
    timezone: string;
    currency: string;
  };
  theme: Theme;
  pages: Page[];
};
type PublicProgram = {
  id: string;
  parent_id: string | null;
  name: string;
  type: string;
  sport: string;
  season: string;
  gender: string;
  level: string;
  status: string;
  grouped: boolean;
  start_date: string;
  end_date: string;
  registration_start: string;
  registration_end: string;
  fee_cents: number;
  description: string;
  registration_status: string;
  registration_availability: { open: boolean; reason: string };
  location_id: string;
  password_required: boolean;
};
const programKinds = [
  "League",
  "Tournament",
  "Event",
  "Club team",
  "Camp",
  "Class",
];
export function PublicWebsite() {
  const location = useLocation(),
    parts = location.pathname.split("/"),
    org = parts[2] || "",
    section = parts[3] || "pages";
  const [memberRevision, setMemberRevision] = useState(0);
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const member = useData<MemberSession | null>(
    `/member/${encodeURIComponent(org)}/session?revision=${memberRevision}`,
    null,
  );
  const memberChanged = () => setMemberRevision((v) => v + 1);
  let slug = parts[4] || "home";
  try {
    slug = decodeURIComponent(slug);
  } catch {
    slug = "invalid";
  }
  const { data, loading, error } = useData<PublicSite>(
    `/public/sites/${encodeURIComponent(org)}`,
    {
      organization: {
        id: "",
        name: "",
        timezone: "America/Chicago",
        currency: "USD",
      },
      theme: emptyTheme,
      pages: [],
    },
  );
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  if (loading) return <Loading />;
  if (error)
    return (
      <main className="public-site-error">
        <h1>Website unavailable</h1>
        <ErrorBox error={error} />
        <Link to="/">Administrator sign in</Link>
      </main>
    );
  const style = {
    "--site-primary": data.theme.primary,
    "--site-secondary": data.theme.secondary,
  } as CSSProperties;
  return (
    <div className="public-site" style={style}>
      <header className="public-site-header">
        <Link className="public-site-brand" to={`/site/${org}`}>
          <span className="public-site-mark">A</span>
          {data.organization.name}
        </Link>
        <div className="member-header-links">
          {member.data ? (
            <>
              <Link to={`/site/${org}/account/dashboard`}>
                Hi, {member.data.first_name}
              </Link>
              <button
                className="text-button"
                disabled={loggingOut}
                onClick={async () => {
                  if (loggingOut) return;
                  setLoggingOut(true); setLogoutError("");
                  try { await api(`/member/${org}/logout`, { method: "POST" }); memberChanged(); }
                  catch { setLogoutError("Sign-out could not be confirmed. Check your connection and try signing out again."); }
                  finally { setLoggingOut(false); }
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <Link to={`/site/${org}/account/login`}>Member sign in</Link>
          )}
          <Link to="/">Administrator sign in</Link>
        </div>
      </header>
      <nav className="public-site-nav" aria-label="Website navigation">
        <PublicMenu pages={data.pages} org={org} />
      </nav>
      <main className="public-site-main">
        <ErrorBox error={logoutError}/>
        {section === "account" && member.error ? (<section><h1>Could not load your account</h1><ErrorBox error={member.error}/><Button onClick={memberChanged}>Retry</Button></section>) : section === "account" ? (
          <MemberAccount
            key={org + slug}
            org={org}
            page={slug}
            session={member.data}
            loading={member.loading}
            changed={memberChanged}
          />
        ) : section === "teams" ? (
          <PublicTeamRoster key={`${slug}:${memberRevision}`} org={org} teamId={slug} signedIn={!!member.data}/>
        ) : section === "programs" ? (
          <PublicProgramDetail
            key={slug}
            org={org}
            id={slug}
            timezone={data.organization.timezone}
          />
        ) : section === "pages" ? (
          <PublicPageView
            key={`${slug}:${memberRevision}`}
            site={data}
            slug={slug}
          />
        ) : (
          <Empty>Page not found.</Empty>
        )}
      </main>
      <footer className="public-site-footer">
        <strong>{data.organization.name}</strong>
        <div>
          {(
            [
              ["facebook", "Facebook"],
              ["x", "X"],
              ["instagram", "Instagram"],
            ] as const
          )
            .filter(([key]) => data.theme[key])
            .map(([key, label]) => (
              <a
                key={key}
                href={data.theme[key]}
                rel="noopener noreferrer"
                target="_blank"
              >
                {label}
              </a>
            ))}
          {data.pages
            .filter((p) => ["terms", "privacy"].includes(p.kind))
            .map((p) => (
              <Link key={p.id} to={pageLink(org, p)}>
                {p.title}
              </Link>
            ))}
        </div>
        <small>Powered by Athlentry</small>
      </footer>
    </div>
  );
}
function PublicMenu({
  pages,
  org,
  parent = null,
  depth = 0,
}: {
  pages: Page[];
  org: string;
  parent?: string | null;
  depth?: number;
}) {
  if (depth > 20) return null;
  return (
    <ul>
      {pages
        .filter((p) => p.menu_enabled && p.menu_parent_id === parent)
        .sort(
          (a, b) => a.menu_order - b.menu_order || a.name.localeCompare(b.name),
        )
        .map((p) => {
          const children = pages.some(
            (q) => q.menu_enabled && q.menu_parent_id === p.id,
          );
          return (
            <li key={p.id}>
              <Link to={pageLink(org, p)}>{p.menu_label || p.name}</Link>
              {children && (
                <details>
                  <summary aria-label={`More ${p.menu_label || p.name} pages`}>
                    ▾
                  </summary>
                  <PublicMenu
                    pages={pages}
                    org={org}
                    parent={p.id}
                    depth={depth + 1}
                  />
                </details>
              )}
            </li>
          );
        })}
    </ul>
  );
}
function PublicPageView({ site, slug }: { site: PublicSite; slug: string }) {
  const {
    data: p,
    loading,
    error,
  } = useData<Page | null>(
    `/public/sites/${site.organization.id}/pages/${encodeURIComponent(slug)}`,
    null,
  );
  useEffect(() => {
    if (!p) return;
    const originalTitle = document.title;
    document.title = `${p.title} | ${site.organization.name}`;
    const added: HTMLMetaElement[] = [];
    const changed: { node: HTMLMetaElement; content: string }[] = [];
    for (const [name, content] of [
      ["description", p.meta_description],
      ["keywords", p.meta_keywords],
    ]) {
      let node = document.head.querySelector<HTMLMetaElement>(
        `meta[name="${name}"]`,
      );
      if (node) changed.push({ node, content: node.content });
      else {
        node = document.createElement("meta");
        node.name = name;
        document.head.append(node);
        added.push(node);
      }
      node.content = content;
    }
    return () => {
      document.title = originalTitle;
      added.forEach((n) => n.remove());
      changed.forEach(({ node, content }) => (node.content = content));
    };
  }, [p, site.organization.name]);
  if (loading) return <Loading />;
  if (error)
    return (
      <>
        <h1>Page unavailable</h1>
        <ErrorBox error={error} />
        {site.pages.some(
          (page) => page.slug === slug && page.requires_login,
        ) && (
          <Link
            className="button"
            to={`/site/${site.organization.id}/account/login?return_page=${encodeURIComponent(slug)}`}
          >
            Member sign in
          </Link>
        )}
      </>
    );
  if (!p) return null;
  const hasMobile =
    p.kind === "home" &&
    !!(p.mobile_intro || p.mobile_summary || p.mobile_image_id);
  return (
    <>
      <h1>{p.title}</h1>
      {p.external_url ? (
        <p>
          This page is on another website.{" "}
          <a href={p.external_url} rel="noopener noreferrer">
            Continue to {p.title} →
          </a>
        </p>
      ) : (
        <>
          {p.content.trim() && (
            <div className={hasMobile ? "public-desktop-content" : ""}>
              <HtmlContent html={p.content} />
            </div>
          )}
          {hasMobile && (
            <section
              className="public-mobile-intro"
              style={
                p.mobile_image_id
                  ? {
                      backgroundImage: `linear-gradient(#ffffffcf,#ffffffcf),url(/api/public/sites/${site.organization.id}/assets/${p.mobile_image_id})`,
                    }
                  : undefined
              }
            >
              {p.mobile_cta ? (
                <a className="button" href={p.mobile_url}>
                  {p.mobile_intro}
                </a>
              ) : (
                <h2>{p.mobile_intro}</h2>
              )}
              <HtmlContent html={p.mobile_summary} />
            </section>
          )}
          {programKinds.includes(p.kind) && (
            <PublicPrograms
              org={site.organization.id}
              kind={p.kind}
              filters={site.theme.registration_filters}
              terminology={site.terminology}
            />
          )}{" "}
          {p.kind === "home" && (
            <PublicPrograms
              org={site.organization.id}
              kind=""
              filters={false}
              terminology={site.terminology}
              featured
            />
          )}
          {p.kind === "calendar" && (
            <PublicSchedule
              org={site.organization.id}
              timezone={site.organization.timezone}
            />
          )}{" "}
          {p.kind === "locations" && (
            <PublicLocations org={site.organization.id} />
          )}{" "}
          {p.kind === "store" && <PublicStore key={site.organization.id} org={site.organization.id} />}
          {p.kind === "blog" && !p.content && <Empty>No posts yet.</Empty>}
        </>
      )}
    </>
  );
}
function PublicPrograms({
  org,
  terminology,
  kind,
  filters,
  featured = false,
}: {
  org: string;
  terminology?: PublicSite["terminology"];
  kind: string;
  filters: boolean;
  featured?: boolean;
}) {
  const { data, loading, error } = useData<PublicProgram[]>(
      `/public/sites/${org}/programs`,
      [],
    ),
    [query, setQuery] = useState(""),
    [sport, setSport] = useState(""),
    [season, setSeason] = useState(""),
    [gender, setGender] = useState(""),
    [level, setLevel] = useState("");
  const all = data.filter((p) => (!kind || p.type === kind) && !p.parent_id),
    rows = all.filter(
      (p) =>
        (!query || p.name.toLowerCase().includes(query.toLowerCase())) &&
        (!sport || p.sport === sport) &&
        (!season || p.season === season) &&
        (!gender || p.gender === gender) &&
        (!level || p.level === level),
    );
  return (
    <section className="public-programs">
      {featured && <h2>Explore our programs</h2>}
      <ErrorBox error={error} />
      {filters && (
        <div className="public-filters">
          <Field label="Search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Program name"
            />
          </Field>
          {(
            [
              ["Sport", sport, setSport, "sport"],
              [terminology?.season || "Season", season, setSeason, "season"],
              ["Gender", gender, setGender, "gender"],
              [terminology?.level || "Level", level, setLevel, "level"],
            ] as const
          ).map(([label, value, set, key]) => (
            <Field key={key} label={label}>
              <Select
                value={value}
                onChange={(e) => set(e.target.value)}
                options={[
                  { value: "", label: `Any ${label.toLowerCase()}` },
                  ...Array.from(new Set(all.map((p) => p[key])))
                    .sort()
                    .map((v) => ({ value: v, label: v })),
                ]}
              />
            </Field>
          ))}
        </div>
      )}
      {loading ? (
        <Loading />
      ) : (
        <div>
          {(featured
            ? rows.filter((p) => p.status !== "Completed").slice(0, 6)
            : rows
          ).map((p) => (
            <article key={p.id} className="public-program-row">
              <div>
                <p className="public-eyebrow">
                  {p.sport} · {p.season} · {p.type}
                </p>
                <h3>
                  <Link to={`/site/${org}/programs/${p.id}`}>{p.name}</Link>
                </h3>
                <p>
                  {p.start_date && shortDate(p.start_date)}
                  {p.end_date && ` – ${shortDate(p.end_date)}`} · {p.gender} ·{" "}
                  {p.level}
                </p>
              </div>
              <div>
                <span>{p.registration_status || p.status}</span>
                <Link
                  className="button secondary"
                  to={`/site/${org}/programs/${p.id}`}
                >
                  View details
                </Link>
              </div>
            </article>
          ))}
          {!(featured
            ? rows.some((p) => p.status !== "Completed")
            : rows.length) && <Empty>No programs match your selection.</Empty>}
        </div>
      )}
    </section>
  );
}
function PublicProgramDetail({
  org,
  id,
  timezone,
}: {
  org: string;
  id: string;
  timezone: string;
}) {
  const { data, loading, error } = useData<PublicProgram[]>(
      `/public/sites/${org}/programs`,
      [],
    ),
    p = data.find((p) => p.id === id);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Empty>Program not found.</Empty>;
  return (
    <>
      <p className="public-eyebrow">
        {p.sport} · {p.season} · {p.type}
      </p>
      <h1>{p.name}</h1>
      <div className="public-program-detail">
        <section>
          <dl>
            <dt>Dates</dt>
            <dd>
              {p.start_date ? shortDate(p.start_date) : "To be announced"}
              {p.end_date && ` – ${shortDate(p.end_date)}`}
            </dd>
            <dt>Eligibility</dt>
            <dd>
              {p.gender} · {p.level}
            </dd>
            <dt>Status</dt>
            <dd>{p.registration_status || p.status}</dd>
          </dl>
          <HtmlContent html={p.description} />
          {p.grouped && (
            <section>
              <h2>Divisions</h2>
              {data
                .filter((q) => q.parent_id === p.id)
                .map((q) => (
                  <p key={q.id}>
                    <Link to={`/site/${org}/programs/${q.id}`}>{q.name}</Link> ·{" "}
                    {money(q.fee_cents)}
                  </p>
                ))}
            </section>
          )}
          <PublicSchedule org={org} programId={p.id} timezone={timezone} />
          <PublicStandings org={org} programId={p.id} />
        </section>
        {!p.grouped && (
          <aside>
            <h2>{money(p.fee_cents)}</h2>
            <p>Program fee</p>
            {p.registration_start && (
              <p>Registration opens {shortDate(p.registration_start)}</p>
            )}
            {p.registration_end && (
              <p>Registration closes {shortDate(p.registration_end)}</p>
            )}
            {p.registration_availability?.open ? <Link
              className="button"
              to={`/site/${org}/account/register?program=${p.id}`}
            >
              Register
            </Link> : <p>{p.registration_availability?.reason || "Registration is unavailable."}</p>}
          </aside>
        )}
      </div>
    </>
  );
}
type PublicEvent = GameResult & {
  id: string;
  program_id: string;
  title: string;
  type: string;
  start_at: string;
  end_at: string;
  state: string;
  home_score: number | null;
  away_score: number | null;
  home_team: string | null;
  away_team: string | null;
  location: string | null;
};
function PublicSchedule({
  org,
  programId,
  timezone = "America/Chicago",
}: {
  org: string;
  programId?: string;
  timezone?: string;
}) {
  const { data, loading, error } = useData<PublicEvent[]>(
      `/public/sites/${org}/calendar`,
      [],
    ),
    [query, setQuery] = useState("");
  const rows = data.filter(
    (e) =>
      (!programId || e.program_id === programId) &&
      (!query ||
        [e.title, e.home_team, e.away_team, e.location]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const date = (value: string) =>
    new Date(value).toLocaleString("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <section className="public-schedule">
      <h2>Schedule</h2>
      <p>All times {timezone.replaceAll("_", " ")}.</p>
      <ErrorBox error={error} />
      <Field label="Search schedule">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      {rows.length > 0 && <p className="calendar-scroll-hint">
        Scroll the schedule horizontally to see locations, status, and scores.
      </p>}
      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>{query ? "No events match your search." : "No events are scheduled."}</Empty>
      ) : (
        <DataTable
          rows={rows}
          pagination
          columns={[
            {
              key: "start_at",
              label: "Date / Time",
              render: (e) => (
                <>
                  {date(e.start_at)}
                  <small className="cell-sub">{e.end_at ? `Until ${date(e.end_at)}` : "End time TBD"}</small>
                </>
              ),
            },
            {
              key: "title",
              label: "Event",
              render: (e) => (
                <>
                  {e.title}
                  <small className="cell-sub">
                    {e.home_team}
                    {e.away_team && ` vs. ${e.away_team}`}
                  </small>
                </>
              ),
            },
            { key: "location", label: "Location" },
            { key: "state", label: "Status" },
            {
              key: "score",
              label: "Score",
              render: (e) => <EventResult event={e} />,
            },
          ]}
        />
      )}
    </section>
  );
}
function PublicLocations({ org }: { org: string }) {
  const { data, loading, error } = useData<
    { id: string; name: string; address: string }[]
  >(`/public/sites/${org}/locations`, []);
  return (
    <>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : data.length ? (
        data.map((l) => (
          <article className="public-location" key={l.id}>
            <h2>{l.name}</h2>
            <p>{l.address || "Address to be announced"}</p>
            {l.address && (
              <a
                rel="noopener noreferrer"
                target="_blank"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address)}`}
              >
                View map →
              </a>
            )}
          </article>
        ))
      ) : (
        <Empty>No locations are listed.</Empty>
      )}
    </>
  );
}
import { PublicStandings } from "./standings";

function PublicTeamRoster({org,teamId,signedIn}:{org:string;teamId:string;signedIn:boolean}) {
  const {data,loading,error}=useData<{team_name:string;fields:string[];rows:Record<string,string>[];staff_fields:string[];staff_rows:Record<string,string>[]} | null>(`/public/sites/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamId)}/roster`,null);
  if(loading) return <Loading/>;
  if(error || !data) return <><h1>Team roster</h1><p>{signedIn ? "This roster is unavailable for your account. Contact the organization if you need access." : "This roster is unavailable or requires a permitted member account."}</p>{signedIn ? <Link to={`/site/${org}/account/teams`}>Back to My teams</Link> : <Link to={`/site/${org}/account/login?return_team=${encodeURIComponent(teamId)}`}>Sign in</Link>}</>;
  const labels:Record<string,string>={name:"Name",gender:"Gender",birthdate:"Birth Date",email:"Email",phone:"Mobile",address:"Address",member_id:"Member ID",invoice:"Invoiced",balance:"Balance",due_date:"Payment deadline"};
  const rosterTable=(fields:string[],rows:Record<string,string>[]) => <div className="table-scroll"><table><thead><tr>{fields.map(key=><th key={key}>{labels[key]||key}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{fields.map(key=><td key={key}>{row[key]}</td>)}</tr>)}</tbody></table></div>;
  return <><h1>{data.team_name}</h1><h2>Team roster</h2>{!data.rows.length?<Empty>No player roster information is available.</Empty>:rosterTable(data.fields,data.rows)}{!!data.staff_rows?.length && <><h2>Team staff</h2>{rosterTable(data.staff_fields,data.staff_rows)}</>}</>;
}

import { useState } from "react";
import { useTerminology } from "./terminology";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Copy, Pencil, Trash2, Package, Plus } from "lucide-react";
import { api, csv, money, shortDate } from "./api";
import {
  Button,
  Check,
  DataTable,
  DateInput,
  Empty,
  ErrorBox,
  ExportButton,
  Field,
  Loading,
  Modal,
  PageTitle,
  Select,
  Tabs,
  useData,
} from "./components";
import { RichText, HtmlContent } from "./rich-text";
import { ProgramNav } from "./programs";
import type { Person, Program } from "./types";

type Variant = {
  id?: string;
  name: string;
  sku: string;
  price_cents: number;
  inventory: number | null;
};
type Product = {
  id: string;
  name: string;
  sku: string;
  description: string;
  receipt_message: string;
  image_id: string | null;
  price_cents: number;
  inventory: number | null;
  published: boolean;
  availability: "Private" | "Registration" | "Store";
  shipping: "None" | "Optional" | "Required";
  shipping_cents: number;
  taxable: boolean;
  expire_unpaid: boolean;
  notify_purchase: boolean;
  required_at_registration: boolean;
  program_ids: string[];
  variants: Variant[];
  version: number;
  created_at: string;
  last_order_at: string | null;
  updated_at?: string;
};
type Category = {
  id: string;
  name: string;
  description: string;
  position: number;
  product_ids: string[];
};
type Order = {
  id: string;
  number: number;
  product_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  person_id: string;
  person_name: string;
  purchaser_id: string;
  purchaser_name: string;
  purchaser_email: string;
  program_id: string | null;
  program_name: string;
  invoice_id: string;
  invoice_number: number;
  quantity: number;
  unit_price_cents: number;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  display_status: string;
  status: string;
  shipping_required: boolean;
  shipping_address: Record<string, string> | null;
  shipped_at: string | null;
  tracking?: string;
  created_at: string;
  expires_at: string | null;
  receipt_message: string;
};
const newProduct: Product = {
  id: "",
  name: "",
  sku: "",
  description: "",
  receipt_message: "",
  image_id: null,
  price_cents: 0,
  inventory: null,
  published: true,
  availability: "Private",
  shipping: "None",
  shipping_cents: 0,
  taxable: false,
  expire_unpaid: true,
  notify_purchase: false,
  required_at_registration: false,
  program_ids: [],
  variants: [],
  version: 1,
  created_at: "",
  last_order_at: null,
};
function ProductImage({ id, name }: { id: string | null; name: string }) {
  return id ? (
    <img className="product-image" src={"/api/assets/" + id} alt={name} />
  ) : (
    <span className="product-image product-placeholder">
      <Package size={25} />
      <small>No image</small>
    </span>
  );
}
function CommerceTabs({ store = false }: { store?: boolean }) {
  const navigate = useNavigate();
  return (
    <Tabs
      items={["Products", "Store"]}
      value={store ? "Store" : "Products"}
      onChange={(v) =>
        navigate(v === "Store" ? "/products/store" : "/products")
      }
    />
  );
}
export function Products() {
  const terminology = useTerminology();
  const { id: programId } = useParams(),
    products = useData<Product[]>("/products", []),
    programs = useData<Program[]>("/programs", []),
    navigate = useNavigate();
  const [filters, setFilters] = useState({
      name: "",
      sort: "added",
      descending: true,
      published: "Any",
      availability: "Any",
      program: programId || "",
      sport: "",
      season: "",
      state: "",
    }),
    [query, setQuery] = useState(filters),
    [filterVersion, setFilterVersion] = useState(0),
    [removing, setRemoving] = useState<Product | null>(null),
    [error, setError] = useState("");
  const matches = products.data.filter((p) => {
    const associated = programs.data.filter(
      (x) =>
        p.program_ids.includes(x.id) ||
        p.program_ids.includes(x.parent_id || ""),
    );
    return (
      p.name.toLowerCase().includes(query.name.toLowerCase()) &&
      (query.published === "Any" ||
        p.published === (query.published === "Published")) &&
      (query.availability === "Any" || p.availability === query.availability) &&
      (!(programId || query.program) ||
        p.program_ids.includes(programId || query.program) ||
        associated.some((x) => x.id === (programId || query.program))) &&
      (!query.sport || associated.some((x) => x.sport === query.sport)) &&
      (!query.season || associated.some((x) => x.season === query.season)) &&
      (!query.state || associated.some((x) => x.status === query.state))
    );
  }).sort((a,b)=>{
    const inventory=(p:Product)=>p.variants.length ? p.variants.some(v=>v.inventory===null) ? Infinity : p.variants.reduce((sum,v)=>sum+(v.inventory||0),0) : p.inventory ?? Infinity;
    const compareNumbers=(a:number,b:number)=>a===b?0:a<b?-1:1;
    const order=query.sort==="name"?a.name.localeCompare(b.name):query.sort==="price"?a.price_cents-b.price_cents:query.sort==="inventory"?compareNumbers(inventory(a),inventory(b)):query.sort==="ordered"?(a.last_order_at||"").localeCompare(b.last_order_at||""):query.sort==="updated"?(a.updated_at||a.created_at).localeCompare(b.updated_at||b.created_at):a.created_at.localeCompare(b.created_at);
    return order*(query.descending?-1:1)||a.name.localeCompare(b.name);
  });
  const program = programs.data.find((p) => p.id === programId);
  return (
    <>
      <PageTitle
        title={
          program
            ? program.name + " · Assigned Products"
            : "E-Commerce Products"
        }
      />
      {programId ? (
        <ProgramNav id={programId} active="Products" />
      ) : (
        <CommerceTabs />
      )}
      <main className="content-page">
        <ErrorBox error={products.error || error} />
        <form
          className="commerce-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(filters);
            setFilterVersion(v => v + 1);
          }}
        >
          <Field label="Product name">
            <input
              value={filters.name}
              onChange={(e) => setFilters({ ...filters, name: e.target.value })}
            />
          </Field>
          <Field label="Published">
            <Select
              options={["Any", "Published", "Unpublished"]}
              value={filters.published}
              onChange={(e) =>
                setFilters({ ...filters, published: e.target.value })
              }
            />
          </Field>
          <Field label="Availability">
            <Select
              options={["Any", "Private", "Registration", "Store"]}
              value={filters.availability}
              onChange={(e) =>
                setFilters({ ...filters, availability: e.target.value })
              }
            />
          </Field>
          {(["sport", "season", "state"] as const).map((k) => (
            <Field
              label={
                k === "state"
                  ? "Program state"
                  : k === "sport"
                    ? "Sport"
                    : terminology.data?.fields.find((f) => f.key === "season")?.label || "Season"
              }
              key={k}
            >
              <Select
                options={[
                  { value: "", label: "Any" },
                  ...new Set(
                    programs.data.map((p) => (k === "state" ? p.status : p[k])).filter(value => value.trim().length > 0),
                  ),
                ]}
                value={filters[k]}
                onChange={(e) =>
                  setFilters({ ...filters, [k]: e.target.value })
                }
              />
            </Field>
          ))}
          {!programId && <Field label="Program">
            <Select
              options={[
                { value: "", label: "All programs" },
                ...programs.data.map((p) => ({ value: p.id, label: p.name })),
              ]}
              value={filters.program}
              onChange={(e) =>
                setFilters({ ...filters, program: e.target.value })
              }
            />
          </Field>}
          <Field label="Sort by"><Select aria-label="Sort products by" value={filters.sort} onChange={e=>setFilters({...filters,sort:e.target.value})} options={[{value:"name",label:"Name"},{value:"price",label:"Price"},{value:"inventory",label:"Available Inventory"},{value:"ordered",label:"Last Order Date"},{value:"added",label:"Date Added"},{value:"updated",label:"Date Updated"}]}/></Field>
          <Check checked={filters.descending} onChange={e=>setFilters({...filters,descending:e.target.checked})}>In descending order</Check>
          <Button>Apply</Button>
        </form>
        <div className="split-toolbar">
          <span>{matches.length} products</span>
          <Link
            className="button"
            to={"/products/new" + (programId ? "?program=" + programId : "")}
          >
            Create a Product
          </Link>
        </div>
        {products.loading ? (
          <Loading />
        ) : !products.error && (
          <DataTable
            key={`${programId || "all"}:${filterVersion}`}
            pagination
            rows={matches}
            columns={[
              {
                key: "name",
                label: "Product",
                sort: (p) => p.name,
                render: (p) => (
                  <div className="product-title-cell">
                    <ProductImage id={p.image_id} name={p.name} />
                    <div>
                      <Link to={"/products/" + p.id + "/edit"}>
                        <strong>{p.name}</strong>
                      </Link>
                      <small>
                        {p.sku || "No SKU"} · Shipping: {p.shipping}
                      </small>
                    </div>
                  </div>
                ),
              },
              {
                key: "price",
                label: "Price",
                render: (p) => money(p.price_cents),
              },
              {
                key: "inventory",
                label: "Inventory",
                render: (p) =>
                  p.variants.length ? "By configuration" : (p.inventory ?? "∞"),
              },
              {
                key: "variants",
                label: "Configurations",
                render: (p) => p.variants.length || "—",
              },
              {
                key: "flags",
                label: "Availability",
                render: (p) => (
                  <>
                    <strong>{p.published ? "Published" : "Unpublished"}</strong>
                    <small>
                      {p.availability === "Store"
                        ? "Public storefront"
                        : p.availability === "Registration"
                          ? "Associated registrations"
                          : "Private link + programs"}
                    </small>
                    <small>{p.taxable ? "Sales tax applies" : ""}</small>
                  </>
                ),
              },
              {
                key: "last",
                label: "Last order",
                render: (p) => (
                  <>
                    {shortDate(p.last_order_at || "")}
                    <small>
                      <Link to={"/orders?product=" + p.id}>View orders</Link>
                    </small>
                  </>
                ),
              },
              {
                key: "actions",
                label: "Actions",
                render: (p) => (
                  <div className="row-actions">
                    <Link
                      className="square-action"
                      aria-label={"Edit " + p.name}
                      to={"/products/" + p.id + "/edit"}
                    >
                      <Pencil size={14} />
                    </Link>
                    <button
                      className="square-action"
                      aria-label={"Copy " + p.name}
                      onClick={async () => {
                        try {
                          const result = await api<Product>(
                            "/products/" + p.id + "/copy",
                            { method: "POST" },
                          );
                          navigate("/products/" + result.id + "/edit");
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      className="square-action"
                      aria-label={"Archive " + p.name}
                      onClick={() => setRemoving(p)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </main>
      {removing && (
        <Modal title="Archive Product" onClose={() => setRemoving(null)}>
          <div className="modal-body">
            <p>
              Archive {removing.name}? Existing orders and invoices stay
              available.
            </p>
            <ErrorBox error={error} />
            <div className="form-actions">
              <Button secondary onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await api("/products/" + removing.id, { method: "DELETE" });
                    setRemoving(null);
                    products.reload();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Archive Product
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
export function ProductEditor() {
  const { id } = useParams(),
    [search] = useSearchParams();
  return (
    <>
      <PageTitle
        title={id ? "Edit Product" : "Create a New Product"}
        crumbs={[{ label: "E-Commerce Products", to: "/products" }]}
      />
      {id ? (
        <LoadedProductForm id={id} />
      ) : (
        <ProductForm
          key="new"
          initial={{
            ...newProduct,
            program_ids: search.get("program") ? [search.get("program")!] : [],
          }}
        />
      )}
    </>
  );
}
function LoadedProductForm({ id }: { id: string }) {
  const data = useData<Product | null>("/products/" + id, null);
  return data.loading ? (
    <Loading />
  ) : data.data ? (
    <ProductForm key={id} initial={data.data} />
  ) : (
    <ErrorBox error={data.error} />
  );
}
function PriceInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <div className="currency-input">
        <span>$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          max="1000000"
          required
          value={value / 100}
          onChange={(e) => onChange(Math.round(Number(e.target.value) * 100))}
        />
      </div>
    </Field>
  );
}
function InventoryInput({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <Field
      label="Available inventory"
      hint="Leave blank for unlimited inventory"
    >
      <input
        type="number"
        min="0"
        step="1"
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    </Field>
  );
}
function ProductForm({ initial }: { initial: Product }) {
  const [p, setP] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [associate, setAssociate] = useState(false),
    navigate = useNavigate(),
    programs = useData<Program[]>("/programs", []),
    settings = useData<{ tax_rate_bps: number }>("/commerce/settings", {
      tax_rate_bps: 0,
    });
  const set = <K extends keyof Product>(key: K, value: Product[K]) =>
    setP((old) => ({ ...old, [key]: value }));
  const upload = async (file?: File) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("Choose an image smaller than 5 MB");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": file.type, "X-Fieldhouse-Request": "1" },
        body: file,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      set("image_id", value.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="form-layout commerce-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api("/products" + (p.id ? "/" + p.id : ""), {
            method: p.id ? "PUT" : "POST",
            body: JSON.stringify(p),
          });
          navigate("/products");
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <ErrorBox error={error} />
        <Field label="Name" required>
          <input
            required
            maxLength={150}
            value={p.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label="SKU">
          <input
            maxLength={80}
            value={p.sku}
            onChange={(e) => set("sku", e.target.value)}
          />
        </Field>
        <RichText
          label="Product description"
          value={p.description}
          onChange={(v) => set("description", v)}
          maxLength={20000}
        />
        <RichText
          label="Purchase receipt message"
          value={p.receipt_message}
          onChange={(v) => set("receipt_message", v)}
          maxLength={10000}
        />
        <section className="form-section">
          <h2>Pricing and Inventory</h2>
          <div className="form-grid">
            <PriceInput
              label="Price"
              value={p.price_cents}
              onChange={(v) => set("price_cents", v)}
            />
            {!p.variants.length && (
              <InventoryInput
                value={p.inventory}
                onChange={(v) => set("inventory", v)}
              />
            )}
          </div>
          <Field label="Shipping">
            <Select
              options={["None", "Optional", "Required"]}
              value={p.shipping}
              onChange={(e) =>
                set("shipping", e.target.value as Product["shipping"])
              }
            />
          </Field>
          {p.shipping !== "None" && (
            <PriceInput
              label="Flat shipping charge per order"
              value={p.shipping_cents}
              onChange={(v) => set("shipping_cents", v)}
            />
          )}
          <Check
            checked={p.taxable}
            onChange={(e) => set("taxable", e.target.checked)}
          >
            Apply the site sales tax rate ({settings.data.tax_rate_bps / 100}%){" "}
            <Link to="/products/store">Store settings</Link>
          </Check>
          <Check
            checked={p.expire_unpaid}
            onChange={(e) => set("expire_unpaid", e.target.checked)}
          >
            Cancel unpaid orders after 30 minutes and release reserved inventory
          </Check>
        </section>
        <section className="form-section">
          <div className="split-toolbar">
            <h2>Configurations</h2>
            <Button
              type="button"
              secondary
              onClick={() =>
                set("variants", [
                  ...p.variants,
                  {
                    name: "",
                    sku: "",
                    price_cents: p.price_cents,
                    inventory: null,
                  },
                ])
              }
            >
              <Plus size={13} />
              Add configuration
            </Button>
          </div>
          <p>
            Offer sizes or other options with their own price and available
            inventory.
          </p>
          {p.variants.map((v, i) => (
            <div className="configuration-row" key={v.id || i}>
              <Field label="Configuration name">
                <input
                  required
                  maxLength={100}
                  value={v.name}
                  onChange={(e) =>
                    set(
                      "variants",
                      p.variants.map((x, j) =>
                        i === j ? { ...x, name: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Configuration SKU">
                <input
                  value={v.sku}
                  maxLength={80}
                  onChange={(e) =>
                    set(
                      "variants",
                      p.variants.map((x, j) =>
                        i === j ? { ...x, sku: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <PriceInput
                label="Configuration price"
                value={v.price_cents}
                onChange={(value) =>
                  set(
                    "variants",
                    p.variants.map((x, j) =>
                      i === j ? { ...x, price_cents: value } : x,
                    ),
                  )
                }
              />
              <InventoryInput
                value={v.inventory}
                onChange={(value) =>
                  set(
                    "variants",
                    p.variants.map((x, j) =>
                      i === j ? { ...x, inventory: value } : x,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="square-action"
                aria-label={"Remove configuration " + (v.name || i + 1)}
                onClick={() =>
                  set(
                    "variants",
                    p.variants.filter((_, j) => i !== j),
                  )
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </section>
        <section className="form-section">
          <h2>Product Availability</h2>
          {p.id && (
            <p>
              <Link to={"/store/products/" + p.id}>
                View product and create an order
              </Link>
            </p>
          )}
          {(
            [
              {
                value: "Private",
                title: "Private link and associated programs",
                text: "Available from a direct product link and selected registrations.",
              },
              {
                value: "Registration",
                title: "Only associated registrations",
                text: "Purchase this product while registering in an associated program.",
              },
              {
                value: "Store",
                title: "Public storefront and associated programs",
                text: "Include this product in the storefront.",
              },
            ] as const
          ).map((option) => (
            <label
              className={
                "availability-choice " +
                (p.availability === option.value ? "selected" : "")
              }
              key={option.value}
            >
              <input
                type="radio"
                name="availability"
                value={option.value}
                checked={p.availability === option.value}
                onChange={() => set("availability", option.value)}
              />
              <span>
                <strong>{option.title}</strong>
                <small>{option.text}</small>
              </span>
            </label>
          ))}
          <p>{p.program_ids.length} associated programs</p>
          <Button type="button" secondary onClick={() => setAssociate(true)}>
            Manage Associated Programs
          </Button>
        </section>
        <div className="form-actions">
          <Link to="/products">Cancel</Link>
          <div>
            <Check
              checked={p.published}
              onChange={(e) => set("published", e.target.checked)}
            >
              Publish this product
            </Check>
            <Button disabled={busy}>
              {busy
                ? "Saving…"
                : p.published
                  ? "Save & Publish Product"
                  : "Save Product"}
            </Button>
          </div>
        </div>
      </div>
      <aside className="product-image-rail">
        <h3>Product Image</h3>
        <ProductImage id={p.image_id} name={p.name} />
        <Field
          label="Upload product image"
          hint="PNG, JPEG or WebP. Maximum 5 MB. A square image works best."
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </Field>
        {p.image_id && (
          <Button secondary type="button" onClick={() => set("image_id", null)}>
            Remove image
          </Button>
        )}
        <p>
          Inventory is the quantity currently available, after open orders are
          reserved.
        </p>
      </aside>
      {associate && (
        <Modal
          title="Associated Programs"
          wide
          onClose={() => setAssociate(false)}
        >
          <div className="modal-body">
            <div className="program-checklist">
              {programs.data.map((program) => (
                <Check
                  key={program.id}
                  checked={p.program_ids.includes(program.id)}
                  onChange={(e) =>
                    set(
                      "program_ids",
                      e.target.checked
                        ? [...p.program_ids, program.id]
                        : p.program_ids.filter((id) => id !== program.id),
                    )
                  }
                >
                  {program.name}
                  <small>
                    {program.type} · {program.season} · {program.status}
                  </small>
                </Check>
              ))}
            </div>
            <Button type="button" onClick={() => setAssociate(false)}>
              Done
            </Button>
          </div>
        </Modal>
      )}
    </form>
  );
}
export function StoreManager() {
  const categories = useData<Category[]>("/store/categories", []),
    products = useData<Product[]>("/products", []),
    settings = useData<{ tax_rate_bps: number }>("/commerce/settings", {
      tax_rate_bps: 0,
    });
  const [editing, setEditing] = useState<Category | null>(null),
    [error, setError] = useState(""),
    [tax, setTax] = useState<string | null>(null),
    [saved, setSaved] = useState(false);
  return (
    <>
      <PageTitle title="E-Commerce Products" />
      <CommerceTabs store />
      <main className="content-page">
        <ErrorBox error={error || categories.error} />
        <div className="split-toolbar">
          <Link className="button secondary" to="/store">
            Preview Storefront
          </Link>
          <Button
            onClick={() =>
              setEditing({
                id: "",
                name: "",
                description: "",
                position: categories.data.length,
                product_ids: [],
              })
            }
          >
            Add Category
          </Button>
        </div>
        {categories.loading ? (
          <Loading />
        ) : categories.data.length ? (
          <DataTable
            rows={categories.data}
            columns={[
              {
                key: "name",
                label: "Category",
                render: (c) => (
                  <>
                    <strong>{c.name}</strong>
                    <small>{c.description}</small>
                  </>
                ),
              },
              {
                key: "products",
                label: "Products",
                render: (c) => c.product_ids.length,
              },
              {
                key: "actions",
                label: "Actions",
                render: (c) => (
                  <div className="row-actions">
                    <Button secondary onClick={() => setEditing(c)}>
                      Edit category
                    </Button>
                    <Button
                      secondary
                      onClick={async () => {
                        try {
                          await api("/store/categories/" + c.id, {
                            method: "DELETE",
                          });
                          categories.reload();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Remove category
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        ) : (
          <Empty>No categories have been added.</Empty>
        )}
        <section className="form-section">
          <h2>Store Settings</h2>
          <form
            className="inline"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/commerce/settings", {
                  method: "PUT",
                  body: JSON.stringify({
                    tax_rate_bps: Math.round(
                      Number(tax ?? settings.data.tax_rate_bps / 100) * 100,
                    ),
                  }),
                });
                settings.reload();
                setSaved(true);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Field label="Sales tax rate (%)">
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={tax ?? settings.data.tax_rate_bps / 100}
                onChange={(e) => {
                  setTax(e.target.value);
                  setSaved(false);
                }}
              />
            </Field>
            <Button>Save tax rate</Button>
            {saved && <span role="status">Saved</span>}
          </form>
        </section>
      </main>
      {editing && (
        <CategoryEditor
          initial={editing}
          products={products.data}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            categories.reload();
          }}
        />
      )}
    </>
  );
}
function CategoryEditor({
  initial,
  products,
  close,
  saved,
}: {
  initial: Category;
  products: Product[];
  close: () => void;
  saved: () => void;
}) {
  const [c, setC] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={c.id ? "Edit Category" : "Add Category"} onClose={close}>
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/store/categories" + (c.id ? "/" + c.id : ""), {
              method: c.id ? "PUT" : "POST",
              body: JSON.stringify(c),
            });
            saved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        <Field label="Category name" required>
          <input
            required
            maxLength={100}
            value={c.name}
            onChange={(e) => setC({ ...c, name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <textarea
            maxLength={1000}
            value={c.description}
            onChange={(e) => setC({ ...c, description: e.target.value })}
          />
        </Field>
        <Field label="Display order">
          <input
            type="number"
            min="0"
            value={c.position}
            onChange={(e) => setC({ ...c, position: Number(e.target.value) })}
          />
        </Field>
        <h3>Products</h3>
        <div className="program-checklist">
          {products.map((p) => (
            <Check
              key={p.id}
              checked={c.product_ids.includes(p.id)}
              onChange={(e) =>
                setC({
                  ...c,
                  product_ids: e.target.checked
                    ? [...c.product_ids, p.id]
                    : c.product_ids.filter((id) => id !== p.id),
                })
              }
            >
              {p.name}
              <small>
                {p.published ? "Published" : "Unpublished"} · {p.availability}
              </small>
            </Check>
          ))}
        </div>
        <div className="form-actions">
          <Button type="button" secondary onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>Save Category</Button>
        </div>
      </form>
    </Modal>
  );
}
export function StorePreview() {
  const products = useData<Product[]>("/products", []),
    categories = useData<Category[]>("/store/categories", []),
    [category, setCategory] = useState("");
  const visible = products.data.filter(
    (p) =>
      p.published &&
      p.availability === "Store" &&
      (!category ||
        categories.data
          .find((c) => c.id === category)
          ?.product_ids.includes(p.id)),
  );
  return (
    <>
      <PageTitle title="Northstar Store" />
      <main className="content-page">
        <div className="split-toolbar">
          <p>Storefront preview</p>
          <Link to="/products/store">Manage Store</Link>
        </div>
        <div className="inline">
          <Button secondary={!category} onClick={() => setCategory("")}>
            All products
          </Button>
          {categories.data.map((c) => (
            <Button
              key={c.id}
              secondary={category !== c.id}
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </Button>
          ))}
        </div>
        <ErrorBox error={products.error} />
        {products.loading ? (
          <Loading />
        ) : (
          <div className="store-grid">
            {visible.map((p) => (
              <Link
                className="store-product"
                key={p.id}
                to={"/store/products/" + p.id}
              >
                <ProductImage id={p.image_id} name={p.name} />
                <h2>{p.name}</h2>
                <p>
                  {p.variants.length ? "From " : ""}
                  {money(
                    p.variants.length
                      ? Math.min(...p.variants.map((v) => v.price_cents))
                      : p.price_cents,
                  )}
                </p>
                <span className="button">View Product</span>
              </Link>
            ))}
          </div>
        )}
        {!products.loading && !visible.length && (
          <Empty>No published products in this category.</Empty>
        )}
      </main>
    </>
  );
}
export function ProductPurchase() {
  const { id } = useParams(),
    data = useData<Product | null>("/products/" + id, null);
  return data.loading ? (
    <Loading />
  ) : data.data ? (
    <PurchaseForm p={data.data} />
  ) : (
    <ErrorBox error={data.error} />
  );
}
function PurchaseForm({ p }: { p: Product }) {
  const people = useData<Person[]>("/people", []),
    programs = useData<Program[]>("/programs", []),
    settings = useData<{ tax_rate_bps: number }>("/commerce/settings", {
      tax_rate_bps: 0,
    }),
    navigate = useNavigate();
  const [form, setForm] = useState({
      product_id: p.id,
      variant_id: p.variants[0]?.id || null,
      person_id: "",
      purchaser_id: "",
      program_id: "",
      quantity: 1,
      shipping_requested: p.shipping === "Required",
      shipping_address: {
        name: "",
        address: "",
        city: "",
        state: "",
        postal_code: "",
        country: "US",
      },
      idempotency_key: crypto.randomUUID(),
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const chosen = p.variants.find((v) => v.id === form.variant_id) || p,
    shipping =
      p.shipping === "Required" ||
      (p.shipping === "Optional" && form.shipping_requested),
    subtotal = chosen.price_cents * form.quantity,
    tax = p.taxable
      ? Math.round((subtotal * settings.data.tax_rate_bps) / 10000)
      : 0,
    total = subtotal + tax + (shipping ? p.shipping_cents : 0),
    available = chosen.inventory === null || chosen.inventory >= form.quantity;
  return (
    <>
      <PageTitle title={p.name} crumbs={[{ label: "Store", to: "/store" }]} />
      <main className="content-page">
        <div className="purchase-layout">
          <section>
            <ProductImage id={p.image_id} name={p.name} />
            <HtmlContent html={p.description} />
            <p>SKU: {chosen.sku || "—"}</p>
          </section>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const o = await api<Order>("/orders", {
                  method: "POST",
                  body: JSON.stringify({
                    ...form,
                    quoted_total_cents: total,
                    purchaser_id: form.purchaser_id || form.person_id,
                    program_id: form.program_id || null,
                  }),
                });
                navigate("/orders/" + o.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>Create an Order</h2>
            <ErrorBox error={error || people.error} />
            {p.variants.length > 0 && (
              <Field label="Configuration">
                <Select
                  value={form.variant_id || ""}
                  options={p.variants.map((v) => ({
                    value: v.id!,
                    label: v.name + " · " + money(v.price_cents),
                  }))}
                  onChange={(e) =>
                    setForm({ ...form, variant_id: e.target.value })
                  }
                />
              </Field>
            )}
            <p>
              {money(chosen.price_cents)} each ·{" "}
              {chosen.inventory === null
                ? "Unlimited inventory"
                : chosen.inventory + " available"}
            </p>
            <Field label="Quantity" required>
              <input
                type="number"
                min="1"
                max="1000"
                required
                value={form.quantity}
                onChange={(e) =>
                  setForm({ ...form, quantity: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="For member" required>
              <Select
                required
                value={form.person_id}
                options={[
                  { value: "", label: "Select member" },
                  ...people.data
                    .filter((x) => !x.archived_at)
                    .map((x) => ({
                      value: x.id,
                      label: x.first_name + " " + x.last_name,
                    })),
                ]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    person_id: e.target.value,
                    purchaser_id: "",
                  })
                }
              />
            </Field>
            <Field
              label="Purchaser"
              hint="The member or a supervisor from the same family"
            >
              <Select
                value={form.purchaser_id}
                options={[
                  { value: "", label: "Same as member" },
                  ...people.data
                    .filter(
                      (x) =>
                        !x.archived_at &&
                        x.household_id &&
                        x.household_id ===
                          people.data.find((m) => m.id === form.person_id)
                            ?.household_id &&
                        x.household_role === "Supervisor",
                    )
                    .map((x) => ({
                      value: x.id,
                      label: x.first_name + " " + x.last_name,
                    })),
                ]}
                onChange={(e) =>
                  setForm({ ...form, purchaser_id: e.target.value })
                }
              />
            </Field>
            <Field
              label="Program context"
              required={p.availability === "Registration"}
            >
              <Select
                required={p.availability === "Registration"}
                value={form.program_id}
                options={[
                  { value: "", label: "Standalone purchase" },
                  ...programs.data
                    .filter(
                      (x) =>
                        !x.grouped &&
                        (p.program_ids.includes(x.id) ||
                          p.program_ids.includes(x.parent_id || "")),
                    )
                    .map((x) => ({ value: x.id, label: x.name })),
                ]}
                onChange={(e) =>
                  setForm({ ...form, program_id: e.target.value })
                }
              />
            </Field>
            {p.shipping === "Optional" && (
              <Check
                checked={form.shipping_requested}
                onChange={(e) =>
                  setForm({ ...form, shipping_requested: e.target.checked })
                }
              >
                Ship this order
              </Check>
            )}
            {shipping && (
              <section className="form-section">
                <h3>Shipping Address</h3>
                {(
                  [
                    "name",
                    "address",
                    "city",
                    "state",
                    "postal_code",
                    "country",
                  ] as const
                ).map((k) => (
                  <Field
                    label={
                      k === "postal_code"
                        ? "Postal code"
                        : k[0].toUpperCase() + k.slice(1)
                    }
                    key={k}
                    required
                  >
                    <input
                      required
                      value={form.shipping_address[k]}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          shipping_address: {
                            ...form.shipping_address,
                            [k]: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                ))}
              </section>
            )}
            <dl className="order-totals">
              <dt>Subtotal</dt>
              <dd>{money(subtotal)}</dd>
              <dt>Shipping</dt>
              <dd>{money(shipping ? p.shipping_cents : 0)}</dd>
              <dt>Tax</dt>
              <dd>{money(tax)}</dd>
              <dt>Total</dt>
              <dd>
                <strong>{money(total)}</strong>
              </dd>
            </dl>
            {p.expire_unpaid && (
              <p>
                Unpaid orders expire after 30 minutes. Recording a partial
                payment keeps the order open.
              </p>
            )}
            <Button disabled={busy || !available || !p.published}>
              {busy
                ? "Creating…"
                : !p.published
                  ? "Product unpublished"
                  : !available
                    ? "Not enough inventory"
                    : "Create Order & Invoice"}
            </Button>
          </form>
        </div>
      </main>
    </>
  );
}
export function Orders() {
  const data = useData<Order[]>("/orders", []),
    products = useData<Product[]>("/products", []),
    [search] = useSearchParams(),
    [filters, setFilters] = useState({
      product: search.get("product") || "",
      status: "",
      name: "",
      shipping: "",
      from: "",
      to: "",
    }),
    [query, setQuery] = useState(filters),
    [show, setShow] = useState(false);
  const rows = data.data.filter(
    (o) =>
      (!query.product || o.product_id === query.product) &&
      (!query.status || o.display_status === query.status) &&
      (!query.name ||
        (o.purchaser_name + " " + o.person_name)
          .toLowerCase()
          .includes(query.name.toLowerCase())) &&
      (!query.shipping || o.shipping_required === (query.shipping === "Yes")) &&
      (!query.from || o.created_at.slice(0, 10) >= query.from) &&
      (!query.to || o.created_at.slice(0, 10) <= query.to),
  );
  return (
    <>
      <PageTitle title="Reports › Product Order History" />
      <main className="content-page order-history">
        <ErrorBox error={data.error} />
        <div className="split-toolbar">
          <Button secondary onClick={() => setShow(!show)}>
            {show ? "Hide filters" : "Show filters"}
          </Button>
          <ExportButton
            onClick={() =>
              csv(
                "product-orders",
                [
                  "Order",
                  "Product",
                  "Configuration",
                  "Quantity",
                  "Unit price",
                  "Tax",
                  "Shipping",
                  "Total",
                  "Paid",
                  "Purchaser",
                  "Member",
                  "Program",
                  "Status",
                  "Shipped",
                  "Date",
                ],
                rows.map((o) => [
                  o.number,
                  o.product_name,
                  o.variant_name,
                  o.quantity,
                  o.unit_price_cents / 100,
                  o.tax_cents / 100,
                  o.shipping_cents / 100,
                  o.total_cents / 100,
                  o.paid_cents / 100,
                  o.purchaser_name,
                  o.person_name,
                  o.program_name,
                  o.display_status,
                  o.shipped_at,
                  o.created_at,
                ]),
              )
            }
          />
        </div>
        {show && (
          <form
            className="commerce-filters"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(filters);
            }}
          >
            <Field label="From date">
              <DateInput
                value={filters.from}
                onChange={(e) =>
                  setFilters({ ...filters, from: e.target.value })
                }
              />
            </Field>
            <Field label="To date">
              <DateInput
                value={filters.to}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </Field>
            <Field label="Product">
              <Select
                options={[
                  { value: "", label: "Any product" },
                  ...products.data.map((p) => ({ value: p.id, label: p.name })),
                ]}
                value={filters.product}
                onChange={(e) =>
                  setFilters({ ...filters, product: e.target.value })
                }
              />
            </Field>
            <Field label="Status">
              <Select
                options={["", "Open/New", "Open/Paid", "Closed", "Canceled"]}
                value={filters.status}
                onChange={(e) =>
                  setFilters({ ...filters, status: e.target.value })
                }
              />
            </Field>
            <Field label="Requires shipping">
              <Select
                options={["", "Yes", "No"]}
                value={filters.shipping}
                onChange={(e) =>
                  setFilters({ ...filters, shipping: e.target.value })
                }
              />
            </Field>
            <Field label="Purchaser or member name">
              <input
                value={filters.name}
                onChange={(e) =>
                  setFilters({ ...filters, name: e.target.value })
                }
              />
            </Field>
            <Button>Run Report</Button>
          </form>
        )}
        <p>{rows.length} records matching selected filters</p>
        {data.loading ? (
          <Loading />
        ) : (
          <DataTable
            pagination
            rows={rows}
            columns={[
              {
                key: "product",
                label: "Product",
                className: "order-product",
                render: (o) => (
                  <>
                    <Link to={"/products/" + o.product_id + "/edit"}>
                      <strong>{o.product_name}</strong>
                    </Link>
                    <small>
                      Order #{o.number} · {o.quantity} item
                      {o.quantity === 1 ? "" : "s"} {o.variant_name}
                    </small>
                    <Link to={"/orders/" + o.id}>Details</Link>
                  </>
                ),
              },
              {
                key: "total",
                label: "Total",
                className: "order-total",
                render: (o) => (
                  <>
                    {money(o.total_cents)}
                    <small>
                      {money(o.unit_price_cents)} × {o.quantity}
                    </small>
                  </>
                ),
              },
              {
                key: "purchaser",
                label: "Purchaser / Context",
                className: "order-purchaser",
                render: (o) => (
                  <>
                    <Link to={"/members/" + o.purchaser_id}>
                      {o.purchaser_name}
                    </Link>
                    <small>For {o.person_name}</small>
                    {o.program_id && (
                      <Link to={"/programs/" + o.program_id}>
                        {o.program_name}
                      </Link>
                    )}
                  </>
                ),
              },
              {
                key: "shipped",
                label: "Shipped",
                render: (o) =>
                  o.shipping_required
                    ? o.shipped_at
                      ? shortDate(o.shipped_at)
                      : "Not shipped"
                    : "—",
              },
              {
                key: "status",
                label: "Status",
                render: (o) => (
                  <>
                    {o.display_status}
                    <small>
                      <Link to={"/invoices/" + o.invoice_id}>
                        Invoice #{o.invoice_number}
                      </Link>
                    </small>
                  </>
                ),
              },
              {
                key: "created",
                label: "Date",
                sort: (o) => o.created_at,
                render: (o) => shortDate(o.created_at),
              },
            ]}
          />
        )}
      </main>
    </>
  );
}
export function OrderDetail() {
  const { id } = useParams(),
    data = useData<Order | null>("/orders/" + id, null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tracking, setTracking] = useState(""),
    [confirm, setConfirm] = useState("");
  const o = data.data;
  const action = async (name: string) => {
    setBusy(true);
    try {
      await api("/orders/" + id + "/actions", {
        method: "POST",
        body: JSON.stringify({ action: name, tracking }),
      });
      setConfirm("");
      data.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (data.loading) return <Loading />;
  if (!o) return <ErrorBox error={data.error} />;
  return (
    <>
      <PageTitle
        title={"Order #" + o.number}
        crumbs={[{ label: "Product Order History", to: "/orders" }]}
      />
      <main className="content-page">
        <ErrorBox error={error} />
        <div className="split-toolbar">
          <h2>{o.product_name}</h2>
          <strong>{o.display_status}</strong>
        </div>
        <div className="purchase-layout">
          <section>
            <p>
              {o.variant_name} {o.sku && "· SKU " + o.sku}
            </p>
            <p>
              Purchased by{" "}
              <Link to={"/members/" + o.purchaser_id}>{o.purchaser_name}</Link>{" "}
              for <Link to={"/members/" + o.person_id}>{o.person_name}</Link>
            </p>
            <p>{o.purchaser_email}</p>
            {o.program_id && (
              <p>
                Program:{" "}
                <Link to={"/programs/" + o.program_id}>{o.program_name}</Link>
              </p>
            )}
            <p>Ordered {shortDate(o.created_at)}</p>
            {o.shipping_required && (
              <section className="form-section">
                <h3>Shipping</h3>
                <address>
                  {Object.entries(o.shipping_address || {}).map(
                    ([key, value]) => (
                      <div key={key}>{value}</div>
                    ),
                  )}
                </address>
                <p>
                  {o.shipped_at
                    ? "Shipped " + shortDate(o.shipped_at)
                    : "Not shipped"}
                  {o.tracking && " · " + o.tracking}
                </p>
                {!o.shipped_at &&
                  o.status === "Open" &&
                  o.balance_cents === 0 && (
                    <>
                      <Field label="Tracking reference">
                        <input
                          value={tracking}
                          onChange={(e) => setTracking(e.target.value)}
                          maxLength={200}
                        />
                      </Field>
                      <Button
                        disabled={busy}
                        onClick={() => void action("ship")}
                      >
                        Mark Shipped
                      </Button>
                    </>
                  )}
              </section>
            )}
            <section className="form-section">
              <h3>Original purchase instructions</h3>
              <HtmlContent html={o.receipt_message} />
            </section>
          </section>
          <section>
            <h3>Order Total</h3>
            <dl className="order-totals">
              <dt>
                {money(o.unit_price_cents)} × {o.quantity}
              </dt>
              <dd>{money(o.subtotal_cents)}</dd>
              <dt>Tax</dt>
              <dd>{money(o.tax_cents)}</dd>
              <dt>Shipping</dt>
              <dd>{money(o.shipping_cents)}</dd>
              <dt>Total</dt>
              <dd>{money(o.total_cents)}</dd>
              <dt>Paid / credits applied</dt>
              <dd>{money(o.paid_cents)}</dd>
              <dt>Balance</dt>
              <dd>
                <strong>{money(o.balance_cents)}</strong>
              </dd>
            </dl>
            <Link className="button" to={"/invoices/" + o.invoice_id}>
              View Invoice #{o.invoice_number}
            </Link>
            {o.expires_at && o.paid_cents === 0 && o.status === "Open" && (
              <p className="notice">
                Unpaid reservation expires{" "}
                {new Date(o.expires_at).toLocaleString()}.
              </p>
            )}
            <div className="form-actions">
              {o.status === "Open" && (
                <>
                  <Button
                    secondary
                    disabled={busy || o.paid_cents > 0 || !!o.shipped_at}
                    onClick={() => setConfirm("cancel")}
                  >
                    Cancel Order
                  </Button>
                  <Button
                    disabled={
                      busy ||
                      o.balance_cents > 0 ||
                      (o.shipping_required && !o.shipped_at)
                    }
                    onClick={() => void action("close")}
                  >
                    Close Order
                  </Button>
                </>
              )}
              {o.status === "Closed" && (
                <Button
                  secondary
                  disabled={busy}
                  onClick={() => void action("reopen")}
                >
                  Reopen Order
                </Button>
              )}
            </div>
          </section>
        </div>
      </main>
      {confirm && (
        <Modal title="Cancel Order" onClose={() => setConfirm("")}>
          <div className="modal-body">
            <p>
              Cancel order #{o.number}, void its unpaid invoice and release its
              reserved inventory?
            </p>
            <ErrorBox error={error} />
            <div className="form-actions">
              <Button secondary onClick={() => setConfirm("")}>
                Keep Order
              </Button>
              <Button disabled={busy} onClick={() => void action("cancel")}>
                Cancel Order
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

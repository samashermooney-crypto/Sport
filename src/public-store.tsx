import { useEffect, useState } from "react";
import { api, money } from "./api";
import { Link } from "react-router-dom";
import { Button, Empty, ErrorBox, Loading, useData } from "./components";
import { HtmlContent } from "./rich-text";

type Variant = {
  id: string;
  name: string;
  price_cents: number;
  inventory: number | null;
};
type Product = Variant & {
  shipping: "None" | "Optional" | "Required";
  description: string;
  image_id: string | null;
  variants: Variant[];
};
type Catalog = {
  products: Product[];
  categories: {
    id: string;
    name: string;
    description: string;
    product_ids: string[];
  }[];
};
type CartLine = { product: string; variant: string; quantity: number };

export function PublicStore({ org }: { org: string }) {
  const catalog = useData<Catalog>(
    `/public/sites/${encodeURIComponent(org)}/store`,
    { products: [], categories: [] },
  );
  const [category, setCategory] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [recovery, setRecovery] = useState<PendingCheckout | null>(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(`fieldhouse-checkout:${org}`) || "null",
      );
      return saved &&
        typeof saved.body === "string" &&
        typeof saved.purchaser === "string" &&
        typeof saved.key === "string"
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  const [cart, setCart] = useState<CartLine[]>(() => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem(`fieldhouse-cart:${org}`) || "[]",
      );
      return Array.isArray(value)
        ? value
            .filter(
              (v) =>
                v &&
                typeof v.product === "string" &&
                typeof v.variant === "string" &&
                Number.isInteger(v.quantity) &&
                v.quantity > 0 &&
                v.quantity <= 1000,
            )
            .slice(0, 100)
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`fieldhouse-cart:${org}`, JSON.stringify(cart));
    } catch {
      /* Browsing still works when storage is disabled. */
    }
  }, [org, cart]);
  const lines = cart.flatMap((line) => {
    const product = catalog.data.products.find((p) => p.id === line.product);
    const item =
      product &&
      (product.variants.length
        ? product.variants.find((v) => v.id === line.variant)
        : line.variant
          ? undefined
          : product);
    return product && item ? [{ ...line, productInfo: product, item }] : [];
  });
  const subtotal = lines.reduce(
    (sum, line) => sum + line.item.price_cents * line.quantity,
    0,
  );
  const unavailable = cart.filter(
    (line) =>
      !lines.some(
        (current) =>
          current.product === line.product && current.variant === line.variant,
      ),
  );
  const selectedCategory = catalog.data.categories.find(
    (c) => c.id === category,
  );
  const visible = catalog.data.products.filter(
    (p) => !selectedCategory || selectedCategory.product_ids.includes(p.id),
  );
  const placed = (result: Receipt) => {
    try {
      sessionStorage.setItem(`fieldhouse-cart:${org}`, "[]");
      sessionStorage.removeItem(`fieldhouse-checkout:${org}`);
    } catch {
      /* In-memory recovery remains usable. */
    }
    setReceipt(result);
    setCart([]);
    setRecovery(null);
    catalog.reload();
  };
  if (recovery)
    return (
      <CheckoutRecovery
        org={org}
        pending={recovery}
        placed={placed}
        discard={() => {
          sessionStorage.removeItem(`fieldhouse-checkout:${org}`);
          setRecovery(null);
        }}
      />
    );
  if (catalog.loading) return <Loading />;
  if (catalog.error) return <ErrorBox error={catalog.error} />;
  return (
    <fieldset
      className="public-store-layout public-store-fieldset"
      disabled={checkoutBusy}
    >
      <section className="public-store-catalog" aria-label="Store front">
        <h2>Store Front</h2>
        {!!catalog.data.categories.length && (
          <label className="field">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All products</option>
              {catalog.data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {selectedCategory?.description && <p>{selectedCategory.description}</p>}
        <div className="public-store-columns" aria-hidden="true">
          <strong>Description</strong>
          <strong>Price</strong>
        </div>
        {visible.map((p) => (
          <StoreItem
            key={p.id}
            product={p}
            org={org}
            cart={cart}
            add={(variant) => {
              setCart((previous) => {
                const found = previous.find(
                  (l) => l.product === p.id && l.variant === variant,
                );
                return found
                  ? previous.map((l) =>
                      l === found ? { ...l, quantity: l.quantity + 1 } : l,
                    )
                  : [...previous, { product: p.id, variant, quantity: 1 }];
              });
            }}
          />
        ))}
        {!visible.length && (
          <Empty>No products available in this category.</Empty>
        )}
      </section>
      <aside className="public-store-cart" aria-label="Your selection">
        <h2>Your Selection</h2>
        {receipt && (
          <div role="status" className="public-store-receipt">
            <h3>Order placed</h3>
            <p>
              Total: {money(receipt.total_cents)}. No payment was processed.
            </p>
            {receipt.orders.map((order) => (
              <p key={order.id}>
                Order #{order.number} ·{" "}
                <Link
                  to={`/site/${org}/account/invoice?id=${order.invoice_id}`}
                >
                  Invoice #{order.invoice_number}
                </Link>
              </p>
            ))}
          </div>
        )}
        {unavailable.map((line, index) => (
          <div
            className="public-store-cart-line"
            key={line.product + line.variant}
          >
            <p role="alert">
              This cart item or configuration is no longer available. Remove it
              to continue.
            </p>
            <button
              type="button"
              className="text-button"
              aria-label={`Remove unavailable item ${index + 1}`}
              onClick={() =>
                setCart((previous) =>
                  previous.filter(
                    (item) =>
                      item.product !== line.product ||
                      item.variant !== line.variant,
                  ),
                )
              }
            >
              Remove unavailable item
            </button>
          </div>
        ))}
        {!cart.length ? (
          <p>Your cart is empty!</p>
        ) : (
          <>
            {lines.map((line) => (
              <div
                className="public-store-cart-line"
                key={line.product + line.variant}
              >
                <strong>{line.productInfo.name}</strong>
                {line.variant && <p>{line.item.name}</p>}
                <label className="field">
                  Quantity for {line.productInfo.name}
                  <input
                    type="number"
                    min={1}
                    max={Math.min(1000, line.item.inventory ?? 1000)}
                    value={line.quantity}
                    onChange={(e) => {
                      const quantity = Number(e.target.value);
                      if (
                        Number.isInteger(quantity) &&
                        quantity > 0 &&
                        quantity <= Math.min(1000, line.item.inventory ?? 1000)
                      )
                        setCart((previous) =>
                          previous.map((l) =>
                            l.product === line.product &&
                            l.variant === line.variant
                              ? { ...l, quantity }
                              : l,
                          ),
                        );
                    }}
                  />
                </label>
                <p>
                  {money(line.item.price_cents)} × {line.quantity} ={" "}
                  {money(line.item.price_cents * line.quantity)}
                </p>
                {line.item.inventory !== null &&
                  line.quantity > line.item.inventory && (
                    <p role="alert">
                      Only {line.item.inventory} available. Reduce the quantity
                      or remove this item.
                    </p>
                  )}
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove ${line.productInfo.name}${line.variant ? ` ${line.item.name}` : ""}`}
                  onClick={() =>
                    setCart((previous) =>
                      previous.filter(
                        (l) =>
                          l.product !== line.product ||
                          l.variant !== line.variant,
                      ),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <p className="public-store-subtotal">
              <strong>Subtotal</strong>
              <strong>{money(subtotal)}</strong>
            </p>
            <p>Tax and shipping are not included in this subtotal.</p>
            {!unavailable.length && (
              <CartReview
                key={JSON.stringify(cart)}
                org={org}
                cart={cart}
                products={catalog.data.products}
                onBusy={setCheckoutBusy}
                onPlaced={placed}
                onPending={setRecovery}
              />
            )}
          </>
        )}
      </aside>
    </fieldset>
  );
}

type Receipt = {
  orders: {
    id: string;
    number: number;
    invoice_id: string;
    invoice_number: number;
  }[];
  total_cents: number;
};
type CheckoutCallbacks = {
  onPlaced: (receipt: Receipt) => void;
  onBusy: (busy: boolean) => void;
  onPending: (pending: PendingCheckout) => void;
};
type Quote = {
  quote_digest: string;
  lines: { shipping: boolean }[];
  subtotal_cents: number;
  tax_cents: number;
  shipping_cents: number;
  total_cents: number;
};
function CartReview({
  org,
  cart,
  products,
  onPlaced,
  onBusy,
  onPending,
}: {
  org: string;
  cart: CartLine[];
  products: Product[];
} & CheckoutCallbacks) {
  const [open, setOpen] = useState(false);
  return open ? (
    <CartQuote
      org={org}
      cart={cart}
      products={products}
      onPlaced={onPlaced}
      onBusy={onBusy}
      onPending={onPending}
    />
  ) : (
    <Button onClick={() => setOpen(true)}>Review total</Button>
  );
}
function CartQuote({
  org,
  cart,
  products,
  onPlaced,
  onBusy,
  onPending,
}: {
  org: string;
  cart: CartLine[];
  products: Product[];
} & CheckoutCallbacks) {
  const recipients = useData<
    { id: string; first_name: string; last_name: string; self: boolean }[]
  >(`/public/sites/${encodeURIComponent(org)}/store/recipients`, []);
  const [address, setAddress] = useState({
    name: "",
    address: "",
    city: "",
    state: "",
    postal_code: "",
    country: "US",
  });
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [person, setPerson] = useState("");
  const [shipping, setShipping] = useState<Record<string, boolean>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (recipients.loading) return <Loading />;
  if (recipients.error)
    return (
      <>
        <ErrorBox error={recipients.error} />
        <Link to={`/site/${org}/account/login`}>
          Sign in to review your order
        </Link>
      </>
    );
  return (
    <form
      className="public-store-review"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        onBusy(true);
        setError("");
        try {
          if (quote) {
            const body = JSON.stringify({
              person_id: person,
              lines: cart.map((line) => ({
                product_id: line.product,
                variant_id: line.variant || null,
                quantity: line.quantity,
                shipping_requested: !!shipping[line.product],
              })),
              quote_digest: quote.quote_digest,
              shipping_address: address,
              idempotency_key: requestKey,
            });
            const pending = {
              body,
              key: requestKey,
              purchaser: recipients.data.find((p) => p.self)!.id,
            };
            sessionStorage.setItem(
              `fieldhouse-checkout:${org}`,
              JSON.stringify(pending),
            );
            onPending(pending);
            const result = await api<Receipt>(
              `/public/sites/${encodeURIComponent(org)}/store/checkout`,
              { method: "POST", body },
            );
            onPlaced(result);
            return;
          }
          setQuote(
            await api<Quote>(
              `/public/sites/${encodeURIComponent(org)}/store/quote`,
              {
                method: "POST",
                body: JSON.stringify({
                  person_id: person,
                  lines: cart.map((line) => ({
                    product_id: line.product,
                    variant_id: line.variant || null,
                    quantity: line.quantity,
                    shipping_requested: !!shipping[line.product],
                  })),
                }),
              },
            ),
          );
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
          onBusy(false);
        }
      }}
    >
      <label className="field">
        For member
        <select
          required
          value={person}
          onChange={(e) => {
            setPerson(e.target.value);
            setQuote(null);
            setRequestKey(crypto.randomUUID());
          }}
        >
          <option value="">Choose a member</option>
          {recipients.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.first_name} {p.last_name}
              {p.self ? " (you)" : ""}
            </option>
          ))}
        </select>
      </label>
      {products
        .filter(
          (p) =>
            p.shipping === "Optional" &&
            cart.some((line) => line.product === p.id),
        )
        .map((p) => (
          <label key={p.id} className="checkbox-line">
            <input
              type="checkbox"
              checked={!!shipping[p.id]}
              onChange={(e) => {
                setShipping({ ...shipping, [p.id]: e.target.checked });
                setQuote(null);
                setRequestKey(crypto.randomUUID());
              }}
            />
            Ship {p.name}
          </label>
        ))}
      {!quote && (
        <Button disabled={busy}>
          {busy ? "Calculating…" : "Calculate total"}
        </Button>
      )}
      <ErrorBox error={error} />
      {quote && (
        <div aria-label="Order quote" className="public-store-quote">
          <p>
            <span>Items</span>
            <strong>{money(quote.subtotal_cents)}</strong>
          </p>
          <p>
            <span>Tax</span>
            <strong>{money(quote.tax_cents)}</strong>
          </p>
          <p>
            <span>Shipping</span>
            <strong>{money(quote.shipping_cents)}</strong>
          </p>
          <p>
            <strong>Total</strong>
            <strong>{money(quote.total_cents)}</strong>
          </p>
          {quote.lines.some((line) => line.shipping) && (
            <section aria-label="Shipping address">
              <h3>Shipping address</h3>
              {(
                [
                  ["name", "Recipient name", 150],
                  ["address", "Street address", 200],
                  ["city", "City", 100],
                  ["state", "State / region", 100],
                  ["postal_code", "Postal code", 30],
                  ["country", "Country", 100],
                ] as const
              ).map(([key, label, maxLength]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    required
                    maxLength={maxLength}
                    value={address[key]}
                    onChange={(e) => {
                      setAddress({ ...address, [key]: e.target.value });
                      setRequestKey(crypto.randomUUID());
                    }}
                  />
                </label>
              ))}
            </section>
          )}
          <p className="public-store-checkout-note">
            Placing this order reserves available items and creates an invoice.
            No card payment will be taken.
          </p>
          <div className="form-actions">
            <Button
              type="button"
              secondary
              disabled={busy}
              onClick={() => {
                setQuote(null);
                setRequestKey(crypto.randomUUID());
              }}
            >
              Review again
            </Button>
            <Button disabled={busy}>
              {busy ? "Placing order…" : "Place order"}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

function StoreItem({
  product: p,
  org,
  cart,
  add,
}: {
  product: Product;
  org: string;
  cart: CartLine[];
  add: (variant: string) => void;
}) {
  const [variant, setVariant] = useState(p.variants[0]?.id || "");
  const item = p.variants.length
    ? p.variants.find((v) => v.id === variant) || p.variants[0]
    : p;
  const quantity =
    cart.find((l) => l.product === p.id && l.variant === variant)?.quantity ||
    0;
  const unavailable = item.inventory !== null && quantity >= item.inventory;
  return (
    <article className="public-store-item">
      <div>
        {p.image_id && (
          <img
            src={`/api/public/sites/${encodeURIComponent(org)}/store/images/${encodeURIComponent(p.image_id)}`}
            alt={p.name}
          />
        )}
        <h3>{p.name}</h3>
        <HtmlContent html={p.description} />
        {!!p.variants.length && (
          <label className="field">
            Configuration for {p.name}
            <select
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
            >
              {p.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="public-store-price">
        <strong>{money(item.price_cents)}</strong>
        <Button
          disabled={unavailable || quantity >= 1000}
          onClick={() => add(variant)}
        >
          {item.inventory === 0
            ? "Sold out"
            : unavailable
              ? "All available added"
              : "Add to cart"}
        </Button>
      </div>
    </article>
  );
}

type PendingCheckout = { body: string; key: string; purchaser: string };
function CheckoutRecovery({
  org,
  pending,
  placed,
  discard,
}: {
  org: string;
  pending: PendingCheckout;
  placed: (r: Receipt) => void;
  discard: () => void;
}) {
  const member = useData<{ id: string; self: boolean }[]>(
    `/public/sites/${encodeURIComponent(org)}/store/recipients`,
    [],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [rejected, setRejected] = useState(false);
  const matches = member.data.some((p) => p.self && p.id === pending.purchaser);
  async function recover() {
    if (busy || !matches) return;
    setBusy(true);
    setError("");
    setRejected(false);
    try {
      const status = await api<{ receipt: Receipt | null }>(
        `/public/sites/${encodeURIComponent(org)}/store/checkouts/${encodeURIComponent(pending.key)}`,
      );
      if (status.receipt) {
        placed(status.receipt);
        return;
      }
      const response = await fetch(
        `/api/public/sites/${encodeURIComponent(org)}/store/checkout`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fieldhouse-Request": "1",
          },
          body: pending.body,
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setRejected([400, 403, 404, 409, 422].includes(response.status));
        throw new Error(result.error || "Unable to recover this checkout.");
      }
      placed(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="public-store-receipt">
      <h2>Finish your previous checkout</h2>
      <p>
        A previous order submission has not been confirmed in this browser.
        Continue to recover its receipt or retry the original order safely.
      </p>
      <ErrorBox error={member.error || error} />
      {member.loading ? (
        <Loading />
      ) : matches ? (
        <div className="form-actions">
          <Button disabled={busy} onClick={recover}>
            {busy ? "Checking order…" : "Continue previous checkout"}
          </Button>
          {rejected && (
            <Button secondary onClick={discard}>
              Return to cart
            </Button>
          )}
        </div>
      ) : (
        <p>
          Sign in as the member who started this checkout to continue.{" "}
          <Link to={`/site/${org}/account/login`}>Member sign in</Link>
        </p>
      )}
    </section>
  );
}

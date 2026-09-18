import { z } from "zod";
import { createHash } from "node:crypto";
import { productDetail, commerceSettings, createOrder } from "./commerce.mjs";
import { DomainError, requireEntity } from "./domain.mjs";
import { unpack, transaction, now } from "./db.mjs";
import { memberFamily, memberRequestSession } from "./member-auth.mjs";

const cartSchema = z.object({
  person_id: z.string().min(1),
  lines: z
    .array(
      z.object({
        product_id: z.string().min(1),
        variant_id: z.string().nullable().default(null),
        quantity: z.number().int().min(1).max(1000),
        shipping_requested: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100),
});

export function memberStoreRecipients(db, account) {
  const self = unpack(
    requireEntity(db, "people", account.person_id, account.org_id),
  );
  if (self.archived_at) throw new DomainError("This member is archived", 403);
  return [
    {
      id: self.id,
      first_name: self.first_name,
      last_name: self.last_name,
      self: true,
    },
    ...memberFamily(db, account)
      .filter((p) => !p.self && p.can_register)
      .map((p) => ({
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        self: false,
      })),
  ];
}

export function quoteMemberCart(db, account, input) {
  const cart = cartSchema.parse(input);
  if (!memberStoreRecipients(db, account).some((p) => p.id === cart.person_id))
    throw new DomainError("Choose yourself or a child in your family", 403);
  const seen = new Set();
  const actor = { id: account.id, org_id: account.org_id };
  const taxRate = commerceSettings(db, actor).tax_rate_bps;
  const lines = cart.lines.map((line) => {
    const key = JSON.stringify([line.product_id, line.variant_id]);
    if (seen.has(key))
      throw new DomainError("Combine duplicate cart items before checkout");
    seen.add(key);
    const product = productDetail(db, actor, line.product_id);
    if (
      !product.published ||
      product.archived_at ||
      product.availability !== "Store"
    )
      throw new DomainError("This product is not available in the store", 409);
    const chosen = product.variants.length
      ? product.variants.find((v) => v.id === line.variant_id)
      : line.variant_id
        ? null
        : product;
    if (!chosen)
      throw new DomainError("Choose an available product configuration");
    if (chosen.inventory !== null && chosen.inventory < line.quantity)
      throw new DomainError(`Not enough inventory for ${product.name}`, 409);
    const shipping =
      product.shipping === "Required" ||
      (product.shipping === "Optional" && line.shipping_requested);
    const subtotal_cents = chosen.price_cents * line.quantity;
    const tax_cents = product.taxable
      ? Math.round((subtotal_cents * taxRate) / 10000)
      : 0;
    const shipping_cents = shipping ? product.shipping_cents : 0;
    const total_cents = subtotal_cents + tax_cents + shipping_cents;
    if (!Number.isSafeInteger(total_cents) || total_cents > 100000000)
      throw new DomainError("Order total exceeds the supported limit");
    return {
      ...line,
      product_name: product.name,
      variant_name: product.variants.length ? chosen.name : "",
      shipping,
      shipping_mode: product.shipping,
      unit_price_cents: chosen.price_cents,
      subtotal_cents,
      tax_cents,
      shipping_cents,
      total_cents,
    };
  });
  const totals = Object.fromEntries(
    ["subtotal_cents", "tax_cents", "shipping_cents", "total_cents"].map(
      (key) => [key, lines.reduce((sum, line) => sum + line[key], 0)],
    ),
  );
  if (totals.total_cents > 100000000)
    throw new DomainError("Cart total exceeds the supported limit");
  const quote = {
    person_id: cart.person_id,
    purchaser_id: account.person_id,
    lines,
    ...totals,
  };
  return { ...quote, quote_digest: digest(quote) };
}

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const checkoutSchema = cartSchema.extend({
  quote_digest: z.string().length(64),
  idempotency_key: z.string().min(8).max(100),
  shipping_address: z
    .object({
      name: z.string().trim().max(150).default(""),
      address: z.string().trim().max(200).default(""),
      city: z.string().trim().max(100).default(""),
      state: z.string().trim().max(100).default(""),
      postal_code: z.string().trim().max(30).default(""),
      country: z.string().trim().max(100).default("US"),
    })
    .default({}),
});

export function submitMemberCart(db, account, input) {
  const request = checkoutSchema.parse(input);
  const requestHash = digest(request);
  return transaction(db, () => {
    memberStoreRecipients(db, account);
    const previous = db
      .prepare(
        "SELECT * FROM member_checkouts WHERE org_id=? AND account_id=? AND idempotency_key=?",
      )
      .get(account.org_id, account.id, request.idempotency_key);
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new DomainError(
          "This checkout request was already used for a different cart",
          409,
        );
      return JSON.parse(previous.receipt);
    }
    const quote = quoteMemberCart(db, account, request);
    if (quote.quote_digest !== request.quote_digest)
      throw new DomainError(
        "Your cart changed. Review the current total before placing your order.",
        409,
      );
    const orders = quote.lines.map((line, index) => {
      const order = createOrder(
        db,
        { id: account.id, org_id: account.org_id },
        {
          ...line,
          person_id: quote.person_id,
          purchaser_id: account.person_id,
          quoted_total_cents: line.total_cents,
          shipping_address: request.shipping_address,
          idempotency_key: digest([account.id, request.idempotency_key, index]),
        },
      );
      return {
        id: order.id,
        number: order.number,
        invoice_id: order.invoice_id,
        invoice_number: order.invoice_number,
        total_cents: order.total_cents,
      };
    });
    const receipt = {
      orders,
      total_cents: quote.total_cents,
      payment_processed: false,
    };
    db.prepare("INSERT INTO member_checkouts VALUES(?,?,?,?,?,?)").run(
      account.org_id,
      account.id,
      request.idempotency_key,
      requestHash,
      JSON.stringify(receipt),
      now(),
    );
    return receipt;
  });
}

export function installMemberStoreRoutes(app, db) {
  const member = (req) => {
    const account = memberRequestSession(db, req, req.params.org);
    if (!account) throw new DomainError("Sign in to continue", 401);
    return account;
  };
  app.get("/api/public/sites/:org/store/orders", (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(memberStoreOrders(db, member(req))),
  );
  app.get("/api/public/sites/:org/store/checkouts/:key", (req, res) =>
    res.set("Cache-Control", "no-store").json(memberCheckoutReceipt(db, member(req), req.params.key)),
  );
  app.get("/api/public/sites/:org/store/orders/:id", (req, res) =>
    res.set("Cache-Control", "no-store").json(memberStoreOrderDetails(db, member(req), req.params.id)),
  );
  app.get("/api/public/sites/:org/store/recipients", (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(memberStoreRecipients(db, member(req))),
  );
  app.post("/api/public/sites/:org/store/quote", (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(quoteMemberCart(db, member(req), req.body)),
  );
  app.post("/api/public/sites/:org/store/checkout", (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(submitMemberCart(db, member(req), req.body)),
  );
}

export function memberStoreOrders(db, account) {
  memberStoreRecipients(db, account);
  return db
    .prepare(
      `SELECT o.*, i.total_cents, i.paid_cents, i.voided, i.number AS invoice_number
    FROM product_orders o JOIN invoices i ON i.id=o.invoice_id AND i.org_id=o.org_id
    WHERE o.org_id=? AND o.purchaser_id=? ORDER BY o.created_at DESC,o.number DESC`,
    )
    .all(account.org_id, account.person_id)
    .map((row) => {
      const order = unpack(row);
      return {
        id: order.id,
        number: order.number,
        created_at: order.created_at,
        product_name: order.product_name,
        variant_name: order.variant_name,
        quantity: order.quantity,
        status: order.status,
        shipped_at: order.shipped_at,
        invoice_id: order.invoice_id,
        invoice_number: order.invoice_number,
        total_cents: row.total_cents,
        balance_cents: row.voided ? 0 : row.total_cents - row.paid_cents,
      };
    });
}

export function memberCheckoutReceipt(db, account, key) {
  memberStoreRecipients(db, account);
  z.string().min(8).max(100).parse(key);
  const row = db.prepare("SELECT receipt FROM member_checkouts WHERE org_id=? AND account_id=? AND idempotency_key=?")
    .get(account.org_id, account.id, key);
  return { receipt: row ? JSON.parse(row.receipt) : null };
}

export function memberStoreOrderDetails(db, account, orderId) {
  memberStoreRecipients(db, account);
  const row = db.prepare("SELECT data FROM product_orders WHERE id=? AND org_id=? AND purchaser_id=?")
    .get(orderId, account.org_id, account.person_id);
  if (!row) throw new DomainError("Order not found", 404);
  const data = JSON.parse(row.data);
  return {receipt_message:data.receipt_message || "",shipping_address:data.shipping_address || null,
    subtotal_cents:data.subtotal_cents, tax_cents:data.tax_cents, shipping_cents:data.shipping_cents};
}

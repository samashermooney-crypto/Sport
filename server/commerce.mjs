import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { id, now, transaction, audit, unpack } from "./db.mjs";
import { DomainError, requireEntity } from "./domain.mjs";
import { cleanHtml } from "./html.mjs";

const cents = z.number().int().min(0).max(100000000);
const stock = z.number().int().min(0).max(10000000).nullable();
const productSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    sku: z.string().trim().max(80).default(""),
    description: z.string().max(20000).default(""),
    receipt_message: z.string().max(10000).default(""),
    image_id: z.string().nullable().default(null),
    price_cents: cents,
    inventory: stock.default(null),
    published: z.boolean().default(true),
    availability: z
      .enum(["Private", "Registration", "Store"])
      .default("Private"),
    shipping: z.enum(["None", "Optional", "Required"]).default("None"),
    shipping_cents: cents.default(0),
    taxable: z.boolean().default(false),
    expire_unpaid: z.boolean().default(true),
    notify_purchase: z.boolean().default(false),
    required_at_registration: z.boolean().default(false),
    program_ids: z.array(z.string()).max(1000).default([]),
    version: z.number().int().optional(),
    variants: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string().trim().min(1).max(100),
          sku: z.string().max(80).default(""),
          price_cents: cents,
          inventory: stock.default(null),
        }),
      )
      .max(100)
      .default([]),
  })
  .superRefine((p, ctx) => {
    if (
      new Set(p.variants.map((v) => v.name.toLowerCase())).size !==
      p.variants.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["variants"],
        message: "Configuration names must be unique",
      });
  });
function own(db, table, entityId, actor) {
  if (
    !["products", "product_orders", "store_categories", "assets"].includes(
      table,
    )
  )
    throw new Error("Unsupported commerce entity");
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE id=? AND org_id=?`)
    .get(entityId, actor.org_id);
  if (!row) throw new DomainError("Record not found", 404);
  return row;
}
export function productDetail(db, actor, productId) {
  const row = own(db, "products", productId, actor);
  return {
    ...unpack(row),
    published: !!row.published,
    program_ids: db
      .prepare("SELECT program_id FROM product_programs WHERE product_id=?")
      .all(row.id)
      .map((r) => r.program_id),
    variants: db
      .prepare(
        "SELECT * FROM product_variants WHERE product_id=? AND active=1 ORDER BY name",
      )
      .all(row.id),
    last_order_at: db
      .prepare(
        "SELECT MAX(created_at) d FROM product_orders WHERE product_id=?",
      )
      .get(row.id).d,
  };
}
export function saveProduct(db, actor, input, productId) {
  const p = productSchema.parse(input);
  return transaction(db, () => {
    const prior = productId ? own(db, "products", productId, actor) : null;
    if (prior && (prior.archived_at || prior.version !== p.version))
      throw new DomainError("This product changed. Reload before saving.", 409);
    for (const programId of new Set(p.program_ids))
      requireEntity(db, "programs", programId, actor.org_id);
    if (p.image_id) own(db, "assets", p.image_id, actor);
    const key = productId || id(),
      timestamp = now();
    const {
      name,
      sku,
      price_cents,
      inventory,
      published,
      availability,
      program_ids,
      variants,
      version,
      ...extra
    } = p;
    extra.description = cleanHtml(extra.description);
    extra.receipt_message = cleanHtml(extra.receipt_message);
    if (prior)
      db.prepare(
        "UPDATE products SET name=?,sku=?,price_cents=?,inventory=?,published=?,availability=?,data=?,version=version+1,updated_at=? WHERE id=?",
      ).run(
        name,
        sku,
        price_cents,
        inventory,
        +published,
        availability,
        JSON.stringify(extra),
        timestamp,
        key,
      );
    else
      db.prepare(
        "INSERT INTO products(id,org_id,name,sku,price_cents,inventory,published,availability,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        key,
        actor.org_id,
        name,
        sku,
        price_cents,
        inventory,
        +published,
        availability,
        JSON.stringify(extra),
        timestamp,
        timestamp,
      );
    const existing = db
      .prepare("SELECT * FROM product_variants WHERE product_id=?")
      .all(key);
    // Switching a sold product between base stock and per-configuration stock would lose its reservation ledger.
    const hasOrders = db
      .prepare("SELECT id FROM product_orders WHERE product_id=? LIMIT 1")
      .get(key);
    if (hasOrders && !!existing.length !== !!variants.length)
      throw new DomainError(
        "Products with orders must retain their configuration structure. Copy this product to change it.",
        409,
      );
    db.prepare("UPDATE product_variants SET active=0 WHERE product_id=?").run(
      key,
    );
    for (const v of variants) {
      if (v.id && !existing.some((e) => e.id === v.id))
        throw new DomainError("Configuration not found", 404);
      if (v.id)
        db.prepare(
          "UPDATE product_variants SET name=?,sku=?,price_cents=?,inventory=?,active=1 WHERE id=?",
        ).run(v.name, v.sku, v.price_cents, v.inventory, v.id);
      else
        db.prepare(
          "INSERT INTO product_variants(id,product_id,name,sku,price_cents,inventory) VALUES(?,?,?,?,?,?)",
        ).run(id(), key, v.name, v.sku, v.price_cents, v.inventory);
    }
    db.prepare("DELETE FROM product_programs WHERE product_id=?").run(key);
    for (const programId of new Set(program_ids))
      db.prepare("INSERT INTO product_programs VALUES(?,?)").run(
        key,
        programId,
      );
    audit(db, actor, prior ? "update" : "create", "product", key);
    return productDetail(db, actor, key);
  });
}
export function commerceSettings(db, actor) {
  return JSON.parse(
    db
      .prepare(
        "SELECT value FROM settings WHERE org_id=? AND scope='site' AND key='commerce'",
      )
      .get(actor.org_id)?.value || '{"tax_rate_bps":0}',
  );
}
const orderSchema = z.object({
  quoted_total_cents: cents,
  product_id: z.string(),
  variant_id: z.string().nullable().default(null),
  person_id: z.string(),
  purchaser_id: z.string().optional(),
  program_id: z.string().nullable().default(null),
  quantity: z.number().int().min(1).max(1000),
  shipping_requested: z.boolean().default(false),
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
  idempotency_key: z.string().min(8).max(100),
});
export function orderDetail(db, actor, orderId) {
  const raw = own(db, "product_orders", orderId, actor),
    o = unpack(raw),
    i = requireEntity(db, "invoices", o.invoice_id, actor.org_id),
    p = requireEntity(db, "people", o.person_id, actor.org_id),
    buyer = requireEntity(db, "people", o.purchaser_id, actor.org_id);
  const { request_hash, idempotency_key, ...visible } = o;
  return {
    ...visible,
    invoice_number: i.number,
    total_cents: i.total_cents,
    paid_cents: i.paid_cents,
    balance_cents: i.voided ? 0 : i.total_cents - i.paid_cents,
    payment_status: i.voided
      ? "Void"
      : i.paid_cents === i.total_cents
        ? "Paid"
        : "Unpaid",
    display_status:
      o.status === "Open"
        ? i.paid_cents === i.total_cents
          ? "Open/Paid"
          : "Open/New"
        : o.status,
    person_name: p.first_name + " " + p.last_name,
    purchaser_name: buyer.first_name + " " + buyer.last_name,
    purchaser_email: buyer.email,
    program_name: o.program_id
      ? requireEntity(db, "programs", o.program_id, actor.org_id).name
      : "",
  };
}
export function createOrder(db, actor, input) {
  const p = orderSchema.parse(input);
  p.purchaser_id ||= p.person_id;
  const { idempotency_key, ...request } = p,
    hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  return transaction(db, () => {
    const prior = db
      .prepare(
        "SELECT * FROM product_orders WHERE org_id=? AND idempotency_key=?",
      )
      .get(actor.org_id, idempotency_key);
    if (prior) {
      if (prior.request_hash !== hash)
        throw new DomainError(
          "This request key was used for another order",
          409,
        );
      return orderDetail(db, actor, prior.id);
    }
    const product = productDetail(db, actor, p.product_id);
    if (!product.published || product.archived_at)
      throw new DomainError("This product is not available for purchase", 409);
    for (const personId of new Set([p.person_id, p.purchaser_id])) {
      const member = unpack(
        requireEntity(db, "people", personId, actor.org_id),
      );
      if (member.archived_at) throw new DomainError("This member is archived");
    }
    if (
      p.purchaser_id !== p.person_id &&
      !db
        .prepare(
          "SELECT 1 FROM household_members a JOIN household_members b ON b.household_id=a.household_id WHERE a.person_id=? AND a.role='Supervisor' AND b.person_id=?",
        )
        .get(p.purchaser_id, p.person_id)
    )
      throw new DomainError(
        "Purchaser must be this member or a supervisor in their family",
      );
    if (p.program_id) {
      const program = requireEntity(db, "programs", p.program_id, actor.org_id);
      if (
        !product.program_ids.includes(program.id) &&
        !product.program_ids.includes(program.parent_id)
      )
        throw new DomainError(
          "This product is not associated with that program",
        );
      if (
        !db
          .prepare(
            "SELECT id FROM registrations WHERE org_id=? AND program_id=? AND person_id=? AND status!='Canceled'",
          )
          .get(actor.org_id, p.program_id, p.person_id)
      )
        throw new DomainError("This member is not registered in that program");
    } else if (product.availability === "Registration")
      throw new DomainError(
        "This product is only available through associated registrations",
      );
    const variant = p.variant_id
      ? product.variants.find((v) => v.id === p.variant_id)
      : null;
    if (
      (p.variant_id && !variant) ||
      (!p.variant_id && product.variants.length)
    )
      throw new DomainError("Choose an available product configuration");
    const chosen = variant || product;
    if (chosen.inventory !== null && chosen.inventory < p.quantity)
      throw new DomainError("Not enough inventory is available", 409);
    const shipping =
      product.shipping === "Required" ||
      (product.shipping === "Optional" && p.shipping_requested);
    if (
      shipping &&
      !["name", "address", "city", "state", "postal_code", "country"].every(
        (k) => p.shipping_address[k],
      )
    )
      throw new DomainError("Complete the shipping address");
    const unit = chosen.price_cents,
      subtotal = unit * p.quantity,
      shippingCents = shipping ? product.shipping_cents : 0,
      taxRate = product.taxable ? commerceSettings(db, actor).tax_rate_bps : 0,
      tax = Math.round((subtotal * taxRate) / 10000),
      total = subtotal + shippingCents + tax;
    if (!Number.isSafeInteger(total) || total > 100000000)
      throw new DomainError("Order total exceeds the supported limit");
    if (total !== p.quoted_total_cents)
      throw new DomainError(
        "The price, shipping charge or tax rate changed. Reload and review the total before ordering.",
        409,
      );
    const key = id(),
      invoiceId = id(),
      timestamp = now(),
      number = db
        .prepare("SELECT COALESCE(MAX(number),1000)+1 n FROM product_orders")
        .get().n,
      invoiceNumber = db
        .prepare("SELECT COALESCE(MAX(number),1000)+1 n FROM invoices")
        .get().n;
    const snapshot = {
      product_name: product.name,
      sku: chosen.sku,
      variant_name: variant?.name || "",
      unit_price_cents: unit,
      subtotal_cents: subtotal,
      shipping_cents: shippingCents,
      tax_cents: tax,
      tax_rate_bps: taxRate,
      shipping_required: shipping,
      shipping_address: shipping ? p.shipping_address : null,
      receipt_message: product.receipt_message,
      inventory_reserved: chosen.inventory !== null,
      image_id: product.image_id,
    };
    db.prepare(
      "INSERT INTO invoices(id,number,org_id,program_id,person_id,description,total_cents,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      invoiceId,
      invoiceNumber,
      actor.org_id,
      p.program_id,
      p.purchaser_id,
      product.name + " · Product order #" + number,
      total,
      JSON.stringify({ kind: "Product", order_id: key, ...snapshot }),
      timestamp,
    );
    db.prepare(
      "INSERT INTO product_orders(id,number,org_id,product_id,variant_id,person_id,purchaser_id,program_id,invoice_id,quantity,expires_at,data,request_hash,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      key,
      number,
      actor.org_id,
      product.id,
      p.variant_id,
      p.person_id,
      p.purchaser_id,
      p.program_id,
      invoiceId,
      p.quantity,
      product.expire_unpaid && total > 0
        ? new Date(Date.now() + 1800000).toISOString()
        : null,
      JSON.stringify(snapshot),
      hash,
      idempotency_key,
      timestamp,
    );
    if (chosen.inventory !== null)
      db.prepare(
        `UPDATE ${variant ? "product_variants" : "products"} SET inventory=inventory-? WHERE id=?`,
      ).run(p.quantity, chosen.id);
    db.prepare(
      "UPDATE products SET version=version+1,updated_at=? WHERE id=?",
    ).run(timestamp, product.id);
    audit(db, actor, "create", "product_order", key, {
      total_cents: total,
      quantity: p.quantity,
    });
    return orderDetail(db, actor, key);
  });
}
function cancelOrderInside(db, actor, o, reason) {
  if (o.status === "Canceled") return;
  const invoice = requireEntity(db, "invoices", o.invoice_id, actor.org_id);
  if (invoice.paid_cents > 0)
    throw new DomainError(
      "Paid orders cannot be canceled until their payment is refunded",
      409,
    );
  if (o.status === "Closed" || o.shipped_at)
    throw new DomainError("A closed or shipped order cannot be canceled", 409);
  const snapshot = JSON.parse(o.data);
  if (snapshot.inventory_reserved) {
    db.prepare(
      `UPDATE ${o.variant_id ? "product_variants" : "products"} SET inventory=CASE WHEN inventory IS NULL THEN NULL ELSE inventory+? END WHERE id=?`,
    ).run(o.quantity, o.variant_id || o.product_id);
  }
  db.prepare(
    "UPDATE products SET version=version+1,updated_at=? WHERE id=?",
  ).run(now(), o.product_id);
  db.prepare(
    "UPDATE product_orders SET status='Canceled',closed_at=? WHERE id=?",
  ).run(now(), o.id);
  db.prepare("UPDATE invoices SET voided=1 WHERE id=?").run(o.invoice_id);
  audit(db, actor, reason, "product_order", o.id);
}
export function changeOrder(db, actor, orderId, input) {
  const p = z
    .object({
      action: z.enum(["cancel", "close", "reopen", "ship"]),
      tracking: z.string().trim().max(200).default(""),
    })
    .parse(input);
  return transaction(db, () => {
    const o = own(db, "product_orders", orderId, actor),
      invoice = requireEntity(db, "invoices", o.invoice_id, actor.org_id);
    if (p.action === "cancel") cancelOrderInside(db, actor, o, "cancel");
    else {
      if (o.status === "Canceled" || invoice.voided)
        throw new DomainError("This order is canceled", 409);
      if (invoice.paid_cents !== invoice.total_cents)
        throw new DomainError(
          "The invoice must be paid before fulfillment",
          409,
        );
      if (p.action === "ship") {
        const data = JSON.parse(o.data);
        if (!data.shipping_required)
          throw new DomainError("This order does not require shipping");
        if (!o.shipped_at)
          db.prepare(
            "UPDATE product_orders SET shipped_at=?,data=? WHERE id=?",
          ).run(now(), JSON.stringify({ ...data, tracking: p.tracking }), o.id);
      } else {
        if (
          p.action === "close" &&
          JSON.parse(o.data).shipping_required &&
          !o.shipped_at
        )
          throw new DomainError("Mark this order shipped before closing it");
        db.prepare(
          "UPDATE product_orders SET status=?,closed_at=? WHERE id=?",
        ).run(
          p.action === "close" ? "Closed" : "Open",
          p.action === "close" ? now() : null,
          o.id,
        );
      }
      audit(db, actor, p.action, "product_order", o.id);
    }
    return orderDetail(db, actor, o.id);
  });
}
export function expireOrders(db, at = now()) {
  return transaction(db, () => {
    const rows = db
      .prepare(
        "SELECT o.* FROM product_orders o JOIN invoices i ON i.id=o.invoice_id WHERE o.status='Open' AND o.expires_at<=? AND i.paid_cents=0 AND i.total_cents>0",
      )
      .all(at);
    for (const o of rows)
      cancelOrderInside(db, { org_id: o.org_id }, o, "expire_unpaid");
    return rows.length;
  });
}
export function installCommerceRoutes(app, db) {
  app.get("/api/products", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id FROM products WHERE org_id=? AND archived_at IS NULL ORDER BY created_at DESC",
        )
        .all(req.actor.org_id)
        .map((p) => productDetail(db, req.actor, p.id)),
    ),
  );
  app.get("/api/products/:id", (req, res) =>
    res.json(productDetail(db, req.actor, req.params.id)),
  );
  app.post("/api/products", (req, res) =>
    res.status(201).json(saveProduct(db, req.actor, req.body)),
  );
  app.put("/api/products/:id", (req, res) =>
    res.json(saveProduct(db, req.actor, req.body, req.params.id)),
  );
  app.post("/api/products/:id/copy", (req, res) => {
    const p = productDetail(db, req.actor, req.params.id);
    res.status(201).json(
      saveProduct(db, req.actor, {
        ...p,
        name: (p.name + " (copy)").slice(0, 150),
        published: false,
        variants: p.variants.map(({ id, ...v }) => v),
      }),
    );
  });
  app.delete("/api/products/:id", (req, res) => {
    own(db, "products", req.params.id, req.actor);
    db.prepare(
      "UPDATE products SET archived_at=?,published=0,version=version+1 WHERE id=?",
    ).run(now(), req.params.id);
    audit(db, req.actor, "archive", "product", req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/orders", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id FROM product_orders WHERE org_id=? ORDER BY created_at DESC",
        )
        .all(req.actor.org_id)
        .map((o) => orderDetail(db, req.actor, o.id)),
    ),
  );
  app.get("/api/orders/:id", (req, res) =>
    res.json(orderDetail(db, req.actor, req.params.id)),
  );
  app.post("/api/orders", (req, res) => {
    expireOrders(db);
    res.status(201).json(createOrder(db, req.actor, req.body));
  });
  app.post("/api/orders/:id/actions", (req, res) =>
    res.json(changeOrder(db, req.actor, req.params.id, req.body)),
  );
  app.get("/api/commerce/settings", (req, res) =>
    res.json(commerceSettings(db, req.actor)),
  );
  app.put("/api/commerce/settings", (req, res) => {
    const p = z
      .object({ tax_rate_bps: z.number().int().min(0).max(10000) })
      .parse(req.body);
    db.prepare(
      "INSERT INTO settings VALUES(?,'site','commerce',?) ON CONFLICT(org_id,scope,key) DO UPDATE SET value=excluded.value",
    ).run(req.actor.org_id, JSON.stringify(p));
    audit(db, req.actor, "update", "commerce_settings", "site");
    res.json(p);
  });
  app.get("/api/store/categories", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM store_categories WHERE org_id=? ORDER BY position,name",
        )
        .all(req.actor.org_id)
        .map((c) => ({
          ...c,
          product_ids: db
            .prepare(
              "SELECT product_id FROM category_products WHERE category_id=? ORDER BY position",
            )
            .all(c.id)
            .map((p) => p.product_id),
        })),
    ),
  );
  const category = (req, res) => {
    const p = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(1000).default(""),
        product_ids: z.array(z.string()).max(1000).default([]),
        position: z.number().int().min(0).default(0),
      })
      .parse(req.body);
    res.json(
      transaction(db, () => {
        const key = req.params.id || id();
        if (req.params.id) own(db, "store_categories", key, req.actor);
        for (const productId of p.product_ids)
          own(db, "products", productId, req.actor);
        db.prepare(
          "INSERT INTO store_categories VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,position=excluded.position",
        ).run(key, req.actor.org_id, p.name, p.description, p.position);
        db.prepare("DELETE FROM category_products WHERE category_id=?").run(
          key,
        );
        [...new Set(p.product_ids)].forEach((productId, i) =>
          db
            .prepare("INSERT INTO category_products VALUES(?,?,?)")
            .run(key, productId, i),
        );
        audit(db, req.actor, "save", "store_category", key);
        return { id: key, ...p };
      }),
    );
  };
  app.post("/api/store/categories", category);
  app.put("/api/store/categories/:id", category);
  app.delete("/api/store/categories/:id", (req, res) => {
    own(db, "store_categories", req.params.id, req.actor);
    transaction(db, () => {
      db.prepare("DELETE FROM category_products WHERE category_id=?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM store_categories WHERE id=?").run(req.params.id);
      audit(db, req.actor, "delete", "store_category", req.params.id);
    });
    res.json({ ok: true });
  });
  app.post(
    "/api/assets",
    express.raw({
      type: ["image/png", "image/jpeg", "image/webp"],
      limit: "5mb",
    }),
    (req, res) => {
      const bytes = req.body,
        mime = req.get("content-type");
      if (!Buffer.isBuffer(bytes) || bytes.length < 12)
        throw new DomainError("Choose a PNG, JPEG or WebP image");
      const valid =
        (mime === "image/png" &&
          bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (mime === "image/jpeg" &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255) ||
        (mime === "image/webp" &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP");
      if (!valid)
        throw new DomainError("The uploaded file is not a supported image");
      const key = id();
      db.prepare("INSERT INTO assets VALUES(?,?,?,?,?)").run(
        key,
        req.actor.org_id,
        mime,
        bytes,
        now(),
      );
      audit(db, req.actor, "upload", "asset", key);
      res.status(201).json({ id: key });
    },
  );
  app.get("/api/assets/:id", (req, res) => {
    const a = own(db, "assets", req.params.id, req.actor);
    res.setHeader("Content-Type", a.mime);
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.send(Buffer.from(a.bytes));
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { savePerson } from "./directory.mjs";
import { saveProgram, register, recordPayment } from "./domain.mjs";
import {
  saveProduct,
  productDetail,
  createOrder,
  orderDetail,
  changeOrder,
  expireOrders,
  commerceSettings,
} from "./commerce.mjs";
function fixture() {
  const db = openDb(":memory:");
  for (const key of ["org", "other"])
    db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(key, key);
  const actor = { id: "admin", org_id: "org" },
    other = { id: "otheradmin", org_id: "other" },
    person = savePerson(db, actor, {
      first_name: "Example",
      last_name: "Member",
    });
  return {
    db,
    actor,
    other,
    person,
    product: (p = {}) =>
      saveProduct(db, actor, {
        name: "Jersey",
        price_cents: 2500,
        inventory: 5,
        ...p,
      }),
    order: (product, p = {}) => {
      const variant = product.variants.find((v) => v.id === p.variant_id),
        subtotal = (variant || product).price_cents * (p.quantity || 1);
      const shipping =
        product.shipping === "Required" ||
        (product.shipping === "Optional" && p.shipping_requested);
      return createOrder(db, actor, {
        product_id: product.id,
        person_id: person.id,
        quantity: 1,
        quoted_total_cents:
          subtotal +
          (shipping ? product.shipping_cents : 0) +
          (product.taxable
            ? Math.round(
                (subtotal * commerceSettings(db, actor).tax_rate_bps) / 10000,
              )
            : 0),
        idempotency_key: crypto.randomUUID(),
        ...p,
      });
    },
  };
}
test("orders atomically reserve inventory, freeze prices, deduplicate retries and isolate organizations", () => {
  const f = fixture(),
    { db, actor, other, person } = f;
  try {
    const product = f.product({
        inventory: 2,
        description: "<script>bad()</script><p>Safe</p>",
      }),
      key = crypto.randomUUID(),
      o = f.order(product, { quantity: 2, idempotency_key: key });
    assert.equal(o.total_cents, 5000);
    assert.equal(productDetail(db, actor, product.id).inventory, 0);
    assert.equal(
      f.order(product, { quantity: 2, idempotency_key: key }).id,
      o.id,
    );
    assert.throws(
      () => f.order(product, { quantity: 1, idempotency_key: key }),
      /another order/,
    );
    assert.throws(() => f.order(product), /inventory/);
    assert.equal(db.prepare("SELECT count(*) n FROM invoices").get().n, 1);
    assert.throws(() => productDetail(db, other, product.id), /not found/);
    assert.throws(
      () =>
        createOrder(db, other, {
          product_id: product.id,
          person_id: person.id,
          quantity: 1,
          quoted_total_cents: 2500,
          idempotency_key: crypto.randomUUID(),
        }),
      /not found/,
    );
    assert.throws(
      () => saveProduct(db, actor, { ...product, name: "Changed" }, product.id),
      /changed/,
    );
    const current = productDetail(db, actor, product.id);
    saveProduct(
      db,
      actor,
      { ...current, name: "Renamed", price_cents: 6000 },
      product.id,
    );
    assert.equal(orderDetail(db, actor, o.id).product_name, "Jersey");
    assert.equal(orderDetail(db, actor, o.id).total_cents, 5000);
    assert.equal(current.description, "<p>Safe</p>");
    changeOrder(db, actor, o.id, { action: "cancel" });
    changeOrder(db, actor, o.id, { action: "cancel" });
    assert.equal(productDetail(db, actor, product.id).inventory, 2);
    assert.throws(
      () => f.order(product),
      /price, shipping charge or tax rate changed/,
    );
    assert.equal(
      db.prepare("SELECT voided FROM invoices WHERE id=?").get(o.invoice_id)
        .voided,
      1,
    );
  } finally {
    db.close();
  }
});
test("shipping and tax snapshots are invoiced; paid fulfillment cannot release stock", () => {
  const f = fixture(),
    { db, actor } = f;
  try {
    db.prepare("INSERT INTO settings VALUES('org','site','commerce',?)").run(
      JSON.stringify({ tax_rate_bps: 825 }),
    );
    const p = f.product({
      taxable: true,
      shipping: "Required",
      shipping_cents: 500,
      variants: [{ name: "Youth small", price_cents: 2500, inventory: 3 }],
    });
    assert.throws(() => f.order(p), /configuration/);
    assert.throws(
      () => f.order(p, { variant_id: p.variants[0].id }),
      /shipping address/,
    );
    const o = f.order(p, {
      variant_id: p.variants[0].id,
      quantity: 2,
      shipping_address: {
        name: "Example Member",
        address: "10 Example Road",
        city: "Example",
        state: "IL",
        postal_code: "60000",
        country: "US",
      },
    });
    assert.equal(o.tax_cents, 413);
    assert.equal(o.total_cents, 5913);
    assert.equal(productDetail(db, actor, p.id).variants[0].inventory, 1);
    assert.throws(
      () => changeOrder(db, actor, o.id, { action: "ship" }),
      /must be paid/,
    );
    recordPayment(db, actor, o.invoice_id, {
      amount_cents: 5913,
      method: "Check",
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(orderDetail(db, actor, o.id).display_status, "Open/Paid");
    assert.throws(
      () => changeOrder(db, actor, o.id, { action: "cancel" }),
      /refunded/,
    );
    assert.throws(
      () => changeOrder(db, actor, o.id, { action: "close" }),
      /shipped/,
    );
    changeOrder(db, actor, o.id, { action: "ship", tracking: "LOCAL-TEST" });
    changeOrder(db, actor, o.id, { action: "close" });
    assert.equal(orderDetail(db, actor, o.id).display_status, "Closed");
    assert.equal(productDetail(db, actor, p.id).variants[0].inventory, 1);
    assert.equal(expireOrders(db, "2099-01-01T00:00:00.000Z"), 0);
  } finally {
    db.close();
  }
});
test("expiry restores unpaid stock once, rejects late payment, and preserves partial payments", () => {
  const f = fixture(),
    { db, actor } = f;
  try {
    const p = f.product(),
      a = f.order(p),
      b = f.order(p);
    recordPayment(db, actor, b.invoice_id, {
      amount_cents: 100,
      method: "Cash",
      idempotency_key: crypto.randomUUID(),
    });
    db.prepare(
      "UPDATE product_orders SET expires_at='2000-01-01T00:00:00Z'",
    ).run();
    assert.throws(
      () =>
        recordPayment(db, actor, a.invoice_id, {
          amount_cents: 2500,
          method: "Cash",
          idempotency_key: crypto.randomUUID(),
        }),
      /expired/,
    );
    assert.equal(expireOrders(db), 1);
    assert.equal(expireOrders(db), 0);
    assert.equal(productDetail(db, actor, p.id).inventory, 4);
    assert.equal(orderDetail(db, actor, b.id).display_status, "Open/New");
    recordPayment(db, actor, b.invoice_id, {
      amount_cents: 2400,
      method: "Cash",
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(orderDetail(db, actor, b.id).display_status, "Open/Paid");
  } finally {
    db.close();
  }
});
test("registration-only products require an associated active registration and valid family purchaser", () => {
  const f = fixture(),
    { db, actor, person } = f;
  try {
    const program = saveProgram(db, actor, {
      name: "Camp",
      type: "Camp",
      sport: "Soccer",
      gender: "Co-Ed",
      level: "All",
      season: "Fall",
      start_date: "2026-10-01",
    });
    const p = f.product({
      availability: "Registration",
      program_ids: [program.id],
    });
    assert.throws(() => f.order(p), /only available/);
    assert.throws(
      () => f.order(p, { program_id: program.id }),
      /not registered/,
    );
    register(db, actor, { program_id: program.id, person_id: person.id });
    const outsider = savePerson(db, actor, {
      first_name: "Other",
      last_name: "Member",
    });
    assert.throws(
      () => f.order(p, { program_id: program.id, purchaser_id: outsider.id }),
      /supervisor/,
    );
    const o = f.order(p, { program_id: program.id });
    assert.equal(o.program_id, program.id);
  } finally {
    db.close();
  }
});

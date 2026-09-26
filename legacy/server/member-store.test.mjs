import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import {
  savePerson,
  saveHousehold,
  linkHouseholdMember,
} from "./directory.mjs";
import { saveProduct, productDetail } from "./commerce.mjs";
import {
  memberStoreRecipients,
  quoteMemberCart,
  submitMemberCart,
  memberStoreOrders,
  memberCheckoutReceipt,
  memberStoreOrderDetails,
} from "./member-store.mjs";
import { makeApp } from "./app.mjs";

test("member checkout is atomic, rejects stale quotes, and safely retries exhausted inventory", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO organizations(id,name) VALUES('one','One')").run();
  const actor = { id: "admin", org_id: "one" };
  const person = savePerson(db, actor, {
    first_name: "Buyer",
    last_name: "Example",
  });
  const account = { id: "buyer-account", org_id: "one", person_id: person.id };
  const a = saveProduct(db, actor, {
    name: "Ball",
    availability: "Store",
    price_cents: 1000,
    inventory: 1,
  });
  const b = saveProduct(db, actor, {
    name: "Shirt",
    availability: "Store",
    price_cents: 2000,
    inventory: 1,
    shipping: "Required",
  });
  const cart = {
    person_id: person.id,
    lines: [
      { product_id: a.id, quantity: 1 },
      { product_id: b.id, quantity: 1 },
    ],
  };
  const request = {
    ...cart,
    quote_digest: quoteMemberCart(db, account, cart).quote_digest,
    idempotency_key: "checkout-test-1",
  };
  try {
    assert.throws(
      () => submitMemberCart(db, account, request),
      /shipping address/i,
    );
    for (const table of ["product_orders", "invoices", "member_checkouts"])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    assert.equal(productDetail(db, actor, a.id).inventory, 1);
    const shipped = {
      ...request,
      shipping_address: {
        name: "Buyer Example",
        address: "1 Test Street",
        city: "Test",
        state: "LA",
        postal_code: "70000",
        country: "US",
      },
    };
    db.prepare("UPDATE products SET price_cents=1100 WHERE id=?").run(a.id);
    assert.throws(
      () => submitMemberCart(db, account, shipped),
      /cart changed/i,
    );
    shipped.quote_digest = quoteMemberCart(db, account, cart).quote_digest;
    const receipt = submitMemberCart(db, account, shipped);
    assert.equal(receipt.orders.length, 2);
    const history = memberStoreOrders(db, account);
    const shippingDetails = memberStoreOrderDetails(db, account, receipt.orders[1].id);
    assert.equal(shippingDetails.shipping_address.address, "1 Test Street");
    assert.equal("request_hash" in shippingDetails, false);
    assert.deepEqual(memberCheckoutReceipt(db, account, shipped.idempotency_key), {receipt});
    assert.deepEqual(memberCheckoutReceipt(db, {...account,id:"different-account"}, shipped.idempotency_key), {receipt:null});
    assert.deepEqual(memberCheckoutReceipt(db, account, "unknown-checkout"), {receipt:null});
    assert.equal(history.length, 2);
    assert.equal(history[0].balance_cents > 0, true);
    assert.equal("shipping_address" in history[0], false);
    assert.equal("request_hash" in history[0], false);
    const other = savePerson(db, actor, {
      first_name: "Other",
      last_name: "Buyer",
    });
    assert.throws(() => memberStoreOrderDetails(db,{...account,person_id:other.id},receipt.orders[1].id), /Order not found/);
    assert.deepEqual(
      memberStoreOrders(db, {
        ...account,
        id: "other-account",
        person_id: other.id,
      }),
      [],
    );
    assert.equal(receipt.total_cents, 3100);
    assert.equal(receipt.payment_processed, false);
    assert.equal(productDetail(db, actor, a.id).inventory, 0);
    assert.deepEqual(submitMemberCart(db, account, shipped), receipt);
    assert.equal(
      db.prepare("SELECT count(*) n FROM product_orders").get().n,
      2,
    );
    assert.throws(
      () =>
        submitMemberCart(db, account, { ...shipped, lines: [cart.lines[0]] }),
      /different cart/,
    );
  } finally {
    db.close();
  }
});

test("member cart quotes enforce family eligibility and current product prices without reserving stock", async () => {
  const db = openDb(":memory:");
  for (const org of ["one", "two"])
    db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(org, org);
  const actor = { id: "admin", org_id: "one" };
  const person = (name) =>
    savePerson(db, actor, { first_name: name, last_name: "Example" });
  const parent = person("Parent"),
    child = person("Child"),
    otherParent = person("Other parent"),
    unrelated = person("Unrelated");
  const family = saveHousehold(db, actor, { name: "Family" });
  for (const [p, role] of [
    [parent, "Supervisor"],
    [child, "Member"],
    [otherParent, "Supervisor"],
  ])
    linkHouseholdMember(db, actor, family.id, { person_id: p.id, role });
  const account = { id: "account", org_id: "one", person_id: parent.id };
  db.prepare("INSERT INTO settings VALUES(?,'site','commerce',?)").run(
    "one",
    JSON.stringify({ tax_rate_bps: 825 }),
  );
  const product = saveProduct(db, actor, {
    name: "Shirt",
    availability: "Store",
    price_cents: 1000,
    inventory: 5,
    taxable: true,
    shipping: "Required",
    shipping_cents: 500,
  });
  const variantProduct = saveProduct(db, actor, {
    name: "Jersey",
    availability: "Store",
    price_cents: 100,
    shipping: "Optional",
    shipping_cents: 250,
    variants: [{ name: "Large", price_cents: 2500, inventory: 2 }],
  });
  const line = { product_id: product.id, quantity: 2 };
  const input = {
    person_id: child.id,
    lines: [line],
    purchaser_id: unrelated.id,
    total_cents: 1,
  };
  try {
    assert.deepEqual(
      new Set(memberStoreRecipients(db, account).map((p) => p.id)),
      new Set([parent.id, child.id]),
    );
    const quote = quoteMemberCart(db, account, input);
    assert.equal(quote.purchaser_id, parent.id);
    assert.equal(quote.subtotal_cents, 2000);
    assert.equal(quote.tax_cents, 165);
    assert.equal(quote.shipping_cents, 500);
    assert.equal(quote.total_cents, 2665);
    assert.equal(productDetail(db, actor, product.id).inventory, 5);
    assert.equal(
      db.prepare("SELECT count(*) n FROM product_orders").get().n,
      0,
    );
    for (const target of [unrelated.id, otherParent.id])
      assert.throws(
        () => quoteMemberCart(db, account, { ...input, person_id: target }),
        /your family/,
      );
    assert.throws(
      () => quoteMemberCart(db, account, { ...input, lines: [line, line] }),
      /duplicate/,
    );
    assert.throws(
      () =>
        quoteMemberCart(db, account, {
          ...input,
          lines: [{ ...line, quantity: 6 }],
        }),
      /inventory/,
    );
    assert.throws(() =>
      quoteMemberCart(db, account, {
        ...input,
        lines: [{ ...line, quantity: 0 }],
      }),
    );
    assert.throws(
      () =>
        quoteMemberCart(db, account, {
          ...input,
          lines: [{ product_id: variantProduct.id, quantity: 1 }],
        }),
      /configuration/,
    );
    const variantLine = {
      product_id: variantProduct.id,
      variant_id: variantProduct.variants[0].id,
      quantity: 2,
      shipping_requested: true,
    };
    assert.equal(
      quoteMemberCart(db, account, { ...input, lines: [line, variantLine] })
        .total_cents,
      7915,
    );
    db.prepare("UPDATE products SET price_cents=2000 WHERE id=?").run(
      product.id,
    );
    assert.equal(quoteMemberCart(db, account, input).total_cents, 4830);
    for (const availability of ["Private", "Registration"]) {
      db.prepare("UPDATE products SET availability=? WHERE id=?").run(
        availability,
        product.id,
      );
      assert.throws(() => quoteMemberCart(db, account, input), /not available/);
    }
    db.prepare(
      "UPDATE products SET availability='Store',published=0 WHERE id=?",
    ).run(product.id);
    assert.throws(() => quoteMemberCart(db, account, input), /not available/);
    const foreign = saveProduct(
      db,
      { id: "other", org_id: "two" },
      { name: "Other", availability: "Store", price_cents: 100 },
    );
    assert.throws(
      () =>
        quoteMemberCart(db, account, {
          ...input,
          lines: [{ product_id: foreign.id, quantity: 1 }],
        }),
      /not found/,
    );
    const server = makeApp(db).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const root = `http://127.0.0.1:${server.address().port}/api/public/sites/one/store`;
      assert.equal((await fetch(root + "/recipients")).status, 401);
      assert.equal(
        (
          await fetch(root + "/quote", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Fieldhouse-Request": "1",
            },
            body: JSON.stringify(input),
          })
        ).status,
        401,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    db.close();
  }
});

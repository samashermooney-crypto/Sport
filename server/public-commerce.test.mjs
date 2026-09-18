import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.mjs";
import { makeApp } from "./app.mjs";
import { saveProduct } from "./commerce.mjs";

test("anonymous storefront exposes only published store products and their authorized images", async () => {
  const db = openDb(":memory:");
  for (const org of ["one", "two"])
    db.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").run(org, org);
  const actor = { id: "admin", org_id: "one" };
  for (const asset of ["visible", "private"])
    db.prepare("INSERT INTO assets VALUES(?,?,?,?,?)").run(
      asset,
      "one",
      "image/png",
      Buffer.from("image"),
      new Date().toISOString(),
    );
  const create = (name, options = {}) =>
    saveProduct(db, actor, {
      name,
      price_cents: 2500,
      availability: "Store",
      ...options,
    });
  const visible = create("Public shirt", {
    image_id: "visible",
    receipt_message: "Internal receipt",
    variants: [{ name: "Large", price_cents: 3000, inventory: 2 }],
  });
  const privateProduct = create("Private", {
    availability: "Private",
    image_id: "private",
  });
  create("Registration", { availability: "Registration" });
  create("Draft", { published: false });
  const archived = create("Archived");
  db.prepare("UPDATE products SET archived_at=? WHERE id=?").run(
    new Date().toISOString(),
    archived.id,
  );
  saveProduct(
    db,
    { id: "other", org_id: "two" },
    { name: "Foreign", price_cents: 123, availability: "Store" },
  );
  db.prepare("INSERT INTO store_categories VALUES(?,?,?,?,?)").run(
    "category",
    "one",
    "Clothing",
    "Club clothing",
    0,
  );
  for (const [index, product] of [visible, privateProduct].entries())
    db.prepare("INSERT INTO category_products VALUES(?,?,?)").run(
      "category",
      product.id,
      index,
    );
  const server = makeApp(db).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(root + "/api/public/sites/one/store");
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.deepEqual(
      catalog.products.map((p) => p.name),
      ["Public shirt"],
    );
    assert.equal(catalog.products[0].variants[0].price_cents, 3000);
    assert.equal("receipt_message" in catalog.products[0], false);
    assert.equal("last_order_at" in catalog.products[0], false);
    assert.deepEqual(catalog.categories[0].product_ids, [visible.id]);
    assert.equal((await fetch(root + "/api/products")).status, 401);
    assert.equal(
      (await fetch(root + "/api/public/sites/missing/store")).status,
      404,
    );
    assert.equal(
      (await fetch(root + "/api/public/sites/one/store/images/visible")).status,
      200,
    );
    assert.equal(
      (await fetch(root + "/api/public/sites/one/store/images/private")).status,
      404,
    );
    assert.equal(
      (await fetch(root + "/api/public/sites/two/store/images/visible")).status,
      404,
    );
    db.prepare("UPDATE products SET published=0 WHERE id=?").run(visible.id);
    assert.equal(
      (await fetch(root + "/api/public/sites/one/store/images/visible")).status,
      404,
    );
    const unpublished = await (
      await fetch(root + "/api/public/sites/one/store")
    ).json();
    assert.equal(unpublished.products.length, 0);
    assert.deepEqual(unpublished.categories[0].product_ids, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

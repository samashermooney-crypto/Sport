import { productDetail } from "./commerce.mjs";
import { DomainError } from "./domain.mjs";

export function publicCatalog(db, org) {
  if (!db.prepare("SELECT 1 FROM organizations WHERE id=?").get(org))
    throw new DomainError("Store not found", 404);
  const products = db
    .prepare(
      "SELECT id FROM products WHERE org_id=? AND published=1 AND availability='Store' AND archived_at IS NULL ORDER BY created_at DESC",
    )
    .all(org)
    .map(({ id }) => {
      const p = productDetail(db, { org_id: org }, id);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        image_id: p.image_id,
        price_cents: p.price_cents,
        inventory: p.inventory,
        shipping: p.shipping,
        variants: p.variants.map((v) => ({
          id: v.id,
          name: v.name,
          price_cents: v.price_cents,
          inventory: v.inventory,
        })),
      };
    });
  const visible = new Set(products.map((p) => p.id));
  const categories = db
    .prepare(
      "SELECT id,name,description FROM store_categories WHERE org_id=? ORDER BY position,name",
    )
    .all(org)
    .map((c) => ({
      ...c,
      product_ids: db
        .prepare(
          "SELECT product_id FROM category_products WHERE category_id=? ORDER BY position",
        )
        .all(c.id)
        .map((p) => p.product_id)
        .filter((id) => visible.has(id)),
    }));
  return { products, categories };
}

export function installPublicCommerceRoutes(app, db) {
  app.get("/api/public/sites/:org/store", (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json(publicCatalog(db, req.params.org));
  });
  app.get("/api/public/sites/:org/store/images/:id", (req, res) => {
    const referenced = db
      .prepare(
        "SELECT 1 FROM products WHERE org_id=? AND published=1 AND availability='Store' AND archived_at IS NULL AND json_extract(data,'$.image_id')=?",
      )
      .get(req.params.org, req.params.id);
    const asset =
      referenced &&
      db
        .prepare("SELECT mime,bytes FROM assets WHERE org_id=? AND id=?")
        .get(req.params.org, req.params.id);
    if (!asset) throw new DomainError("Image not found", 404);
    res
      .set("Cache-Control", "no-store")
      .set("Content-Security-Policy", "default-src 'none'")
      .type(asset.mime)
      .send(Buffer.from(asset.bytes));
  });
}

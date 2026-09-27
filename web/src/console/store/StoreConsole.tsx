import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import {
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
} from '../../ui';
import type { Column } from '../../ui';

import './store.css';

const categorySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  version: z.number().int().positive(),
});
const categoriesSchema = z.strictObject({
  categories: z.array(categorySchema),
});
const variantSchema = z.strictObject({
  id: z.uuid(),
  sku: z.string(),
  size: z.string().nullable(),
  color: z.string().nullable(),
  priceCents: z.number().int().nonnegative(),
  taxRateId: z.uuid().nullable(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  lowStockThreshold: z.number().int().nullable(),
});
const productSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  categoryId: z.uuid().nullable(),
  categoryName: z.string().nullable(),
  kind: z.enum(['uniform', 'spirit_wear', 'other']),
  requiredForRegistration: z.boolean(),
  active: z.boolean(),
  variants: z.array(variantSchema),
});
const productsSchema = z.strictObject({ products: z.array(productSchema) });
const reportSchema = z.strictObject({
  rows: z.array(
    z.strictObject({
      teamSeasonId: z.uuid().nullable(),
      productName: z.string(),
      size: z.string().nullable(),
      quantity: z.number().int().nonnegative(),
    }),
  ),
});
type Product = z.output<typeof productSchema>;
type ReportRow = z.output<(typeof reportSchema.shape.rows)['element']>;

export function StoreConsole({ orgId }: { orgId: string }): React.JSX.Element {
  const base = `/store/orgs/${encodeURIComponent(orgId)}`;
  const [categories, setCategories] = useState<
    z.output<typeof categorySchema>[]
  >([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [categoryName, setCategoryName] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'uniform' | 'spirit_wear' | 'other'>(
    'uniform',
  );
  const [categoryId, setCategoryId] = useState('');
  const [sku, setSku] = useState('');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [required, setRequired] = useState(false);
  const [stockVariantId, setStockVariantId] = useState('');
  const [stockQuantity, setStockQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [categoryResult, productResult, reportResult] = await Promise.all([
        apiGet(`${base}/categories`, categoriesSchema),
        apiGet(`${base}/products`, productsSchema),
        apiGet(`${base}/uniform-size-report`, reportSchema),
      ]);
      setCategories(categoryResult.categories);
      setProducts(productResult.products);
      setReport(reportResult.rows);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Store data is unavailable.',
      );
    }
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const variants = useMemo(
    () =>
      products.flatMap((product) =>
        product.variants.map((variant) => ({
          ...variant,
          productName: product.name,
        })),
      ),
    [products],
  );
  const reportRows = report.map((row, index) => ({
    ...row,
    id: String(index),
  }));
  const productColumns: Column<Product>[] = [
    { key: 'name', label: 'Product', sort: (product) => product.name },
    {
      key: 'category',
      label: 'Category',
      render: (product) => product.categoryName ?? 'Uncategorized',
    },
    {
      key: 'kind',
      label: 'Type',
      render: (product) => product.kind.replace('_', ' '),
    },
    {
      key: 'sizes',
      label: 'Sizes',
      render: (product) =>
        product.variants
          .map((variant) => variant.size ?? variant.sku)
          .join(', '),
    },
    {
      key: 'available',
      label: 'Available',
      render: (product) =>
        product.variants.reduce((sum, variant) => sum + variant.available, 0),
    },
  ];
  const reportColumns: Column<ReportRow>[] = [
    { key: 'product', label: 'Uniform', render: (row) => row.productName },
    {
      key: 'size',
      label: 'Size',
      render: (row) => row.size ?? 'No size recorded',
    },
    {
      key: 'quantity',
      label: 'Total',
      render: (row) => row.quantity,
      sort: (row) => row.quantity,
    },
  ];

  async function submitCategory(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/categories`,
        { name: categoryName, sortOrder: categories.length },
        categorySchema,
      );
      setCategoryName('');
      setNotice('Category created.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Category could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitProduct(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/products`,
        {
          name,
          categoryId: categoryId || null,
          kind,
          requiredForRegistration: required,
          variants: [
            {
              sku,
              size: size || null,
              priceCents: Math.round(Number(price) * 100),
            },
          ],
        },
        productSchema,
      );
      setName('');
      setSku('');
      setSize('');
      setPrice('');
      setNotice('Product created.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Product could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitStock(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!stockVariantId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/variants/${encodeURIComponent(stockVariantId)}/stock-receipts`,
        {
          quantity: Number(stockQuantity),
          memo: 'Stock received in store console',
        },
        z.strictObject({ id: z.uuid() }),
      );
      setStockQuantity('');
      setNotice('Inventory received.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Inventory could not be received.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-home store-console">
      <PageHeader
        kicker="STORE & UNIFORMS"
        title="Store inventory"
        description="Manage product sizes, stock and the uniform report for registrations."
      />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="store-console__forms">
        <Card>
          <h2>Product categories</h2>
          <form onSubmit={(event) => void submitCategory(event)}>
            <Field label="Category name" required>
              <Input
                value={categoryName}
                onChange={(event) => {
                  setCategoryName(event.target.value);
                }}
                maxLength={100}
                required
              />
            </Field>
            <Button disabled={busy || !categoryName.trim()}>
              Add category
            </Button>
          </form>
          <ul aria-label="Product categories">
            {categories
              .filter((category) => !category.archivedAt)
              .map((category) => (
                <li key={category.id}>{category.name}</li>
              ))}
          </ul>
        </Card>
        <Card>
          <h2>New product</h2>
          <form onSubmit={(event) => void submitProduct(event)}>
            <Field label="Product name" required>
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                maxLength={160}
                required
              />
            </Field>
            <Field label="Category">
              <Select
                aria-label="Category"
                value={categoryId}
                onChange={(event) => {
                  setCategoryId(event.target.value);
                }}
              >
                <option value="">Uncategorized</option>
                {categories
                  .filter((category) => !category.archivedAt)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Product type">
              <Select
                aria-label="Product type"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as typeof kind);
                }}
              >
                <option value="uniform">Uniform</option>
                <option value="spirit_wear">Spirit wear</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="SKU" required>
              <Input
                value={sku}
                onChange={(event) => {
                  setSku(event.target.value);
                }}
                maxLength={80}
                required
              />
            </Field>
            <Field label="Size">
              <Input
                value={size}
                onChange={(event) => {
                  setSize(event.target.value);
                }}
                maxLength={40}
              />
            </Field>
            <Field label="Price in dollars" required>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(event) => {
                  setPrice(event.target.value);
                }}
                required
              />
            </Field>
            <label className="store-console__check">
              <input
                type="checkbox"
                checked={required}
                onChange={(event) => {
                  setRequired(event.target.checked);
                }}
              />{' '}
              Required for registration
            </label>
            <Button disabled={busy}>Create product</Button>
          </form>
        </Card>
        <Card>
          <h2>Receive inventory</h2>
          <form onSubmit={(event) => void submitStock(event)}>
            <Field label="Product size" required>
              <Select
                aria-label="Product size"
                value={stockVariantId}
                onChange={(event) => {
                  setStockVariantId(event.target.value);
                }}
              >
                <option value="">Choose a product size</option>
                {variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.productName} · {variant.size ?? variant.sku} ·{' '}
                    {variant.available} available
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quantity" required>
              <Input
                type="number"
                min="1"
                max="10000"
                step="1"
                value={stockQuantity}
                onChange={(event) => {
                  setStockQuantity(event.target.value);
                }}
                required
              />
            </Field>
            <Button disabled={busy || !stockVariantId}>Receive stock</Button>
          </form>
        </Card>
      </div>
      <Card>
        <h2>Products</h2>
        <DataTable
          rows={products}
          columns={productColumns}
          empty="No products have been added."
        />
      </Card>
      <Card>
        <h2>Uniform size report</h2>
        <DataTable
          rows={reportRows}
          columns={reportColumns}
          empty="No paid uniform selections yet."
        />
      </Card>
    </main>
  );
}

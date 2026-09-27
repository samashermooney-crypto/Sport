import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
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
const ordersSchema = z.strictObject({
  orders: z.array(
    z.strictObject({
      id: z.uuid(),
      status: z.enum([
        'draft',
        'awaiting_payment',
        'paid',
        'fulfilling',
        'fulfilled',
        'canceled',
        'refunded',
      ]),
      invoiceId: z.uuid().nullable(),
      subtotalCents: z.number().int().nonnegative(),
      taxCents: z.number().int().nonnegative(),
      createdAt: z.iso.datetime({ offset: true }),
      buyerEmail: z.string().nullable(),
      shippingAddress: z
        .strictObject({
          line1: z.string(),
          line2: z.string().optional(),
          city: z.string(),
          region: z.string(),
          postalCode: z.string(),
          country: z.literal('US'),
        })
        .nullable(),
      fulfillment: z
        .strictObject({
          orderId: z.uuid(),
          method: z.enum(['pickup', 'ship']),
          status: z.enum([
            'pending',
            'ready',
            'shipped',
            'picked_up',
            'canceled',
          ]),
          trackingNumber: z.string().nullable(),
          version: z.number().int().positive(),
        })
        .nullable(),
    }),
  ),
});
const fulfillmentResultSchema = z.strictObject({
  orderId: z.uuid(),
  method: z.enum(['pickup', 'ship']),
  status: z.enum(['pending', 'ready', 'shipped', 'picked_up', 'canceled']),
  trackingNumber: z.string().nullable(),
  version: z.number().int().positive(),
});
const registrationAddOnSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  productName: z.string(),
  kind: z.enum(['uniform', 'spirit_wear', 'other']),
  required: z.boolean(),
  quantity: z.number().int().positive(),
  version: z.number().int().positive(),
  variants: z.array(
    z.strictObject({
      id: z.uuid(),
      sku: z.string(),
      size: z.string().nullable(),
      color: z.string().nullable(),
      priceCents: z.number().int().nonnegative(),
      available: z.number().int().nonnegative(),
    }),
  ),
});
const registrationAddOnsSchema = z.strictObject({
  addons: z.array(registrationAddOnSchema),
});
const savedAddOnSchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
});
type Product = z.output<typeof productSchema>;
type ReportRow = z.output<(typeof reportSchema.shape.rows)['element']>;
type Category = z.output<typeof categorySchema>;
type StoreOrder = z.output<(typeof ordersSchema.shape.orders)['element']>;
type RegistrationAddOn = z.output<typeof registrationAddOnSchema>;

export function StoreConsole({ orgId }: { orgId: string }): React.JSX.Element {
  const base = `/store/orgs/${encodeURIComponent(orgId)}`;
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [registrationAddOns, setRegistrationAddOns] = useState<
    RegistrationAddOn[]
  >([]);
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
  const [lowStockThreshold, setLowStockThreshold] = useState('');
  const [stockVariantId, setStockVariantId] = useState('');
  const [stockQuantity, setStockQuantity] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [offeringId, setOfferingId] = useState('');
  const [addOnProductId, setAddOnProductId] = useState('');
  const [addOnQuantity, setAddOnQuantity] = useState('1');
  const [addOnRequired, setAddOnRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [categoryResult, productResult, reportResult, orderResult] =
        await Promise.all([
          apiGet(`${base}/categories`, categoriesSchema),
          apiGet(`${base}/products`, productsSchema),
          apiGet(`${base}/uniform-size-report`, reportSchema),
          apiGet(`${base}/orders`, ordersSchema),
        ]);
      setCategories(categoryResult.categories);
      setProducts(productResult.products);
      setReport(reportResult.rows);
      setOrders(orderResult.orders);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Store data is unavailable.',
      );
    }
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const refreshAddOns = useCallback(async () => {
    if (!z.uuid().safeParse(offeringId).success) {
      setRegistrationAddOns([]);
      return;
    }
    try {
      const result = await apiGet(
        `${base}/offerings/${encodeURIComponent(offeringId)}/add-ons`,
        registrationAddOnsSchema,
      );
      setRegistrationAddOns(result.addons);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Registration add-ons are unavailable.',
      );
    }
  }, [base, offeringId]);
  useEffect(() => {
    void refreshAddOns();
  }, [refreshAddOns]);

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
              lowStockThreshold: lowStockThreshold
                ? Number(lowStockThreshold)
                : null,
            },
          ],
        },
        productSchema,
      );
      setName('');
      setSku('');
      setSize('');
      setPrice('');
      setLowStockThreshold('');
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

  async function archiveCategory(category: Category): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `${base}/categories/${encodeURIComponent(category.id)}`,
        { archived: true, expectedVersion: category.version },
        categorySchema,
      );
      setNotice(`${category.name} archived.`);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Category could not be archived.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateOrder(order: StoreOrder): Promise<void> {
    if (!order.fulfillment) return;
    const nextStatus =
      order.fulfillment.method === 'pickup'
        ? order.fulfillment.status === 'pending'
          ? 'ready'
          : 'picked_up'
        : 'shipped';
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `${base}/orders/${encodeURIComponent(order.id)}/fulfillment`,
        {
          status: nextStatus,
          ...(nextStatus === 'shipped' && trackingNumber
            ? { trackingNumber }
            : {}),
          expectedVersion: order.fulfillment.version,
        },
        fulfillmentResultSchema,
      );
      setTrackingNumber('');
      setNotice(
        `Order fulfillment updated to ${nextStatus.replaceAll('_', ' ')}.`,
      );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Order fulfillment could not be updated.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveAddOn(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!z.uuid().safeParse(offeringId).success || !addOnProductId) return;
    const existing = registrationAddOns.find(
      (item) => item.productId === addOnProductId,
    );
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/offerings/${encodeURIComponent(offeringId)}/add-ons`,
        {
          productId: addOnProductId,
          required: addOnRequired,
          quantity: Number(addOnQuantity),
          active: true,
          ...(existing ? { expectedVersion: existing.version } : {}),
        },
        savedAddOnSchema,
      );
      setNotice('Registration add-on saved.');
      await refreshAddOns();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Registration add-on could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeAddOn(addon: RegistrationAddOn): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/offerings/${encodeURIComponent(offeringId)}/add-ons`,
        {
          productId: addon.productId,
          required: addon.required,
          quantity: addon.quantity,
          active: false,
          expectedVersion: addon.version,
        },
        savedAddOnSchema,
      );
      setNotice(`${addon.productName} removed from this offering.`);
      await refreshAddOns();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Registration add-on could not be removed.',
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
                <li key={category.id}>
                  <span>{category.name}</span>
                  <Button
                    type="button"
                    secondary
                    disabled={busy}
                    onClick={() => {
                      void archiveCategory(category);
                    }}
                  >
                    Archive
                  </Button>
                </li>
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
            <Field label="Low-stock alert threshold">
              <Input
                type="number"
                min="0"
                step="1"
                value={lowStockThreshold}
                onChange={(event) => {
                  setLowStockThreshold(event.target.value);
                }}
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
      <Card>
        <h2>Registration uniform and spirit-wear options</h2>
        <div className="store-console__addon-controls">
          <Field
            label="Registration offering ID"
            hint="Use the offering ID from its registration details."
          >
            <Input
              value={offeringId}
              onChange={(event) => {
                setOfferingId(event.target.value);
              }}
              pattern="[0-9a-fA-F-]{36}"
            />
          </Field>
          <form
            onSubmit={(event) => {
              void saveAddOn(event);
            }}
          >
            <Field label="Store product">
              <Select
                value={addOnProductId}
                onChange={(event) => {
                  setAddOnProductId(event.target.value);
                }}
              >
                <option value="">
                  Choose a uniform or spirit-wear product
                </option>
                {products
                  .filter(
                    (product) =>
                      product.kind === 'uniform' ||
                      product.kind === 'spirit_wear',
                  )
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                      {product.requiredForRegistration ? ' · required' : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Quantity per registrant">
              <Input
                type="number"
                min="1"
                max="100"
                value={addOnQuantity}
                onChange={(event) => {
                  setAddOnQuantity(event.target.value);
                }}
                required
              />
            </Field>
            <label className="store-console__check">
              <input
                type="checkbox"
                checked={addOnRequired}
                onChange={(event) => {
                  setAddOnRequired(event.target.checked);
                }}
              />{' '}
              Required for registration
            </label>
            <Button
              disabled={
                busy ||
                !z.uuid().safeParse(offeringId).success ||
                !addOnProductId
              }
            >
              Save registration option
            </Button>
          </form>
        </div>
        <ul
          className="store-console__orders"
          aria-label="Registration store options"
        >
          {registrationAddOns.map((addon) => (
            <li key={addon.id}>
              <div>
                <strong>
                  {addon.productName} ·{' '}
                  {addon.required ? 'required' : 'optional'} × {addon.quantity}
                </strong>
                <span>
                  {addon.variants
                    .map(
                      (variant) =>
                        `${variant.size ?? variant.sku}: ${String(variant.available)} available`,
                    )
                    .join(' · ')}
                </span>
              </div>
              <Button
                secondary
                disabled={busy}
                onClick={() => {
                  void removeAddOn(addon);
                }}
              >
                Remove option
              </Button>
            </li>
          ))}
          {z.uuid().safeParse(offeringId).success &&
          registrationAddOns.length === 0 ? (
            <li>No registration store options configured.</li>
          ) : null}
        </ul>
      </Card>
      <Card>
        <h2>Order fulfillment</h2>
        {orders.some(
          (order) =>
            order.status === 'paid' && order.fulfillment?.method === 'ship',
        ) ? (
          <Field label="Shipment tracking number">
            <Input
              value={trackingNumber}
              onChange={(event) => {
                setTrackingNumber(event.target.value);
              }}
              maxLength={120}
            />
          </Field>
        ) : null}
        <ul className="store-console__orders" aria-label="Store orders">
          {orders.map((order) => (
            <li key={order.id}>
              <div>
                <strong>
                  Order {order.id.slice(0, 8)} · {order.buyerEmail ?? 'Family'}
                </strong>
                <span>
                  {order.status} · $
                  {((order.subtotalCents + order.taxCents) / 100).toFixed(2)}
                </span>
                <span>
                  {order.fulfillment?.method ?? '—'} ·{' '}
                  {order.fulfillment?.status ?? 'pending'}
                </span>
                {order.fulfillment?.method === 'ship' &&
                order.shippingAddress ? (
                  <span>
                    Ship to: {order.shippingAddress.line1}
                    {order.shippingAddress.line2
                      ? `, ${order.shippingAddress.line2}`
                      : ''}
                    , {order.shippingAddress.city},{' '}
                    {order.shippingAddress.region}{' '}
                    {order.shippingAddress.postalCode}
                  </span>
                ) : null}
              </div>
              {(order.status === 'paid' || order.status === 'fulfilling') &&
              order.fulfillment ? (
                <Button
                  disabled={
                    busy ||
                    (order.fulfillment.method === 'ship' &&
                      order.status === 'paid' &&
                      !trackingNumber.trim())
                  }
                  onClick={() => {
                    void updateOrder(order);
                  }}
                >
                  {order.fulfillment.method === 'pickup'
                    ? order.fulfillment.status === 'pending'
                      ? 'Ready for pickup'
                      : 'Mark picked up'
                    : 'Mark shipped'}
                </Button>
              ) : null}
            </li>
          ))}
          {orders.length === 0 ? <li>No store orders to fulfill.</li> : null}
        </ul>
      </Card>
    </main>
  );
}

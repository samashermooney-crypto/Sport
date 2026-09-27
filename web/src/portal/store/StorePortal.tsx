import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Button, Card, Field, Input, PageHeader, Select } from '../../ui';

import './store-portal.css';

const uuid = z.uuid();
const productSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  categoryId: uuid.nullable(),
  categoryName: z.string().nullable(),
  kind: z.enum(['uniform', 'spirit_wear', 'other']),
  requiredForRegistration: z.boolean(),
  active: z.boolean(),
  variants: z.array(
    z.strictObject({
      id: uuid,
      sku: z.string(),
      size: z.string().nullable(),
      color: z.string().nullable(),
      priceCents: z.number().int().nonnegative(),
      taxRateId: uuid.nullable(),
      onHand: z.number().int(),
      reserved: z.number().int(),
      available: z.number().int(),
      lowStockThreshold: z.number().int().nullable(),
    }),
  ),
});
const productsSchema = z.strictObject({ products: z.array(productSchema) });
const householdsSchema = z.strictObject({
  households: z.array(
    z.strictObject({
      id: uuid,
      personIds: z.array(uuid),
      people: z.array(z.strictObject({ id: uuid, name: z.string() })),
    }),
  ),
});
const orderSchema = z.strictObject({
  id: uuid,
  status: z.enum([
    'draft',
    'awaiting_payment',
    'paid',
    'fulfilling',
    'fulfilled',
    'canceled',
    'refunded',
  ]),
  invoiceId: uuid.nullable(),
  subtotalCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
});
const myOrdersSchema = z.strictObject({
  orders: z.array(
    orderSchema.extend({
      fulfillment: z
        .strictObject({
          method: z.enum(['pickup', 'ship']),
          status: z
            .enum(['pending', 'ready', 'shipped', 'picked_up', 'canceled'])
            .nullable(),
          trackingNumber: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
type Product = z.output<typeof productSchema>;
type Order = z.output<typeof myOrdersSchema>['orders'][number];
type Household = z.output<typeof householdsSchema>['households'][number];

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export function StorePortal({ orgId }: { orgId: string }): React.JSX.Element {
  const base = `/store/orgs/${encodeURIComponent(orgId)}`;
  const [products, setProducts] = useState<Product[]>([]);
  const [households, setHouseholds] = useState<Household[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [householdId, setHouseholdId] = useState('');
  const [personId, setPersonId] = useState('');
  const [fulfillmentMethod, setFulfillmentMethod] = useState<'pickup' | 'ship'>(
    'pickup',
  );
  const [shippingAddress, setShippingAddress] = useState({
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
  });
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selectedHousehold = households.find((item) => item.id === householdId);
  const cart = useMemo(
    () =>
      Object.entries(quantities)
        .filter(([, quantity]) => quantity > 0)
        .map(([productId, quantity]) => ({
          productId,
          quantity,
          variantId: variants[productId] ?? '',
        }))
        .filter((item) => item.variantId),
    [quantities, variants],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [productResult, householdResult, orderResult] = await Promise.all([
        apiGet(`${base}/products`, productsSchema),
        apiGet(
          `/volunteers/orgs/${encodeURIComponent(orgId)}/me/households`,
          householdsSchema,
        ),
        apiGet(`${base}/me/orders`, myOrdersSchema),
      ]);
      setProducts(productResult.products);
      setHouseholds(householdResult.households);
      setOrders(orderResult.orders);
      setHouseholdId((current) =>
        householdResult.households.some((item) => item.id === current)
          ? current
          : (householdResult.households[0]?.id ?? ''),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Store data is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [base, orgId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (selectedHousehold && !selectedHousehold.personIds.includes(personId))
      setPersonId(selectedHousehold.people[0]?.id ?? '');
  }, [personId, selectedHousehold]);

  async function placeOrder(): Promise<void> {
    if (!householdId || !personId || !cart.length) return;
    if (
      fulfillmentMethod === 'ship' &&
      (!shippingAddress.line1.trim() ||
        !shippingAddress.city.trim() ||
        !/^[A-Z]{2}$/.test(shippingAddress.region) ||
        !/^\d{5}(?:-\d{4})?$/.test(shippingAddress.postalCode.trim()))
    ) {
      setError('Enter a valid US shipping address before ordering.');
      return;
    }
    const selected = new Map(products.map((product) => [product.id, product]));
    const lines = cart.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
      personId,
    }));
    if (
      lines.some((line) => {
        const product = selected.get(
          cart.find((item) => item.variantId === line.variantId)?.productId ??
            '',
        );
        const variant = product?.variants.find(
          (item) => item.id === line.variantId,
        );
        return !variant || variant.available < line.quantity;
      })
    ) {
      setError('Inventory changed. Refresh the store before ordering.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const idempotencyKey = crypto.randomUUID();
      const order = await apiPost(
        `${base}/orders`,
        {
          householdId,
          fulfillmentMethod,
          ...(fulfillmentMethod === 'ship'
            ? {
                shippingAddress: {
                  ...shippingAddress,
                  line2: shippingAddress.line2.trim() || undefined,
                  country: 'US' as const,
                },
              }
            : {}),
          idempotencyKey,
          lines,
        },
        orderSchema,
        idempotencyKey,
      );
      setQuantities({});
      setNotice(
        `Order created. ${money(order.subtotalCents + order.taxCents)} is due on the invoice.`,
      );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Store order could not be placed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-home store-portal">
      <PageHeader
        kicker="TEAM STORE"
        title="Uniforms and spirit wear"
        description="Choose a family member and size. Inventory is reserved when you place your invoice-backed order."
      />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading ? <p role="status">Loading available sizes…</p> : null}
      <Card className="store-portal__selection">
        <Field label="Household">
          <Select
            aria-label="Household"
            value={householdId}
            onChange={(event) => {
              setHouseholdId(event.target.value);
            }}
          >
            {households.map((household, index) => (
              <option key={household.id} value={household.id}>
                Household {index + 1}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Order for">
          <Select
            aria-label="Order for"
            value={personId}
            onChange={(event) => {
              setPersonId(event.target.value);
            }}
          >
            {selectedHousehold?.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fulfillment">
          <Select
            aria-label="Fulfillment"
            value={fulfillmentMethod}
            onChange={(event) => {
              setFulfillmentMethod(
                event.target.value as typeof fulfillmentMethod,
              );
            }}
          >
            <option value="pickup">Pickup</option>
            <option value="ship">Ship</option>
          </Select>
        </Field>
        {fulfillmentMethod === 'ship' ? (
          <>
            <Field label="Shipping address line 1">
              <Input
                autoComplete="address-line1"
                required
                value={shippingAddress.line1}
                onChange={(event) => {
                  setShippingAddress((current) => ({
                    ...current,
                    line1: event.target.value,
                  }));
                }}
              />
            </Field>
            <Field label="Shipping address line 2">
              <Input
                autoComplete="address-line2"
                value={shippingAddress.line2}
                onChange={(event) => {
                  setShippingAddress((current) => ({
                    ...current,
                    line2: event.target.value,
                  }));
                }}
              />
            </Field>
            <Field label="Shipping city">
              <Input
                autoComplete="address-level2"
                required
                value={shippingAddress.city}
                onChange={(event) => {
                  setShippingAddress((current) => ({
                    ...current,
                    city: event.target.value,
                  }));
                }}
              />
            </Field>
            <Field label="Shipping state">
              <Input
                autoComplete="address-level1"
                required
                minLength={2}
                maxLength={2}
                pattern="[A-Z]{2}"
                value={shippingAddress.region}
                onChange={(event) => {
                  setShippingAddress((current) => ({
                    ...current,
                    region: event.target.value.toUpperCase(),
                  }));
                }}
              />
            </Field>
            <Field label="Shipping ZIP code">
              <Input
                autoComplete="postal-code"
                required
                pattern="[0-9]{5}(-[0-9]{4})?"
                value={shippingAddress.postalCode}
                onChange={(event) => {
                  setShippingAddress((current) => ({
                    ...current,
                    postalCode: event.target.value,
                  }));
                }}
              />
            </Field>
          </>
        ) : null}
      </Card>
      <section className="store-portal__grid" aria-label="Available products">
        {products.map((product) => {
          const currentVariantId =
            variants[product.id] ??
            product.variants.find((variant) => variant.available > 0)?.id ??
            '';
          const currentVariant = product.variants.find(
            (variant) => variant.id === currentVariantId,
          );
          return (
            <Card key={product.id}>
              <p className="eyebrow">
                {product.kind.replaceAll('_', ' ')}
                {product.categoryName ? ` · ${product.categoryName}` : ''}
              </p>
              <h2>{product.name}</h2>
              {product.description ? <p>{product.description}</p> : null}
              <Field label="Size and color">
                <Select
                  aria-label={`${product.name} size`}
                  value={currentVariantId}
                  onChange={(event) => {
                    setVariants((current) => ({
                      ...current,
                      [product.id]: event.target.value,
                    }));
                    setQuantities((current) => ({
                      ...current,
                      [product.id]: 0,
                    }));
                  }}
                >
                  <option value="">Choose a size</option>
                  {product.variants.map((variant) => (
                    <option
                      key={variant.id}
                      value={variant.id}
                      disabled={variant.available <= 0}
                    >
                      {[variant.size, variant.color]
                        .filter(Boolean)
                        .join(' · ') || variant.sku}{' '}
                      · {money(variant.priceCents)} · {variant.available}{' '}
                      available
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity">
                <input
                  className="ui-input"
                  type="number"
                  min="0"
                  max={Math.min(100, currentVariant?.available ?? 0)}
                  value={quantities[product.id] ?? 0}
                  onChange={(event) => {
                    setQuantities((current) => ({
                      ...current,
                      [product.id]: Math.max(
                        0,
                        Math.min(
                          currentVariant?.available ?? 0,
                          Number(event.target.value),
                        ),
                      ),
                    }));
                  }}
                  disabled={!currentVariant || currentVariant.available <= 0}
                />
              </Field>
              {product.requiredForRegistration ? (
                <p>Required uniform item for registration.</p>
              ) : null}
            </Card>
          );
        })}
        {!loading && products.length === 0 ? (
          <p>No store products are currently available.</p>
        ) : null}
      </section>
      <Card className="store-portal__checkout">
        <h2>Order summary</h2>
        <ul>
          {cart.map((item) => {
            const product = products.find(
              (candidate) => candidate.id === item.productId,
            );
            const variant = product?.variants.find(
              (candidate) => candidate.id === item.variantId,
            );
            return (
              <li key={item.productId}>
                {product?.name} · {variant?.size ?? variant?.sku} ×{' '}
                {item.quantity}{' '}
                <strong>
                  {money((variant?.priceCents ?? 0) * item.quantity)}
                </strong>
              </li>
            );
          })}
        </ul>
        <p>
          Sales tax is calculated at checkout. The invoice will appear in{' '}
          <a href={`/portal/orgs/${encodeURIComponent(orgId)}/money/invoices`}>
            Family payments
          </a>
          .
        </p>
        <Button
          disabled={
            busy ||
            !householdId ||
            !personId ||
            !cart.length ||
            (fulfillmentMethod === 'ship' &&
              (!shippingAddress.line1.trim() ||
                !shippingAddress.city.trim() ||
                !/^[A-Z]{2}$/.test(shippingAddress.region) ||
                !/^\d{5}(?:-\d{4})?$/.test(shippingAddress.postalCode.trim())))
          }
          onClick={() => {
            void placeOrder();
          }}
        >
          {busy ? 'Placing order…' : 'Place order and create invoice'}
        </Button>
      </Card>
      <section
        className="store-portal__orders"
        aria-labelledby="my-orders-title"
      >
        <h2 id="my-orders-title">Your orders</h2>
        {orders.map((order) => (
          <Card key={order.id}>
            <h3>Order {order.id.slice(0, 8)}</h3>
            <p>
              {order.status} · {money(order.subtotalCents + order.taxCents)}
            </p>
            <p>Fulfillment: {order.fulfillment?.status ?? 'pending'}</p>
            {order.invoiceId ? (
              <a
                href={`/portal/orgs/${encodeURIComponent(orgId)}/money/invoices`}
              >
                View family invoices
              </a>
            ) : null}
          </Card>
        ))}
        {orders.length === 0 ? <p>No store orders yet.</p> : null}
      </section>
    </main>
  );
}

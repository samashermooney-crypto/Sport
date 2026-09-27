import { z } from 'zod';

import { getDatabase } from '../../db/kysely';
import type { ServerModule } from '../../lib/module-contract';
import { systemWorkerActorId } from '../jobs/credentials-expiry';

import { createStoreRouter } from './routes';
import { reconcilePaidStoreOrders, runLowStockAlertJob } from './service';

async function syncPaidStoreOrders() {
  const database = getDatabase();
  const organizations = await database
    .selectFrom('organizations')
    .select('id')
    .where('status', '=', 'active')
    .execute();
  let processed = 0;
  for (const organization of organizations) {
    processed += await reconcilePaidStoreOrders(database, {
      orgId: organization.id,
      actor: { accountId: systemWorkerActorId },
    });
  }
  return { processed };
}

const base = '/api/v1/store/orgs/{orgId}';
const route = (
  method: 'get' | 'post' | 'patch',
  suffix: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
) => ({
  method,
  path: `${base}${suffix}`,
  summary,
  response,
  tags: ['store'],
  ...(body ? { body } : {}),
});
const openapiRoutes = [
  route('get', '/categories', 'List product categories', z.json()),
  route('post', '/categories', 'Create a product category', z.json(), z.json()),
  route(
    'patch',
    '/categories/{categoryId}',
    'Update or archive a product category',
    z.json(),
    z.json(),
  ),
  route('get', '/products', 'List active products and inventory', z.json()),
  route(
    'post',
    '/products',
    'Create a store product and variants',
    z.json(),
    z.json(),
  ),
  route(
    'post',
    '/variants/{variantId}/stock-receipts',
    'Receive product inventory',
    z.json(),
    z.json(),
  ),
  route(
    'post',
    '/orders',
    'Create an invoice-backed store order',
    z.json(),
    z.json(),
  ),
  route(
    'get',
    '/me/orders',
    'List the signed-in account store orders',
    z.json(),
  ),
  route(
    'get',
    '/uniform-size-report',
    'Aggregate paid uniform sizes by team or program',
    z.json(),
  ),
  route(
    'patch',
    '/orders/{orderId}/fulfillment',
    'Update pickup or shipping status',
    z.json(),
    z.json(),
  ),
];

export const moduleDefinition = {
  name: 'store',
  path: '/api/v1/store',
  router: createStoreRouter,
  jobs: [
    {
      name: 'store.sync-paid-orders',
      cron: '* * * * *',
      run: syncPaidStoreOrders,
    },
    {
      name: 'store.low-stock-alerts',
      cron: '30 7 * * *',
      run: () => runLowStockAlertJob(getDatabase()),
    },
  ],
  permissions: ['store.read', 'store.manage'],
  notificationTypes: ['store.order_update', 'store.low_stock'],
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };

import express from 'express';
import { z } from 'zod';

import type { AuthDependencies } from '../auth/routes';
import {
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from '../compliance/access';

import {
  adminOrderListSchema,
  fulfillmentBodySchema,
  fulfillmentSchema,
  orderBodySchema,
  orderSchema,
  productCategoryBodySchema,
  productCategoryListSchema,
  productCategorySchema,
  productCategoryUpdateSchema,
  productBodySchema,
  productListSchema,
  productSchema,
  stockBodySchema,
  uniformReportSchema,
} from './schema';
import {
  createProduct,
  createProductCategory,
  listProductCategories,
  listMyStoreOrders,
  listProducts,
  listStoreOrders,
  placeStoreOrder,
  receiveStock,
  uniformSizeReport,
  updateProductCategory,
  updateFulfillment,
} from './service';

const managers = ['owner', 'admin', 'finance', 'store_manager'] as const;
const uuid = (value: unknown) => z.uuid().parse(value);

export function createStoreRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use((request, response, next) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !mutationOriginIsValid(request, dependencies.appUrl)
    ) {
      response.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Request origin could not be verified',
        },
      });
      return;
    }
    next();
  });
  router.use(express.json({ limit: '64kb' }));
  const endpoint =
    (
      action: (
        request: express.Request,
        response: express.Response,
      ) => Promise<void>,
    ) =>
    async (request: express.Request, response: express.Response) => {
      try {
        await action(request, response);
      } catch (error) {
        sendModuleError(response, error);
      }
    };

  router.get(
    '/orgs/:orgId/categories',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        productCategoryListSchema.parse({
          categories: await listProductCategories(
            dependencies.database,
            actor.context,
          ),
        }),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/categories',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const category = await createProductCategory(
        dependencies.database,
        actor.context,
        productCategoryBodySchema.parse(request.body as unknown),
      );
      response.status(201).json(productCategorySchema.parse(category));
    }),
  );
  router.patch(
    '/orgs/:orgId/categories/:categoryId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const category = await updateProductCategory(
        dependencies.database,
        actor.context,
        uuid(request.params.categoryId),
        productCategoryUpdateSchema.parse(request.body as unknown),
      );
      response.json(productCategorySchema.parse(category));
    }),
  );

  router.get(
    '/orgs/:orgId/products',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const products = await listProducts(dependencies.database, actor.context);
      response.json(productListSchema.parse({ products }));
    }),
  );
  router.post(
    '/orgs/:orgId/products',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const body = productBodySchema.parse(request.body as unknown);
      const id = await createProduct(
        dependencies.database,
        actor.context,
        body,
      );
      const products = await listProducts(dependencies.database, actor.context);
      const product = products.find((item) => item.id === id);
      if (!product) throw new Error('Created product is unavailable');
      response.status(201).json(productSchema.parse(product));
    }),
  );
  router.post(
    '/orgs/:orgId/variants/:variantId/stock-receipts',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const body = stockBodySchema.parse(request.body as unknown);
      const movementId = await receiveStock(
        dependencies.database,
        actor.context,
        uuid(request.params.variantId),
        body.quantity,
        body.memo,
      );
      response.status(201).json({ id: movementId });
    }),
  );
  router.post(
    '/orgs/:orgId/orders',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const order = await placeStoreOrder(
        dependencies.database,
        actor.context,
        orderBodySchema.parse(request.body as unknown),
        dependencies.clock(),
      );
      response.status(201).json(orderSchema.parse(order));
    }),
  );
  router.get(
    '/orgs/:orgId/orders',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      response.json(
        adminOrderListSchema.parse({
          orders: await listStoreOrders(dependencies.database, actor.context),
        }),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/me/orders',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json({
        orders: await listMyStoreOrders(dependencies.database, actor.context),
      });
    }),
  );
  router.get(
    '/orgs/:orgId/uniform-size-report',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const report = await uniformSizeReport(
        dependencies.database,
        actor.context,
        {
          ...(request.query.teamSeasonId
            ? { teamSeasonId: uuid(request.query.teamSeasonId) }
            : {}),
          ...(request.query.programId
            ? { programId: uuid(request.query.programId) }
            : {}),
        },
      );
      response.json(uniformReportSchema.parse({ rows: report }));
    }),
  );
  router.patch(
    '/orgs/:orgId/orders/:orderId/fulfillment',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const fulfillment = await updateFulfillment(
        dependencies.database,
        actor.context,
        uuid(request.params.orderId),
        fulfillmentBodySchema.parse(request.body as unknown),
        dependencies.clock(),
      );
      response.json(fulfillmentSchema.parse(fulfillment));
    }),
  );
  return router;
}

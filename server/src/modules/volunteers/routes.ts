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
  myVolunteerHouseholdsSchema,
  shiftSignupListSchema,
  volunteerBuyoutBodySchema,
  volunteerBuyoutResponseSchema,
  volunteerLedgerSchema,
  volunteerRequirementBodySchema,
  volunteerRequirementListSchema,
  volunteerRequirementSchema,
  volunteerRoleBodySchema,
  volunteerRoleListSchema,
  volunteerRoleSchema,
  volunteerShiftBodySchema,
  volunteerShiftListSchema,
  volunteerShiftSchema,
  volunteerSignupBodySchema,
  volunteerSignupSchema,
  volunteerStatusBodySchema,
} from './schema';
import {
  buyOutVolunteerRequirement,
  createVolunteerRequirement,
  createVolunteerRole,
  createVolunteerShift,
  householdVolunteerLedger,
  listMyVolunteerHouseholds,
  listShiftSignups,
  listVolunteerRequirements,
  listVolunteerRoles,
  listVolunteerShifts,
  signupForVolunteerShift,
  updateVolunteerSignup,
} from './service';

const managementRoles = ['owner', 'admin', 'volunteer_coordinator'] as const;
const uuid = (value: unknown) => z.uuid().parse(value);

export function createVolunteersRouter(
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
  router.use(express.json({ limit: '32kb' }));
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
    '/orgs/:orgId/roles',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const roles = await listVolunteerRoles(
        actor.context,
        dependencies.database,
      );
      response.json(volunteerRoleListSchema.parse({ roles }));
    }),
  );
  router.post(
    '/orgs/:orgId/roles',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managementRoles);
      const body = volunteerRoleBodySchema.parse(request.body as unknown);
      const role = await createVolunteerRole(
        dependencies.database,
        actor.context,
        body,
      );
      response.status(201).json(volunteerRoleSchema.parse(role));
    }),
  );
  router.get(
    '/orgs/:orgId/requirements',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managementRoles);
      response.json(
        volunteerRequirementListSchema.parse({
          requirements: await listVolunteerRequirements(
            dependencies.database,
            actor.context,
          ),
        }),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/me/households',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        myVolunteerHouseholdsSchema.parse({
          households: await listMyVolunteerHouseholds(
            dependencies.database,
            actor.context,
          ),
        }),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/shifts/:shiftId/signups',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managementRoles);
      response.json(
        shiftSignupListSchema.parse({
          signups: await listShiftSignups(
            dependencies.database,
            actor.context,
            uuid(request.params.shiftId),
          ),
        }),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/requirements',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managementRoles);
      const created = await createVolunteerRequirement(
        dependencies.database,
        actor.context,
        volunteerRequirementBodySchema.parse(request.body as unknown),
      );
      const requirement = (
        await listVolunteerRequirements(dependencies.database, actor.context)
      ).find((item) => item.id === created.id);
      if (!requirement)
        throw new Error('Created requirement could not be read');
      response.status(201).json(volunteerRequirementSchema.parse(requirement));
    }),
  );
  router.get(
    '/orgs/:orgId/shifts',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const shifts = await listVolunteerShifts(
        actor.context,
        dependencies.database,
        {
          ...(request.query.from
            ? {
                from: z.iso
                  .datetime({ offset: true })
                  .parse(request.query.from),
              }
            : {}),
          ...(request.query.to
            ? { to: z.iso.datetime({ offset: true }).parse(request.query.to) }
            : {}),
        },
      );
      response.json(volunteerShiftListSchema.parse({ shifts }));
    }),
  );
  router.post(
    '/orgs/:orgId/shifts',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managementRoles);
      const created = await createVolunteerShift(
        dependencies.database,
        actor.context,
        volunteerShiftBodySchema.parse(request.body as unknown),
      );
      const shift = (
        await listVolunteerShifts(actor.context, dependencies.database)
      ).find((item) => item.id === created.id);
      if (!shift) throw new Error('Created shift could not be read');
      response.status(201).json(volunteerShiftSchema.parse(shift));
    }),
  );
  router.post(
    '/orgs/:orgId/shifts/:shiftId/signups',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = volunteerSignupBodySchema.parse(request.body as unknown);
      const signup = await signupForVolunteerShift(
        dependencies.database,
        actor.context,
        {
          shiftId: uuid(request.params.shiftId),
          personId: body.personId,
          householdId: body.householdId,
        },
      );
      response.status(201).json(volunteerSignupSchema.parse(signup));
    }),
  );
  router.patch(
    '/orgs/:orgId/signups/:signupId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managementRoles);
      const result = await updateVolunteerSignup(
        dependencies.database,
        actor.context,
        uuid(request.params.signupId),
        volunteerStatusBodySchema.parse(request.body as unknown),
        dependencies.clock(),
      );
      response.json(volunteerSignupSchema.parse(result));
    }),
  );
  router.get(
    '/orgs/:orgId/households/:householdId/ledger',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const ledger = await householdVolunteerLedger(
        dependencies.database,
        actor.context,
        uuid(request.params.householdId),
        dependencies.clock(),
      );
      response.json(volunteerLedgerSchema.parse(ledger));
    }),
  );
  router.post(
    '/orgs/:orgId/requirements/:requirementId/buyouts',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const creationKey = uuid(request.get('Idempotency-Key'));
      const body = volunteerBuyoutBodySchema.parse(request.body as unknown);
      const result = await buyOutVolunteerRequirement(
        dependencies.database,
        actor.context,
        {
          requirementId: uuid(request.params.requirementId),
          householdId: body.householdId,
          personId: body.personId ?? null,
          units: body.units,
          creationKey,
        },
        dependencies.clock(),
      );
      response.status(201).json(volunteerBuyoutResponseSchema.parse(result));
    }),
  );
  return router;
}

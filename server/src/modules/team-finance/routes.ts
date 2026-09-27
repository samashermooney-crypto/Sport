import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';
import {
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from '../compliance/access';

import {
  reimbursementBodySchema,
  reimbursementDecisionSchema,
  reimbursementListSchema,
  reimbursementSchema,
  teamFeeAssessmentBodySchema,
  teamFeeAssessmentListSchema,
  teamFeeAssessmentSchema,
  teamFeeIssueResponseSchema,
  teamLedgerEntryBodySchema,
  teamLedgerSchema,
} from './schema';
import {
  createManualLedgerEntry,
  createReimbursementRequest,
  createTeamFeeAssessment,
  decideReimbursement,
  getTeamLedger,
  issueTeamFeeAssessment,
  listReimbursementRequests,
  listTeamFeeAssessments,
  TeamFinanceAccessError,
} from './service';

const uuid = (value: unknown) => z.uuid().parse(value);
const financeRoles = ['owner', 'admin', 'finance'] as const;

async function requireLedgerReader(
  dependencies: AuthDependencies,
  context: { orgId: string; actor: { accountId: string } },
  roles: readonly string[],
  teamSeasonId: string,
) {
  if (financeRoles.some((role) => roles.includes(role))) return;
  const treasurer = await createWithOrg(dependencies.database)(
    context,
    async (trx) =>
      trx
        .selectFrom('team_staff as staff')
        .innerJoin('person_account_links as link', (join) =>
          join
            .onRef('link.org_id', '=', 'staff.org_id')
            .onRef('link.person_id', '=', 'staff.person_id'),
        )
        .select('staff.id')
        .where('staff.org_id', '=', context.orgId)
        .where('staff.team_season_id', '=', teamSeasonId)
        .where('staff.role', '=', 'treasurer')
        .where('staff.status', '=', 'active')
        .where('link.account_id', '=', context.actor.accountId)
        .where('link.relationship', '=', 'self')
        .where('link.revoked_at', 'is', null)
        .executeTakeFirst(),
  );
  if (!treasurer)
    throw new TeamFinanceAccessError(
      'Team treasurer or finance access is required',
    );
}

export function createTeamFinanceRouter(
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
    '/orgs/:orgId/teams/:teamSeasonId/ledger',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const teamSeasonId = uuid(request.params.teamSeasonId);
      await requireLedgerReader(
        dependencies,
        actor.context,
        actor.roles,
        teamSeasonId,
      );
      response.json(
        teamLedgerSchema.parse(
          await getTeamLedger(
            dependencies.database,
            actor.context,
            teamSeasonId,
          ),
        ),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/teams/:teamSeasonId/ledger/entries',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, financeRoles);
      const result = await createManualLedgerEntry(
        dependencies.database,
        actor.context,
        uuid(request.params.teamSeasonId),
        teamLedgerEntryBodySchema.parse(request.body as unknown),
      );
      response.status(201).json(result);
    }),
  );
  router.get(
    '/orgs/:orgId/teams/:teamSeasonId/fee-assessments',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, financeRoles);
      const assessments = await listTeamFeeAssessments(
        dependencies.database,
        actor.context,
        uuid(request.params.teamSeasonId),
      );
      response.json(teamFeeAssessmentListSchema.parse({ assessments }));
    }),
  );
  router.post(
    '/orgs/:orgId/teams/:teamSeasonId/fee-assessments',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, financeRoles);
      const body = teamFeeAssessmentBodySchema.parse(request.body as unknown);
      if (body.teamSeasonId !== uuid(request.params.teamSeasonId))
        throw new RangeError('Team season does not match the assessment path');
      const assessment = await createTeamFeeAssessment(
        dependencies.database,
        actor.context,
        body,
      );
      response.status(201).json(teamFeeAssessmentSchema.parse(assessment));
    }),
  );
  router.post(
    '/orgs/:orgId/fee-assessments/:assessmentId/issue',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, financeRoles);
      response.json(
        teamFeeIssueResponseSchema.parse(
          await issueTeamFeeAssessment(
            dependencies.database,
            actor.context,
            uuid(request.params.assessmentId),
          ),
        ),
      );
    }),
  );
  router.get(
    '/orgs/:orgId/teams/:teamSeasonId/reimbursements',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const teamSeasonId = uuid(request.params.teamSeasonId);
      await requireLedgerReader(
        dependencies,
        actor.context,
        actor.roles,
        teamSeasonId,
      );
      const requests = await listReimbursementRequests(
        dependencies.database,
        actor.context,
        teamSeasonId,
      );
      response.json(reimbursementListSchema.parse({ requests }));
    }),
  );
  router.post(
    '/orgs/:orgId/reimbursements',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const result = await createReimbursementRequest(
        dependencies.database,
        actor.context,
        reimbursementBodySchema.parse(request.body as unknown),
      );
      response.status(201).json(reimbursementSchema.parse(result));
    }),
  );
  router.patch(
    '/orgs/:orgId/reimbursements/:reimbursementId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, financeRoles);
      const result = await decideReimbursement(
        dependencies.database,
        actor.context,
        uuid(request.params.reimbursementId),
        reimbursementDecisionSchema.parse(request.body as unknown),
        dependencies.clock(),
      );
      response.json(reimbursementSchema.parse(result));
    }),
  );
  return router;
}

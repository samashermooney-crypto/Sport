import {
  contestResultBodySchema,
  contributionBodySchema,
  createRelationshipBodySchema,
  feeActionBodySchema,
  feeAssessmentBodySchema,
  federationDisciplineBodySchema,
  federationDisciplineUpdateSchema,
  memberPayerBodySchema,
  refereeAssignmentBodySchema,
  refereeBodySchema,
  rosterWindowBodySchema,
  scheduleRunBodySchema,
  sharingProposalBodySchema,
  submitEntryBodySchema,
  reviewEntryBodySchema,
  assignmentUpdateSchema,
} from '@shared/schemas/federation';
import express from 'express';
import { z } from 'zod';


import { parseIdempotencyKey } from '../../lib/idempotency';
import type { AuthDependencies } from '../auth/routes';
import {
  mutationOriginIsValid,
  orgActor,
  sendModuleError,
} from '../compliance/access';

import {
  listClubContributions,
  offerSpaceWindows,
  readProgramAvailability,
  withdrawContribution,
} from './availability';
import { associationDashboard } from './dashboard';
import {
  getRelationshipFor,
  listFederationPrograms,
  listLeagueProgramPicker,
  listMembers,
  listOwnSpaces,
  listOwnTeamSeasons,
  readMemberCompliance,
  readMemberDiscipline,
  readMemberRoster,
  readMemberTeams,
} from './directory';
import {
  listMemberFederationDiscipline,
  issueFederationDiscipline,
  listFederationDiscipline,
  updateFederationDiscipline,
} from './discipline';
import {
  freezeRosters,
  getLeagueEntry,
  listClubEntries,
  listLeagueEntries,
  resubmitRoster,
  reviewEntry,
  setRosterWindow,
  submitEntry,
  withdrawEntry,
} from './entries';
import {
  federationNotFound,
} from './errors';
import {
  createFeeAssessment,
  issueFeeInvoice,
  listClubFees,
  listFeeAssessments,
  listMemberPayers,
  setMemberPayer,
  voidFeeAssessment,
} from './fees';
import {
  addReferee,
  assignReferee,
  listAssignments,
  listReferees,
  removeReferee,
  updateAssignment,
} from './officials';
import {
  FEDERATION_ADMIN_ROLES,
  FEDERATION_DISCIPLINE_ROLES,
  FEDERATION_FINANCE_ROLES,
  FEDERATION_READ_ROLES,
  FEDERATION_REFEREE_ROLES,
  FEDERATION_SCHEDULE_ROLES,
  FEDERATION_SUBMIT_ROLES,
  requireFederationRole,
} from './policy';
import {
  acceptRelationship,
  createRelationship,
  declineRelationship,
  endRelationship,
  listRelationships,
  proposeSharing,
  respondToSharing,
  resumeRelationship,
  searchOrganizations,
  suspendRelationship,
} from './relationships';
import {
  enterHostedResult,
  enterLeagueResult,
  leagueStandings,
  listLeagueContests,
  memberStandings,
} from './results';
import {
  applyScheduleRun,
  discardScheduleRun,
  generateLeagueSchedule,
  getScheduleRun,
  listHostedGames,
  listScheduleRuns,
  publishScheduleRun,
} from './scheduling';

const uuid = (value: unknown) => z.uuid().parse(value);

export function createFederationRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
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

  const actorFor = async (
    request: express.Request,
    allowed: readonly string[],
  ) => {
    const actor = await orgActor(dependencies, request);
    requireFederationRole(actor.roles, allowed);
    return actor;
  };

  const idemKey = (request: express.Request) =>
    parseIdempotencyKey(request.get('Idempotency-Key'));

  // ---- Relationships -----------------------------------------------------

  router.get(
    '/organizations/:orgId/relationships',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json({
        items: await listRelationships(dependencies.database, actor.context),
      });
    }),
  );

  router.get(
    '/organizations/:orgId/relationships/lookup',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const q = z.string().parse(request.query.q ?? '');
      response.json({
        items: await searchOrganizations(
          dependencies.database,
          actor.context,
          q,
        ),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/relationships',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = createRelationshipBodySchema.parse(request.body);
      response
        .status(201)
        .json(
          await createRelationship(dependencies.database, actor.context, body),
        );
    }),
  );

  router.get(
    '/organizations/:orgId/relationships/:relationshipId',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json(
        await getRelationshipFor(
          dependencies.database,
          actor.context,
          uuid(request.params.relationshipId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/accept',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      response.json(
        await acceptRelationship(
          actor.context,
          uuid(request.params.relationshipId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/decline',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      response.json(
        await declineRelationship(
          actor.context,
          uuid(request.params.relationshipId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/suspend',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = z
        .strictObject({
          reason: z.string().trim().max(2000).optional(),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      response.json(
        await suspendRelationship(
          actor.context,
          uuid(request.params.relationshipId),
          body.reason,
          body.version,
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/resume',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = z
        .strictObject({ version: z.number().int().positive() })
        .parse(request.body);
      response.json(
        await resumeRelationship(
          actor.context,
          uuid(request.params.relationshipId),
          body.version,
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/end',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = z
        .strictObject({
          reason: z.string().trim().max(2000).optional(),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      response.json(
        await endRelationship(
          actor.context,
          uuid(request.params.relationshipId),
          body.reason,
          body.version,
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/sharing',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = sharingProposalBodySchema.parse(request.body);
      response.json(
        await proposeSharing(
          actor.context,
          uuid(request.params.relationshipId),
          body.dataSharing,
          body.version,
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/sharing/accept',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = z
        .strictObject({ version: z.number().int().positive() })
        .parse(request.body);
      response.json(
        await respondToSharing(
          actor.context,
          uuid(request.params.relationshipId),
          true,
          body.version,
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/relationships/:relationshipId/sharing/decline',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = z
        .strictObject({ version: z.number().int().positive() })
        .parse(request.body);
      response.json(
        await respondToSharing(
          actor.context,
          uuid(request.params.relationshipId),
          false,
          body.version,
        ),
      );
    }),
  );

  // ---- Pickers --------------------------------------------------------------

  router.get(
    '/organizations/:orgId/programs',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json({
        items: await listFederationPrograms(
          dependencies.database,
          actor.context,
        ),
      });
    }),
  );

  router.get(
    '/organizations/:orgId/league-programs',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const leagueOrgId = z.uuid().parse(request.query.leagueOrgId);
      response.json(await listLeagueProgramPicker(actor.context, leagueOrgId));
    }),
  );

  router.get(
    '/organizations/:orgId/my-teams',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      response.json({
        items: await listOwnTeamSeasons(
          dependencies.database,
          actor.context,
        ),
      });
    }),
  );

  router.get(
    '/organizations/:orgId/my-spaces',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      response.json({
        items: await listOwnSpaces(dependencies.database, actor.context),
      });
    }),
  );

  // ---- Member directory (league side, privileged reads) -------------------

  router.get(
    '/organizations/:orgId/members',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json({
        items: await listMembers(dependencies.database, actor.context),
      });
    }),
  );

  router.get(
    '/organizations/:orgId/members/:memberOrgId/teams',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json(
        await readMemberTeams(actor.context, uuid(request.params.memberOrgId)),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/members/:memberOrgId/roster',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      const teamSeasonId = z.uuid().parse(request.query.teamSeasonId);
      response.json(
        await readMemberRoster(
          actor.context,
          uuid(request.params.memberOrgId),
          teamSeasonId,
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/members/:memberOrgId/compliance',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json(
        await readMemberCompliance(
          actor.context,
          uuid(request.params.memberOrgId),
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/members/:memberOrgId/discipline',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json(
        await readMemberDiscipline(
          actor.context,
          uuid(request.params.memberOrgId),
        ),
      );
    }),
  );

  // ---- Team entries + roster snapshots ------------------------------------

  router.get(
    '/organizations/:orgId/entries',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      const programId = request.query.programId
        ? z.uuid().parse(request.query.programId)
        : undefined;
      response.json({
        items: await listLeagueEntries(
          dependencies.database,
          actor.context,
          programId,
        ),
      });
    }),
  );

  router.get(
    '/organizations/:orgId/entries/:entryId',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json(
        await getLeagueEntry(
          dependencies.database,
          actor.context,
          uuid(request.params.entryId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/entries/:entryId/review',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = reviewEntryBodySchema.parse(request.body);
      response.json(
        await reviewEntry(
          dependencies.database,
          actor.context,
          uuid(request.params.entryId),
          body,
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/submitted-entries',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      response.json({ items: await listClubEntries(actor.context) });
    }),
  );

  router.post(
    '/organizations/:orgId/submitted-entries',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const body = submitEntryBodySchema.parse(request.body);
      response.status(201).json(await submitEntry(actor.context, body));
    }),
  );

  router.post(
    '/organizations/:orgId/submitted-entries/:entryId/withdraw',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const body = z
        .strictObject({ leagueOrgId: z.uuid() })
        .parse(request.body);
      response.json(
        await withdrawEntry(
          actor.context,
          body.leagueOrgId,
          uuid(request.params.entryId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/submitted-entries/:entryId/roster',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const body = z
        .strictObject({ leagueOrgId: z.uuid() })
        .parse(request.body);
      response.json(
        await resubmitRoster(
          actor.context,
          body.leagueOrgId,
          uuid(request.params.entryId),
        ),
      );
    }),
  );

  router.put(
    '/organizations/:orgId/programs/:programId/roster-window',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = rosterWindowBodySchema.parse(request.body);
      response.json(
        await setRosterWindow(
          dependencies.database,
          actor.context,
          uuid(request.params.programId),
          body,
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/programs/:programId/roster-freeze',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      response.json(
        await freezeRosters(
          dependencies.database,
          actor.context,
          uuid(request.params.programId),
        ),
      );
    }),
  );

  // ---- Availability + scheduling ------------------------------------------

  router.post(
    '/organizations/:orgId/space-contributions',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const body = contributionBodySchema.parse(request.body);
      response
        .status(201)
        .json(
          await offerSpaceWindows(dependencies.database, actor.context, body),
        );
    }),
  );

  router.get(
    '/organizations/:orgId/space-contributions',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      response.json({
        items: await listClubContributions(
          dependencies.database,
          actor.context,
        ),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/space-contributions/:contributionId/withdraw',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      response.json(
        await withdrawContribution(
          dependencies.database,
          actor.context,
          uuid(request.params.contributionId),
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/programs/:programId/availability',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      response.json(
        await readProgramAvailability(
          actor.context,
          uuid(request.params.programId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/schedule-runs',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      const body = scheduleRunBodySchema.parse(request.body);
      response
        .status(201)
        .json(await generateLeagueSchedule(actor.context, body));
    }),
  );

  router.get(
    '/organizations/:orgId/schedule-runs',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      const programId = request.query.programId
        ? z.uuid().parse(request.query.programId)
        : undefined;
      response.json({
        items: await listScheduleRuns(
          dependencies.database,
          actor.context,
          programId,
        ),
      });
    }),
  );

  router.get(
    '/organizations/:orgId/schedule-runs/:runId',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      response.json(
        await getScheduleRun(
          dependencies.database,
          actor.context,
          uuid(request.params.runId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/schedule-runs/:runId/apply',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      response.json(
        await applyScheduleRun(actor.context, uuid(request.params.runId)),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/schedule-runs/:runId/publish',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      response.json(
        await publishScheduleRun(
          dependencies.database,
          actor.context,
          uuid(request.params.runId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/schedule-runs/:runId/discard',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      response.json(
        await discardScheduleRun(
          dependencies.database,
          actor.context,
          uuid(request.params.runId),
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/hosted-games',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      response.json({ items: await listHostedGames(actor.context) });
    }),
  );

  // ---- Results + standings ------------------------------------------------

  router.get(
    '/organizations/:orgId/programs/:programId/contests',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json({
        items: await listLeagueContests(
          dependencies.database,
          actor.context,
          uuid(request.params.programId),
        ),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/contests/:contestId/result',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SCHEDULE_ROLES);
      const body = contestResultBodySchema.parse(request.body);
      response.json(
        await enterLeagueResult(
          dependencies.database,
          actor.context,
          uuid(request.params.contestId),
          body,
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/hosted-games/:linkId/result',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const body = contestResultBodySchema.parse(request.body);
      response.json(
        await enterHostedResult(
          actor.context,
          uuid(request.params.linkId),
          body,
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/programs/:programId/standings',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json({
        divisions: await leagueStandings(
          dependencies.database,
          actor.context,
          uuid(request.params.programId),
        ),
      });
    }),
  );

  router.get(
    '/organizations/:orgId/member-standings',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const leagueOrgId = z.uuid().parse(request.query.leagueOrgId);
      const programId = z.uuid().parse(request.query.programId);
      response.json({
        divisions: await memberStandings(
          actor.context,
          leagueOrgId,
          programId,
        ),
      });
    }),
  );

  // ---- Federation discipline -----------------------------------------------

  router.get(
    '/organizations/:orgId/federation-discipline',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_DISCIPLINE_ROLES);
      const memberOrgId = request.query.memberOrgId
        ? z.uuid().parse(request.query.memberOrgId)
        : undefined;
      response.json({
        items: await listFederationDiscipline(
          dependencies.database,
          actor.context,
          memberOrgId,
        ),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/federation-discipline',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_DISCIPLINE_ROLES);
      const body = federationDisciplineBodySchema.parse(request.body);
      response
        .status(201)
        .json(
          await issueFederationDiscipline(actor.context, body),
        );
    }),
  );

  router.patch(
    '/organizations/:orgId/federation-discipline/:recordId',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_DISCIPLINE_ROLES);
      const body = federationDisciplineUpdateSchema.parse(request.body);
      response.json(
        await updateFederationDiscipline(
          dependencies.database,
          actor.context,
          uuid(request.params.recordId),
          body,
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/member-discipline',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json({
        items: await listMemberFederationDiscipline(actor.context),
      });
    }),
  );

  // ---- Referee pool ---------------------------------------------------------

  router.get(
    '/organizations/:orgId/referees',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_REFEREE_ROLES);
      response.json({
        items: await listReferees(dependencies.database, actor.context),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/referees',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_REFEREE_ROLES);
      const body = refereeBodySchema.parse(request.body);
      response
        .status(201)
        .json(await addReferee(dependencies.database, actor.context, body));
    }),
  );

  router.post(
    '/organizations/:orgId/referees/:profileId/remove',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_REFEREE_ROLES);
      response.json(
        await removeReferee(
          dependencies.database,
          actor.context,
          uuid(request.params.profileId),
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/referee-assignments',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_REFEREE_ROLES);
      const contestId = request.query.contestId
        ? z.uuid().parse(request.query.contestId)
        : undefined;
      response.json({
        items: await listAssignments(
          dependencies.database,
          actor.context,
          contestId,
        ),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/contests/:contestId/assignments',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_REFEREE_ROLES);
      const body = refereeAssignmentBodySchema.parse(request.body);
      response
        .status(201)
        .json(
          await assignReferee(
            dependencies.database,
            actor.context,
            uuid(request.params.contestId),
            body,
          ),
        );
    }),
  );

  router.patch(
    '/organizations/:orgId/referee-assignments/:assignmentId',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_REFEREE_ROLES);
      const body = assignmentUpdateSchema.parse(request.body);
      response.json(
        await updateAssignment(
          dependencies.database,
          actor.context,
          uuid(request.params.assignmentId),
          body,
        ),
      );
    }),
  );

  // ---- League fees ----------------------------------------------------------

  router.get(
    '/organizations/:orgId/member-payers',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_FINANCE_ROLES);
      response.json({
        items: await listMemberPayers(dependencies.database, actor.context),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/member-payers',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_ADMIN_ROLES);
      const body = memberPayerBodySchema.parse(request.body);
      response
        .status(201)
        .json(await setMemberPayer(actor.context, body));
    }),
  );

  router.get(
    '/organizations/:orgId/fees',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_FINANCE_ROLES);
      const memberOrgId = request.query.memberOrgId
        ? z.uuid().parse(request.query.memberOrgId)
        : undefined;
      response.json({
        items: await listFeeAssessments(
          dependencies.database,
          actor.context,
          memberOrgId,
        ),
      });
    }),
  );

  router.post(
    '/organizations/:orgId/fees',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_FINANCE_ROLES);
      const body = feeAssessmentBodySchema.parse(request.body);
      response
        .status(201)
        .json(
          await createFeeAssessment(
            dependencies.database,
            actor.context,
            body,
          ),
        );
    }),
  );

  router.post(
    '/organizations/:orgId/fees/:assessmentId/issue',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_FINANCE_ROLES);
      response.json(
        await issueFeeInvoice(
          dependencies.database,
          actor.context,
          uuid(request.params.assessmentId),
        ),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/fees/:assessmentId/void',
    endpoint(async (request, response) => {
      idemKey(request);
      const actor = await actorFor(request, FEDERATION_FINANCE_ROLES);
      const body = feeActionBodySchema.parse(request.body);
      if (body.action !== 'void')
        throw federationNotFound('Unsupported fee action');
      response.json(
        await voidFeeAssessment(
          dependencies.database,
          actor.context,
          uuid(request.params.assessmentId),
          body.reason ?? 'Voided',
        ),
      );
    }),
  );

  router.get(
    '/organizations/:orgId/club-fees',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_SUBMIT_ROLES);
      const leagueOrgId = z.uuid().parse(request.query.leagueOrgId);
      response.json({
        items: await listClubFees(actor.context, leagueOrgId),
      });
    }),
  );

  // ---- Association dashboard ------------------------------------------------

  router.get(
    '/organizations/:orgId/dashboard',
    endpoint(async (request, response) => {
      const actor = await actorFor(request, FEDERATION_READ_ROLES);
      response.json(
        await associationDashboard(dependencies.database, actor.context),
      );
    }),
  );

  router.use((_request, response) => {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Federation resource not found' },
    });
  });

  return router;
}

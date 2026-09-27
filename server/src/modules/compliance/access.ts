import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

export class AccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function orgActor(
  dependencies: AuthDependencies,
  request: express.Request,
): Promise<{
  context: OrgContext;
  session: Awaited<ReturnType<typeof requireSession>>;
  roles: string[];
}> {
  const session = await requireSession(dependencies, request);
  const orgId = z.uuid().parse(request.params.orgId);
  const context = { orgId, actor: { accountId: session.accountId } };
  const withOrg = createWithOrg(dependencies.database);
  const access = await withOrg(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', orgId)
      .where('account_id', '=', session.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const linkedPerson = membership
      ? true
      : Boolean(
          await trx
            .selectFrom('person_account_links')
            .select('id')
            .where('org_id', '=', orgId)
            .where('account_id', '=', session.accountId)
            .where('revoked_at', 'is', null)
            .executeTakeFirst(),
        );
    if (!linkedPerson) return null;
    const roles = await trx
      .selectFrom('role_assignments')
      .select('role')
      .where('org_id', '=', orgId)
      .where('account_id', '=', session.accountId)
      .where('scope_type', '=', 'org')
      .where('revoked_at', 'is', null)
      .where('pending_mfa', '=', false)
      .execute();
    return roles.map((row) => row.role);
  });
  if (!access)
    throw new AccessError(404, 'NOT_FOUND', 'Organization not found');
  return { context, session, roles: access };
}

export function mutationOriginIsValid(
  request: express.Request,
  appUrl: string,
): boolean {
  const bearerRequest =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearerRequest && request.get('Origin') === undefined))
  );
}

export function requireAnyRole(
  roles: readonly string[],
  allowed: readonly string[],
): void {
  if (!allowed.some((role) => roles.includes(role)))
    throw new AccessError(404, 'NOT_FOUND', 'Organization resource not found');
}

export function isComplianceOfficer(roles: readonly string[]): boolean {
  return roles.some((role) => ['owner', 'compliance'].includes(role));
}

export function isOwner(roles: readonly string[]): boolean {
  return roles.includes('owner');
}

export function sendModuleError(
  response: express.Response,
  error: unknown,
): void {
  if (error instanceof z.ZodError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Check the submitted details',
      },
    });
  } else if (error instanceof AccessError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
  } else if (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
  } else {
    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed',
      },
    });
  }
}

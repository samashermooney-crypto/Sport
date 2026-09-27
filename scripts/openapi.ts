import { mkdir, readFile, writeFile } from 'node:fs/promises';

import prettier from 'prettier';
import { z } from 'zod';

import { serverModules } from '../server/src/generated/registry';
import { uploadBody } from '../server/src/modules/files/routes';
import * as auth from '../shared/src/schemas/auth';
import { apiErrorSchema } from '../shared/src/schemas/errors';
import { healthResponseSchema } from '../shared/src/schemas/health';
import * as orgs from '../shared/src/schemas/orgs';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type OpenApiRoute = {
  method: Method;
  path: string;
  summary: string;
  response: z.ZodType;
  body?: z.ZodType;
  status?: number;
  tags?: string[];
  public?: boolean;
  query?: Record<string, z.ZodType>;
  contentType?: string;
  binary?: boolean;
};

const authBase = '/api/v1/auth';
const orgsBase = '/api/v1/orgs';
const filesBase = '/api/v1/files';
const authRoutes: OpenApiRoute[] = [
  {
    method: 'get',
    path: `${authBase}/legal`,
    summary: 'Get legal documents',
    response: auth.authLegalResponseSchema,
    public: true,
  },
  {
    method: 'get',
    path: `${authBase}/captcha-config`,
    summary: 'Get CAPTCHA configuration',
    response: auth.authCaptchaConfigResponseSchema,
    public: true,
  },
  {
    method: 'get',
    path: `${authBase}/push-config`,
    summary: 'Get push configuration',
    response: auth.authPushConfigResponseSchema,
    public: true,
  },
  {
    method: 'get',
    path: `${authBase}/me`,
    summary: 'Get current account',
    response: auth.authMeResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/sign-up`,
    summary: 'Create account',
    body: auth.signUpSchema,
    response: auth.authMessageResponseSchema,
    status: 202,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/verify-email`,
    summary: 'Verify email',
    body: auth.tokenBodySchema,
    response: auth.authStatusResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/sign-in`,
    summary: 'Sign in',
    body: auth.signInBodySchema,
    response: auth.authSignInResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/token`,
    summary: 'Issue native token',
    body: auth.nativeTokenBodySchema,
    response: auth.nativeTokenResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/token/mfa`,
    summary: 'Complete native MFA',
    body: auth.nativeMfaChallengeBodySchema,
    response: auth.nativeTokenResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/magic/request`,
    summary: 'Request magic link',
    body: auth.emailBodySchema,
    response: auth.authMessageResponseSchema,
    status: 202,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/magic/redeem`,
    summary: 'Redeem magic link',
    body: auth.tokenBodySchema,
    response: auth.authSignInResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/mfa/challenge`,
    summary: 'Complete MFA challenge',
    body: auth.mfaChallengeBodySchema,
    response: auth.authStatusResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/password/reset/request`,
    summary: 'Request password reset',
    body: auth.emailBodySchema,
    response: auth.authMessageResponseSchema,
    status: 202,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/password/reset/confirm`,
    summary: 'Confirm password reset',
    body: auth.resetPasswordBodySchema,
    response: auth.authStatusResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/password/change`,
    summary: 'Change password',
    body: auth.changePasswordBodySchema,
    response: auth.authStatusResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/email/change/request`,
    summary: 'Request email change',
    body: auth.requestEmailChangeBodySchema,
    response: auth.authStatusResponseSchema,
    status: 202,
  },
  {
    method: 'post',
    path: `${authBase}/email/change/confirm`,
    summary: 'Confirm email change',
    body: auth.tokenBodySchema,
    response: auth.authStatusResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: `${authBase}/mfa/enroll/start`,
    summary: 'Begin MFA enrollment',
    response: auth.mfaEnrollmentResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/mfa/enroll/confirm`,
    summary: 'Confirm MFA enrollment',
    body: auth.mfaCodeBodySchema,
    response: auth.recoveryCodesResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/mfa/recovery/regenerate`,
    summary: 'Regenerate recovery codes',
    response: auth.recoveryCodesResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/step-up`,
    summary: 'Reauthenticate',
    body: auth.stepUpBodySchema,
    response: auth.authStatusResponseSchema,
  },
  {
    method: 'get',
    path: `${authBase}/sessions`,
    summary: 'List sessions',
    response: auth.sessionsResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/devices`,
    summary: 'Register device',
    body: auth.deviceRegistrationBodySchema,
    response: auth.deviceResponseSchema,
  },
  {
    method: 'get',
    path: `${authBase}/devices`,
    summary: 'List devices',
    response: auth.devicesResponseSchema,
  },
  {
    method: 'delete',
    path: `${authBase}/devices/{id}`,
    summary: 'Revoke device',
    response: auth.authStatusResponseSchema,
  },
  {
    method: 'delete',
    path: `${authBase}/sessions/{id}`,
    summary: 'Revoke session',
    response: auth.authStatusResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/sign-out`,
    summary: 'Sign out',
    response: auth.authStatusResponseSchema,
  },
  {
    method: 'post',
    path: `${authBase}/account-deletion`,
    summary: 'Request account deletion',
    body: auth.deletionRequestBodySchema,
    response: auth.deletionRequestResponseSchema,
    status: 202,
  },
];
const fileRecordSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  purpose: z.enum(['image', 'document', 'import', 'website_asset']),
  ownerType: z.string().nullable(),
  ownerId: z.uuid().nullable(),
  storageKey: z.string(),
  mime: z.string(),
  bytes: z.number().int(),
  sha256: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sensitivity: z.string(),
  createdBy: z.uuid().nullable(),
  uploadState: z.string(),
});
const fileRoutes: OpenApiRoute[] = [
  {
    method: 'post',
    path: `${filesBase}/uploads`,
    summary: 'Begin file upload',
    body: uploadBody,
    response: z.strictObject({ fileId: z.uuid(), uploadUrl: z.string() }),
    status: 201,
  },
  {
    method: 'post',
    path: `${filesBase}/uploads/{id}/complete`,
    summary: 'Complete file upload',
    response: fileRecordSchema,
  },
  {
    method: 'put',
    path: `${filesBase}/uploads/{id}/content`,
    summary: 'Upload local file content',
    response: z.null(),
    status: 204,
    binary: true,
  },
  {
    method: 'get',
    path: `${filesBase}/{id}/download`,
    summary: 'Issue permission-checked file download link',
    response: z.strictObject({
      url: z.string(),
      expiresInSeconds: z.number().int(),
    }),
  },
  {
    method: 'get',
    path: `${filesBase}/{id}/content`,
    summary: 'Download local file content',
    response: z.string(),
    binary: true,
  },
];
const orgRoutes: OpenApiRoute[] = [
  {
    method: 'get',
    path: `${orgsBase}/sport-templates`,
    summary: 'List built-in sport templates',
    response: orgs.sportTemplateCatalogSchema,
  },
  {
    method: 'get',
    path: `${orgsBase}/{orgId}/credential-types`,
    summary: 'List organization safety requirements',
    response: orgs.orgCredentialsResponseSchema,
  },
  {
    method: 'patch',
    path: `${orgsBase}/{orgId}/credential-types/{credentialId}`,
    summary: 'Update organization safety requirement',
    body: orgs.updateOrgCredentialSchema,
    response: orgs.orgCredentialSchema,
  },
  {
    method: 'patch',
    path: `${orgsBase}/{orgId}/members/{memberId}/roles`,
    summary: 'Update organization member roles',
    body: orgs.updateOrgMemberRolesSchema,
    response: orgs.orgMemberRolesResponseSchema,
  },
  {
    method: 'patch',
    path: `${orgsBase}/{orgId}/members/{memberId}/status`,
    summary: 'Suspend, reactivate or remove organization membership',
    body: orgs.updateOrgMemberStatusSchema,
    response: orgs.orgMemberStatusResponseSchema,
  },
  {
    method: 'post',
    path: `${orgsBase}/{orgId}/invitations`,
    summary: 'Invite organization member',
    body: orgs.orgInvitationSchema,
    response: orgs.orgInvitationResponseSchema,
    status: 201,
  },
  {
    method: 'post',
    path: `${orgsBase}/{orgId}/invitations/accept`,
    summary: 'Accept organization invitation',
    body: orgs.acceptOrgInvitationSchema,
    response: orgs.acceptedOrgInvitationResponseSchema,
  },
  {
    method: 'get',
    path: `${orgsBase}/{orgId}/staff`,
    summary: 'List organization members and pending invitations',
    response: orgs.orgStaffResponseSchema,
  },
  {
    method: 'post',
    path: `${orgsBase}/{orgId}/invitations/{invitationId}/resend`,
    summary: 'Resend organization invitation',
    response: orgs.orgInvitationResponseSchema,
    status: 201,
  },
  {
    method: 'delete',
    path: `${orgsBase}/{orgId}/invitations/{invitationId}`,
    summary: 'Revoke organization invitation',
    response: z.strictObject({ revoked: z.literal(true) }),
  },
  {
    method: 'get',
    path: `${orgsBase}/slug-availability`,
    summary: 'Check organization slug',
    query: { slug: orgs.orgSlugSchema },
    response: orgs.orgSlugAvailabilitySchema,
  },
  {
    method: 'post',
    path: orgsBase,
    summary: 'Create organization',
    body: orgs.createOrgSchema,
    response: orgs.createOrgResponseSchema,
    status: 201,
  },
];

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12' });
}

function operation(route: OpenApiRoute): Record<string, unknown> {
  const pathNames = [
    ...route.path.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g),
  ].map((match) => match[1] ?? '');
  const parameters = [
    ...pathNames.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema:
        name === 'id' ? { type: 'string', format: 'uuid' } : { type: 'string' },
    })),
    ...Object.entries(route.query ?? {}).map(([name, schema]) => ({
      name,
      in: 'query',
      required: !schema.safeParse(undefined).success,
      schema: jsonSchema(schema),
    })),
  ];
  const status = String(route.status ?? 200);
  const result: Record<string, unknown> = {
    operationId: `${route.method}_${route.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    summary: route.summary,
    tags: route.tags ?? [route.path.split('/')[3] ?? 'system'],
    security: route.public ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }],
    responses: {
      [status]: {
        description: 'Success',
        content:
          route.status === 204
            ? undefined
            : route.binary
              ? {
                  'application/octet-stream': {
                    schema: { type: 'string', format: 'binary' },
                  },
                }
              : {
                  [route.contentType ?? 'application/json']: {
                    schema: jsonSchema(route.response),
                  },
                },
      },
      '400': { $ref: '#/components/responses/ValidationError' },
      '401': { $ref: '#/components/responses/Unauthenticated' },
      '403': { $ref: '#/components/responses/Forbidden' },
      '404': { $ref: '#/components/responses/NotFound' },
      '409': { $ref: '#/components/responses/Conflict' },
      '422': { $ref: '#/components/responses/BusinessRule' },
      '429': { $ref: '#/components/responses/RateLimited' },
      '503': { $ref: '#/components/responses/Unavailable' },
    },
  };
  if (parameters.length) result.parameters = parameters;
  if (route.body)
    result.requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchema(route.body) } },
    };
  return result;
}

async function declaredRouteKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const module of serverModules) {
    if (!module.router) continue;
    const source = await readFile(
      `server/src/modules/${module.name}/routes.ts`,
      'utf8',
    );
    for (const match of source.matchAll(
      /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g,
    )) {
      const method = match[1];
      const suffix = match[2];
      if (!method || !suffix) continue;
      const path = `${module.path}${suffix === '/' ? '' : suffix}`.replace(
        /:([a-zA-Z][a-zA-Z0-9_]*)/g,
        '{$1}',
      );
      keys.add(`${method} ${path}`);
    }
  }
  return keys;
}

const moduleRoutes = serverModules.flatMap((module) => {
  const candidate: unknown =
    'openapiRoutes' in module ? module.openapiRoutes : undefined;
  return Array.isArray(candidate) ? (candidate as OpenApiRoute[]) : [];
});
const routes: OpenApiRoute[] = [
  {
    method: 'get',
    path: '/healthz',
    summary: 'Process health',
    response: healthResponseSchema,
    public: true,
    tags: ['system'],
  },
  ...authRoutes,
  ...orgRoutes,
  ...fileRoutes,
  ...moduleRoutes,
];
const keys = new Set(routes.map((route) => `${route.method} ${route.path}`));
if (keys.size !== routes.length) throw new Error('Duplicate OpenAPI operation');
for (const key of await declaredRouteKeys())
  if (!keys.has(key)) throw new Error(`Route missing from OpenAPI: ${key}`);
const paths: Record<string, Record<string, unknown>> = {};
for (const route of routes) {
  const operations = paths[route.path] ?? {};
  operations[route.method] = operation(route);
  paths[route.path] = operations;
}
const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
  },
});
const document = {
  openapi: '3.1.0',
  info: { title: 'Athlentry API', version: '1.0.0' },
  servers: [{ url: '/' }],
  paths,
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-athlentry_session',
      },
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: { ApiError: jsonSchema(apiErrorSchema) },
    responses: {
      ValidationError: errorResponse('Invalid request'),
      Unauthenticated: errorResponse('Authentication required'),
      Forbidden: errorResponse('Forbidden'),
      NotFound: errorResponse('Not found'),
      Conflict: errorResponse('Conflict or stale version'),
      BusinessRule: errorResponse('Business rule rejected request'),
      RateLimited: errorResponse('Rate limit exceeded'),
      Unavailable: errorResponse('Dependency unavailable'),
    },
  },
};
await mkdir('docs/api', { recursive: true });
await writeFile(
  'docs/api/openapi.json',
  await prettier.format(JSON.stringify(document), { parser: 'json' }),
);

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import prettier from 'prettier';
import * as ts from 'typescript';
import { z } from 'zod';

import { serverModules } from '../server/src/generated/registry';
import { uploadBody } from '../server/src/modules/files/routes';
import * as auth from '../shared/src/schemas/auth';
import { apiErrorSchema } from '../shared/src/schemas/errors';
import { healthResponseSchema } from '../shared/src/schemas/health';
import * as orgs from '../shared/src/schemas/orgs';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type ApiScope = 'organization' | 'account' | 'platform' | 'public';
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
  pathParameters?: Record<string, z.ZodType>;
  idempotencyKey?: boolean;
  contentType?: string;
  binary?: boolean;
  permission?: string;
  resource?: string;
  scope?: ApiScope;
  tenancyFixture?: {
    body?: unknown;
    query?: Record<string, string>;
    pathResource?: 'file';
  };
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
    query: { locale: z.enum(['en', 'es']).optional() },
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
    method: 'patch',
    path: `${authBase}/locale`,
    summary: 'Set account language preference',
    body: auth.accountLocaleBodySchema,
    response: auth.accountLocaleResponseSchema,
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
    path: `${orgsBase}/mine`,
    summary: 'List organizations for the current account',
    response: orgs.myOrganizationsSchema,
  },
  {
    method: 'get',
    path: `${orgsBase}/{orgId}/workspace`,
    summary: 'Get the active organization workspace and available actions',
    response: orgs.orgWorkspaceSchema,
  },
  {
    method: 'get',
    path: `${orgsBase}/{orgId}/profile`,
    summary: 'Get organization profile and branding',
    response: orgs.orgProfileSchema,
  },
  {
    method: 'patch',
    path: `${orgsBase}/{orgId}/profile`,
    summary: 'Update versioned organization profile and branding',
    body: orgs.updateOrgProfileSchema,
    response: orgs.orgProfileSchema,
  },
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
    method: 'patch',
    path: `${orgsBase}/{orgId}/members/{memberId}/scoped-role`,
    summary: 'Grant or revoke a scoped organization role',
    body: orgs.updateScopedRoleSchema,
    response: orgs.scopedRoleResponseSchema,
  },
  {
    method: 'post',
    path: `${orgsBase}/{orgId}/ownership-transfer`,
    summary: 'Request recipient-accepted ownership transfer',
    body: orgs.ownershipTransferRequestSchema,
    response: orgs.ownershipTransferRequestResponseSchema,
    status: 201,
  },
  {
    method: 'post',
    path: `${orgsBase}/{orgId}/ownership-transfer/accept`,
    summary: 'Accept organization ownership transfer',
    body: orgs.ownershipTransferAcceptSchema,
    response: orgs.ownershipTransferAcceptResponseSchema,
  },
  {
    method: 'post',
    path: `${orgsBase}/{orgId}/invitations`,
    summary: 'Invite organization member',
    body: orgs.orgInvitationSchema,
    response: orgs.orgInvitationResponseSchema,
    status: 201,
    idempotencyKey: true,
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
    idempotencyKey: true,
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

function moduleFor(route: OpenApiRoute) {
  return serverModules.find(
    (module) =>
      route.path === module.path ||
      route.path.startsWith(`${module.path}/`) ||
      module.extraRouters?.some(
        (extra) =>
          route.path === extra.path || route.path.startsWith(`${extra.path}/`),
      ),
  );
}

function routeScope(route: OpenApiRoute): ApiScope {
  if (
    route.scope ||
    route.public ||
    route.path === '/healthz' ||
    route.path.includes('/webhooks/')
  ) {
    return route.scope ?? 'public';
  }
  if (route.path.startsWith('/api/v1/platform/')) return 'platform';
  if (
    route.path.startsWith('/api/v1/auth/') ||
    route.path.includes('/me/') ||
    route.path.startsWith('/api/v1/me/') ||
    route.path.startsWith('/api/v1/people/me/') ||
    route.path.startsWith('/api/v1/finance/me/') ||
    route.path === '/api/v1/stream' ||
    route.path === '/api/v1/finance/stripe-client-config' ||
    route.path === '/api/v1/orgs' ||
    route.path === '/api/v1/orgs/mine' ||
    route.path === '/api/v1/orgs/slug-availability' ||
    route.path === '/api/v1/orgs/sport-templates'
  ) {
    return 'account';
  }
  if (/\{(?:orgId|organizationId|tenantId)\}/i.test(route.path))
    return 'organization';
  const module = moduleFor(route);
  if (module?.name === 'files') return 'organization';
  if (module?.name === 'orgs') return 'account';
  if (module?.name === 'platform') return 'platform';
  if (module?.name === 'auth') return 'account';
  if (module) return 'organization';
  throw new Error(
    `OpenAPI route has no security scope: ${route.method} ${route.path}`,
  );
}

function routeResource(route: OpenApiRoute): string {
  if (route.resource) return route.resource;
  const module = moduleFor(route);
  const tail = route.path
    .split('/')
    .slice(3)
    .filter((part) => part.length > 0);
  const tenantIndex = tail.findIndex(
    (part, index) =>
      ['orgs', 'organizations', 'tenants'].includes(part) &&
      /^\{(?:orgId|organizationId|tenantId)\}$/i.test(tail[index + 1] ?? ''),
  );
  const resourceParts = (
    tenantIndex >= 0 ? tail.slice(tenantIndex + 2) : tail
  ).filter((part) => !/^\{.+\}$/.test(part));
  const namespace = module?.name ?? 'system';
  return [namespace, ...resourceParts.slice(0, 2)].join('.');
}

function routePermission(route: OpenApiRoute, scope: ApiScope): string {
  if (route.permission) return route.permission;
  if (scope === 'public') return 'public.access';
  if (scope === 'account') return 'account.self';
  if (scope === 'platform') return 'platform.staff';
  const module = moduleFor(route);
  if (module?.permissions?.length === 1)
    return module.permissions[0] ?? 'organization.member';
  if (module?.name === 'communications') {
    if (route.path.includes('/chat/')) {
      if (route.method === 'get') return 'chat.read';
      if (route.method === 'delete') return 'chat.moderate';
      return 'chat.send';
    }
    return route.method === 'get'
      ? 'communications.read'
      : 'communications.manage';
  }
  if (module?.name === 'finance' && route.path.includes('/me/'))
    return route.method === 'get'
      ? 'finance.payer.read'
      : 'finance.payer.manage';
  const action = route.method === 'get' ? 'read' : 'manage';
  return module ? `${module.name}.${action}` : `organization.${action}`;
}

function exampleValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return {};
  const shape = schema as Record<string, unknown>;
  if ('const' in shape) return shape.const;
  if (Array.isArray(shape.enum) && shape.enum.length > 0) return shape.enum[0];
  for (const union of ['oneOf', 'anyOf'] as const) {
    const variants = shape[union];
    if (Array.isArray(variants) && variants.length > 0)
      return exampleValue(variants[0]);
  }
  const type = shape.type;
  if (type === 'object' || shape.properties) {
    const properties = shape.properties;
    if (!properties || typeof properties !== 'object') return {};
    const required = new Set(
      Array.isArray(shape.required)
        ? shape.required.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    );
    return Object.fromEntries(
      Object.entries(properties).flatMap(([key, property]) =>
        required.has(key) ? [[key, exampleValue(property)]] : [],
      ),
    );
  }
  if (type === 'array') {
    const minimum =
      typeof shape.minItems === 'number' ? Math.max(0, shape.minItems) : 0;
    return Array.from({ length: minimum }, () => exampleValue(shape.items));
  }
  if (type === 'integer' || type === 'number') {
    const minimum =
      typeof shape.minimum === 'number'
        ? shape.minimum
        : typeof shape.exclusiveMinimum === 'number'
          ? shape.exclusiveMinimum + 1
          : 1;
    return type === 'integer' ? Math.ceil(minimum) : minimum;
  }
  if (type === 'boolean') return false;
  if (type === 'string' || Array.isArray(type)) {
    const format = shape.format;
    if (format === 'uuid') return '00000000-0000-4000-8000-000000000001';
    if (format === 'email') return 'security@example.test';
    if (format === 'uri' || format === 'url')
      return 'https://example.test/resource';
    if (format === 'date') return '2026-09-27';
    if (format === 'date-time') return '2026-09-27T12:00:00.000Z';
    const minimum =
      typeof shape.minLength === 'number' ? Math.max(1, shape.minLength) : 1;
    return 'x'.repeat(minimum);
  }
  return {};
}

function routeTenancyFixture(
  route: OpenApiRoute,
  scope: ApiScope,
): OpenApiRoute['tenancyFixture'] | undefined {
  if (route.tenancyFixture) return route.tenancyFixture;
  if (
    scope === 'organization' &&
    route.path.startsWith(`${filesBase}/`) &&
    route.method === 'get' &&
    /\/\{id\}\/(?:download|content)$/.test(route.path)
  ) {
    return { pathResource: 'file' };
  }
  if (
    scope !== 'organization' ||
    !/\{(?:orgId|organizationId|tenantId)\}/i.test(route.path) ||
    !['get', 'patch', 'delete'].includes(route.method)
  ) {
    return undefined;
  }
  const requiredQuery: Record<string, string> = {};
  for (const [name, schema] of Object.entries(route.query ?? {})) {
    if (!schema.safeParse(undefined).success)
      requiredQuery[name] = String(exampleValue(jsonSchema(schema)));
  }
  return {
    body: route.body ? exampleValue(jsonSchema(route.body)) : {},
    ...(Object.keys(requiredQuery).length > 0 ? { query: requiredQuery } : {}),
  };
}

function routeMetadata(route: OpenApiRoute) {
  const scope = routeScope(route);
  return {
    permission: routePermission(route, scope),
    resource: routeResource(route),
    scope,
    tenancyFixture: routeTenancyFixture(route, scope),
  };
}

function operation(route: OpenApiRoute): Record<string, unknown> {
  const metadata = routeMetadata(route);
  const pathNames = [
    ...route.path.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g),
  ].map((match) => match[1] ?? '');
  const parameters = [
    ...pathNames.map((name) => {
      const declaredSchema = route.pathParameters?.[name];
      return {
        name,
        in: 'path',
        required: true,
        schema: declaredSchema
          ? jsonSchema(declaredSchema)
          : name === 'id' || name.endsWith('Id')
            ? { type: 'string', format: 'uuid' }
            : { type: 'string' },
      };
    }),
    ...Object.entries(route.query ?? {}).map(([name, schema]) => ({
      name,
      in: 'query',
      required: !schema.safeParse(undefined).success,
      schema: jsonSchema(schema),
    })),
    ...(route.idempotencyKey
      ? [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ]
      : []),
  ];
  const status = String(route.status ?? 200);
  const result: Record<string, unknown> = {
    operationId: `${route.method}_${route.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    summary: route.summary,
    'x-athlentry-permission': metadata.permission,
    'x-athlentry-resource': metadata.resource,
    'x-athlentry-scope': metadata.scope,
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
  if (metadata.tenancyFixture)
    result['x-athlentry-tenancy-fixture'] = metadata.tenancyFixture;
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
    if (module.router) {
      const primaryPath = `server/src/modules/${module.name}/routes.ts`;
      const primarySource = ts.createSourceFile(
        primaryPath,
        await readFile(primaryPath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      collectRouteCalls(primarySource, module.path, keys);
    }
    for (const extra of module.extraRouters ?? []) {
      const directory = `server/src/modules/${module.name}`;
      const filenames = (await readdir(directory)).filter(
        (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
      );
      let foundFactory = false;
      for (const filename of filenames) {
        const path = `${directory}/${filename}`;
        const code = await readFile(path, 'utf8');
        const sourceFile = ts.createSourceFile(
          path,
          code,
          ts.ScriptTarget.Latest,
          true,
        );
        for (const declaration of sourceFile.statements) {
          if (
            !ts.isFunctionDeclaration(declaration) ||
            declaration.name?.text !== extra.router.name ||
            !declaration.body
          )
            continue;
          foundFactory = true;
          collectRouteCalls(declaration.body, extra.path, keys);
        }
      }
      if (!foundFactory)
        throw new Error(
          `Extra router source not found: ${module.name}.${extra.router.name}`,
        );
    }
  }
  return keys;
}

function collectRouteCalls(
  node: ts.Node,
  mountPath: string,
  keys: Set<string>,
): void {
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === 'router' &&
      ['get', 'post', 'put', 'patch', 'delete'].includes(
        current.expression.name.text,
      )
    ) {
      const argument = current.arguments[0];
      if (!argument || !ts.isStringLiteral(argument))
        throw new Error(
          `OpenAPI cannot inspect a dynamic ${current.expression.name.text} route in ${current.getSourceFile().fileName}`,
        );
      const suffix = argument.text;
      const path = `${mountPath}${suffix === '/' ? '' : suffix}`.replace(
        /:([a-zA-Z][a-zA-Z0-9_]*)/g,
        '{$1}',
      );
      keys.add(`${current.expression.name.text} ${path}`);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
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
const declaredKeys = await declaredRouteKeys();
for (const key of declaredKeys)
  if (!keys.has(key)) throw new Error(`Route missing from OpenAPI: ${key}`);
for (const key of keys)
  if (key !== 'get /healthz' && !declaredKeys.has(key))
    throw new Error(`OpenAPI operation has no route: ${key}`);
const paths: Record<string, Record<string, unknown>> = {};
for (const route of routes) {
  const operations = paths[route.path] ?? {};
  operations[route.method] = operation(route);
  paths[route.path] = operations;
}
const apiRouteMetadata = routes.map((route) => {
  const metadata = routeMetadata(route);
  return {
    operationId: `${route.method}_${route.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    method: route.method,
    path: route.path,
    permission: metadata.permission,
    resource: metadata.resource,
    scope: metadata.scope,
    ...(metadata.tenancyFixture
      ? { tenancyFixture: metadata.tenancyFixture }
      : {}),
  };
});
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
await mkdir('server/src/generated', { recursive: true });
await writeFile(
  'server/src/generated/api-route-metadata.ts',
  await prettier.format(
    `export const apiRouteMetadata = ${JSON.stringify(apiRouteMetadata)} as const;\n`,
    { parser: 'typescript' },
  ),
);

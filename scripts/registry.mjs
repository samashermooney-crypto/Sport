import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import prettier from 'prettier';

async function namesWithFile(directory, filename) {
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(resolve(directory, entry.name));
    if (files.includes(filename)) names.push(entry.name);
  }
  return names.sort();
}

async function nestedRouteDirectories(directory, parts = []) {
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nextParts = [...parts, entry.name];
    const nextDirectory = resolve(directory, entry.name);
    const files = await readdir(nextDirectory);
    if (nextParts.length > 1 && files.includes('routes.tsx')) {
      found.push(nextParts.join('/'));
    }
    found.push(...(await nestedRouteDirectories(nextDirectory, nextParts)));
  }
  return found.sort();
}

async function writeGenerated(path, source) {
  const formatted = await prettier.format(source, {
    parser: 'typescript',
    singleQuote: true,
  });
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const existing = await readFile(target, 'utf8').catch(() => '');
  if (existing !== formatted) await writeFile(target, formatted);
}

function identifier(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid registry module name: ${name}`);
  }
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

for (const [path, symbol] of [
  ['shared/src/generated/errors.ts', 'moduleErrorCodes'],
  ['shared/src/generated/permissions.ts', 'modulePermissions'],
]) {
  const target = resolve(path);
  try {
    await readFile(target, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    await writeGenerated(path, `export const ${symbol} = [] as const;\n`);
  }
}

const serverNames = await namesWithFile('server/src/modules', 'module.ts');
const moduleDefinitions = await Promise.all(
  serverNames.map(async (name) => {
    const source = resolve('server/src/modules', name, 'module.ts');
    const imported = await import(pathToFileURL(source).href);
    const definition = imported.moduleDefinition;
    if (
      !definition ||
      definition.name !== name ||
      definition.path !== `/api/v1/${name}`
    ) {
      throw new Error(`Invalid module descriptor: ${source}`);
    }
    return definition;
  }),
);

const integrationNames = await namesWithFile(
  'server/src/integrations',
  'config.ts',
);
const webRouteNames = await namesWithFile('web/src', 'routes.tsx');
const webNavNames = await namesWithFile('web/src', 'nav.ts');
const nestedWebRouteNames = await nestedRouteDirectories('web/src');
if (webRouteNames.join(',') !== webNavNames.join(',')) {
  throw new Error('Every web feature must have both routes.tsx and nav.ts');
}

const errors = [
  ...new Set(
    moduleDefinitions.flatMap((definition) => definition.errorCodes ?? []),
  ),
].sort();
const { apiRouteMetadata } = await import(
  pathToFileURL(resolve('server/src/generated/api-route-metadata.ts')).href
);
const permissions = [
  ...new Set([
    ...moduleDefinitions.flatMap((definition) => definition.permissions ?? []),
    ...apiRouteMetadata
      .map((operation) => operation.permission)
      .filter(
        (permission) =>
          permission !== 'public.access' &&
          permission !== 'account.self' &&
          permission !== 'platform.staff',
      ),
  ]),
].sort();
const serverImports = [
  ...integrationNames.map(
    (name) =>
      `import { integrationConfig as ${identifier(name)}Config } from '../integrations/${name}/config';`,
  ),
  "import type { IntegrationConfig, ServerModule } from '../lib/module-contract';",
  ...serverNames.map(
    (name) =>
      `import { moduleDefinition as ${identifier(name)}Module } from '../modules/${name}/module';`,
  ),
];
const webImports = [
  "import type { WebFeature } from '../api/features';",
  ...webRouteNames.flatMap((name) => [
    `import { ${identifier(name)}Nav } from '../${name}/nav';`,
    `import { ${identifier(name)}Routes } from '../${name}/routes';`,
  ]),
];
const nestedWebImports = [
  "import type { RouteObject } from 'react-router';",
  '',
  ...nestedWebRouteNames.map((path) => {
    const routeName = path
      .split('/')
      .map((part, index) =>
        index === 0 ? part : part[0].toUpperCase() + part.slice(1),
      )
      .join('');
    return `import { ${routeName}Routes } from '../${path}/routes';`;
  }),
];

await writeGenerated(
  'server/src/generated/registry.ts',
  `${serverImports.join('\n')}

export const serverModules: readonly ServerModule[] = [${serverNames.map((name) => `${identifier(name)}Module`).join(', ')}];
export const integrationConfigs: readonly IntegrationConfig[] = [${integrationNames.map((name) => `${identifier(name)}Config`).join(', ')}];
export { apiRouteMetadata } from './api-route-metadata';
`,
);

await writeGenerated(
  'web/src/generated/registry.ts',
  `${webImports.join('\n')}

export const webFeatures: readonly WebFeature[] = [${webRouteNames.map((name) => `{ name: '${name}', routes: ${identifier(name)}Routes, nav: ${identifier(name)}Nav }`).join(', ')}];
`,
);

await writeGenerated(
  'web/src/generated/nested-routes.ts',
  `${nestedWebImports.join('\n')}

export const webNestedRoutes: readonly RouteObject[] = [${nestedWebRouteNames
    .map(
      (path) =>
        `${path
          .split('/')
          .map((part, index) =>
            index === 0 ? part : part[0].toUpperCase() + part.slice(1),
          )
          .join('')}Routes`,
    )
    .join(', ')}].flat();
`,
);

await writeGenerated(
  'shared/src/generated/errors.ts',
  `export const moduleErrorCodes = ${JSON.stringify(errors)} as const;\n`,
);
await writeGenerated(
  'shared/src/generated/permissions.ts',
  `export const modulePermissions = ${JSON.stringify(permissions)} as const;\n`,
);

const securityRoles = [
  'anonymous',
  'owner',
  'admin',
  'registrar',
  'finance',
  'scheduler',
  'compliance',
  'communications',
  'director',
  'evaluator',
  'volunteer_coordinator',
  'reporter',
  'guardian',
  'self',
  'head_coach',
  'assistant_coach',
  'team_manager',
  'treasurer',
  'official',
  'volunteer',
  'platform_super_admin',
  'platform_support',
  'platform_finance_ops',
];
const platformRoles = [
  'platform_super_admin',
  'platform_support',
  'platform_finance_ops',
];
const organizationRoles = securityRoles.filter(
  (role) => role !== 'anonymous' && !platformRoles.includes(role),
);
const permissionRoles = {
  'public.access': securityRoles,
  'account.self': securityRoles.filter((role) => role !== 'anonymous'),
  'platform.staff': platformRoles,
  'ai.read': organizationRoles,
  'ai.manage': [
    'owner',
    'admin',
    'registrar',
    'treasurer',
    'head_coach',
    'assistant_coach',
    'team_manager',
  ],
  'ai.conversations.read': [
    'owner',
    'admin',
    'registrar',
    'treasurer',
    'head_coach',
    'assistant_coach',
    'team_manager',
  ],
  'action-center.read': [
    'owner',
    'admin',
    'registrar',
    'director',
    'finance',
    'compliance',
    'scheduler',
    'volunteer_coordinator',
    'communications',
  ],
  'action-center.manage': ['owner', 'admin', 'finance', 'compliance'],
  'exports.read': ['owner', 'admin'],
  'exports.manage': ['owner', 'admin'],
  'orgs.read': organizationRoles,
  'orgs.manage': ['owner', 'admin'],
  'notifications.read': organizationRoles,
  'notifications.manage': organizationRoles,
  'files.read': organizationRoles,
  'files.manage': organizationRoles,
  'classes.read': [
    'owner',
    'admin',
    'registrar',
    'scheduler',
    'director',
    'guardian',
    'self',
    'head_coach',
    'assistant_coach',
    'team_manager',
    'volunteer',
  ],
  'classes.manage': ['owner', 'admin', 'director'],
  'federation.read': [
    'owner',
    'admin',
    'director',
    'compliance',
    'scheduler',
    'finance',
    'reporter',
  ],
  'federation.manage': ['owner', 'admin', 'director'],
  'audit.read': ['owner', 'admin', 'compliance', 'reporter'],
  'chat.read': organizationRoles,
  'chat.send': organizationRoles,
  'chat.moderate': ['owner', 'admin', 'compliance'],
  'communications.read': [
    'owner',
    'admin',
    'communications',
    'director',
    'registrar',
    'compliance',
  ],
  'communications.manage': ['owner', 'admin', 'communications', 'director'],
  'compliance.read': ['owner', 'admin', 'compliance'],
  'compliance.manage': ['owner', 'admin', 'compliance'],
  'discipline.read': ['owner', 'admin', 'compliance', 'director', 'head_coach'],
  'discipline.manage': ['owner', 'admin', 'compliance', 'director'],
  'attendance.read': ['owner', 'admin', 'scheduler', 'director', 'reporter'],
  'attendance.manage': ['owner', 'admin', 'scheduler', 'director'],
  'attendance.rsvp': ['guardian', 'self'],
  'evaluations.read': ['owner', 'admin', 'registrar', 'scheduler', 'director'],
  'evaluations.manage': [
    'owner',
    'admin',
    'registrar',
    'scheduler',
    'director',
  ],
  'evaluations.score': ['owner', 'admin', 'director', 'evaluator'],
  'facilities.read': ['owner', 'admin', 'scheduler'],
  'facilities.manage': ['owner', 'admin', 'scheduler'],
  'contests.read': ['owner', 'admin', 'scheduler', 'director', 'reporter'],
  'contests.manage': ['owner', 'admin', 'scheduler'],
  'finance.manage': ['owner', 'admin', 'finance', 'treasurer'],
  'fundraising.read': ['owner', 'admin', 'finance'],
  'fundraising.manage': ['owner', 'admin', 'finance'],
  'imports.read': ['owner', 'admin', 'registrar'],
  'imports.manage': ['owner', 'admin', 'registrar'],
  'forms.read': [
    'owner',
    'admin',
    'registrar',
    'compliance',
    'reporter',
    'guardian',
    'self',
  ],
  'forms.manage': ['owner', 'admin', 'registrar'],
  'forms.person.read': ['guardian', 'self'],
  'forms.responses.read': [
    'owner',
    'admin',
    'registrar',
    'compliance',
    'reporter',
    'guardian',
    'self',
  ],
  'forms.submit': ['owner', 'admin', 'registrar', 'guardian', 'self'],
  'help.read': organizationRoles,
  'help.manage': organizationRoles,
  'onboarding.read': organizationRoles,
  'onboarding.manage': organizationRoles,
  'waivers.read': ['owner', 'admin', 'registrar', 'guardian', 'self'],
  'waivers.manage': ['owner', 'admin', 'registrar'],
  'waivers.person.read': ['guardian', 'self'],
  'waivers.signature.read': ['owner', 'admin', 'registrar', 'guardian', 'self'],
  'waivers.sign': ['owner', 'admin', 'registrar', 'guardian', 'self'],
  'offerings.read': ['owner', 'admin', 'registrar'],
  'offerings.manage': ['owner', 'admin', 'registrar'],
  'officials.read': ['owner', 'admin', 'scheduler', 'official'],
  'officials.manage': ['owner', 'admin', 'scheduler'],
  'people.read': [
    'owner',
    'admin',
    'registrar',
    'compliance',
    'director',
    'head_coach',
    'assistant_coach',
    'team_manager',
  ],
  'people.manage': ['owner', 'admin', 'registrar'],
  'programs.read': ['owner', 'admin', 'registrar'],
  'programs.manage': ['owner', 'admin', 'registrar'],
  'registration.read': ['owner', 'admin', 'registrar'],
  'registration.manage': ['owner', 'admin', 'registrar'],
  'rosters.read': ['owner', 'admin', 'registrar', 'director'],
  'rosters.manage': ['owner', 'admin', 'registrar', 'director'],
  'reports.read': organizationRoles,
  'reports.manage': [
    'owner',
    'admin',
    'registrar',
    'finance',
    'scheduler',
    'compliance',
    'communications',
    'director',
    'evaluator',
    'volunteer_coordinator',
  ],
  'safety.read': ['owner', 'admin', 'compliance'],
  'safety.manage': ['owner', 'admin', 'compliance'],
  'scheduling.read': ['owner', 'admin', 'scheduler', 'director', 'reporter'],
  'scheduling.manage': ['owner', 'admin', 'scheduler'],
  'seasons.read': ['owner', 'admin', 'registrar'],
  'seasons.manage': ['owner', 'admin', 'registrar'],
  'sponsors.read': ['owner', 'admin', 'finance'],
  'sponsors.manage': ['owner', 'admin', 'finance'],
  'sports.read': ['owner', 'admin'],
  'sports.manage': ['owner', 'admin'],
  'standings.read': ['owner', 'admin', 'scheduler', 'director', 'reporter'],
  'standings.manage': ['owner', 'admin', 'scheduler'],
  'store.read': ['owner', 'admin', 'finance', 'store_manager'],
  'store.manage': ['owner', 'admin', 'finance', 'store_manager'],
  'team-finance.read': ['owner', 'admin', 'finance'],
  'team-finance.manage': ['owner', 'admin', 'finance'],
  'teams.read': ['owner', 'admin', 'director'],
  'teams.manage': ['owner', 'admin', 'director'],
  'tournaments.read': ['owner', 'admin', 'scheduler', 'director', 'reporter'],
  'tournaments.manage': ['owner', 'admin', 'scheduler'],
  'volunteers.read': ['owner', 'admin', 'volunteer_coordinator'],
  'volunteers.manage': ['owner', 'admin', 'volunteer_coordinator'],
  'website.read': ['owner', 'admin', 'communications', 'director'],
  'website.manage': ['owner', 'admin', 'communications', 'director'],
};
const operations = Object.fromEntries(
  apiRouteMetadata.map((operation) => {
    const allowed = permissionRoles[operation.permission];
    if (!allowed)
      throw new Error(
        `Permission matrix has no role family for ${operation.permission}`,
      );
    return [
      operation.operationId,
      {
        permission: operation.permission,
        scope: operation.scope,
        allow: securityRoles.filter((role) => allowed.includes(role)),
        deny: securityRoles.filter((role) => !allowed.includes(role)),
      },
    ];
  }),
);
const permissionMatrix = await prettier.format(
  JSON.stringify({ formatVersion: 1, roles: securityRoles, operations }),
  { parser: 'json', printWidth: 80 },
);
const matrixPath = resolve('server/test/security/permission-matrix.json');
const currentMatrix = await readFile(matrixPath, 'utf8').catch(() => '');
if (currentMatrix !== permissionMatrix)
  await writeFile(matrixPath, permissionMatrix);

process.stdout.write(
  `Registry generated: ${String(serverNames.length)} server modules, ${String(integrationNames.length)} integrations, ${String(webRouteNames.length)} web features\n`,
);

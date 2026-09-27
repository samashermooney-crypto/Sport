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
if (webRouteNames.join(',') !== webNavNames.join(',')) {
  throw new Error('Every web feature must have both routes.tsx and nav.ts');
}

const errors = [
  ...new Set(
    moduleDefinitions.flatMap((definition) => definition.errorCodes ?? []),
  ),
].sort();
const permissions = [
  ...new Set(
    moduleDefinitions.flatMap((definition) => definition.permissions ?? []),
  ),
].sort();
const serverImports = [
  "import type { IntegrationConfig, ServerModule } from '../lib/module-contract';",
  ...integrationNames.map(
    (name) =>
      `import { integrationConfig as ${identifier(name)}Config } from '../integrations/${name}/config';`,
  ),
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

await writeGenerated(
  'server/src/generated/registry.ts',
  `${serverImports.join('\n')}

export const serverModules: readonly ServerModule[] = [${serverNames.map((name) => `${identifier(name)}Module`).join(', ')}];
export const integrationConfigs: readonly IntegrationConfig[] = [${integrationNames.map((name) => `${identifier(name)}Config`).join(', ')}];
`,
);

await writeGenerated(
  'web/src/generated/registry.ts',
  `${webImports.join('\n')}

export const webFeatures: readonly WebFeature[] = [${webRouteNames.map((name) => `{ name: '${name}', routes: ${identifier(name)}Routes, nav: ${identifier(name)}Nav }`).join(', ')}];
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

process.stdout.write(
  `Registry generated: ${String(serverNames.length)} server modules, ${String(integrationNames.length)} integrations, ${String(webRouteNames.length)} web features\n`,
);

import { spawnSync } from 'node:child_process';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';

const ownedModules = {
  a: new Set([
    'auth',
    'accounts',
    'orgs',
    'platform',
    'people',
    'households',
    'medical',
    'forms',
    'waivers',
    'imports',
    'sports',
    'seasons',
    'programs',
    'offerings',
    'teams',
    'rosters',
    'facilities',
    'registration',
    'evaluations',
    'audit',
    'notifications',
  ]),
  c: new Set(['files']),
  e: new Set([
    'finance',
    'payments',
    'checkout',
    'team-finance',
    'fundraising',
    'sponsors',
    'store',
  ]),
  f: new Set(['compliance', 'safety', 'discipline']),
  g: new Set([
    'scheduling',
    'contests',
    'standings',
    'tournaments',
    'officials',
    'attendance',
  ]),
  h: new Set(['communications', 'chat']),
};

const migrationRanges = {
  a: [
    [11, 99],
    [200, 499],
    [600, 999],
  ],
  c: [[500, 599]],
  e: [[1000, 1999]],
  f: [[2000, 2999]],
  g: [[3000, 3999]],
  h: [[4000, 4999]],
  i: [[5000, 5999]],
  j: [[6000, 6999]],
  k: [[7000, 7999]],
  l: [[8000, 8999]],
};

function option(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const name = args[0];
if (!name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
  throw new Error('Use: npm run gen:module <lowercase-kebab-name>');
}

const repositoryRoot = resolve(option(args, '--root') ?? '.');
const branch = option(args, '--track')
  ? `track/${option(args, '--track')}`
  : spawnSync('git', ['branch', '--show-current'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).stdout.trim();
const track = /^track\/([a-z])(?:-|$)/.exec(branch)?.[1];
if (!track || !(track in migrationRanges)) {
  throw new Error('Run the module generator from an assigned track branch');
}
if (ownedModules[track] && !ownedModules[track].has(name)) {
  throw new Error(`Track ${track.toUpperCase()} does not own module ${name}`);
}
const activeModuleFiles = await readdir(
  resolve(repositoryRoot, `server/src/modules/${name}`),
).catch(() => []);
if (activeModuleFiles.length > 0) {
  throw new Error(`Refusing to scaffold existing module ${name}`);
}

const migrationDirectory = resolve(repositoryRoot, 'db/migrations');
const migrationFiles = await readdir(migrationDirectory).catch(() => []);
const usedNumbers = new Set(
  migrationFiles
    .map((file) => /^(\d{4})_/.exec(file)?.[1])
    .filter(Boolean)
    .map(Number),
);
let migrationNumber;
for (const [start, end] of migrationRanges[track]) {
  for (let number = start; number <= end; number += 1) {
    if (!usedNumbers.has(number)) {
      migrationNumber = number;
      break;
    }
  }
  if (migrationNumber !== undefined) break;
}
if (migrationNumber === undefined) {
  throw new Error(
    `No migration numbers remain in Track ${track.toUpperCase()}'s range`,
  );
}

const pascal = name
  .split('-')
  .map((part) => part[0].toUpperCase() + part.slice(1))
  .join('');
const camel = pascal[0].toLowerCase() + pascal.slice(1);
const snake = name.replaceAll('-', '_');
const prefix = String(migrationNumber).padStart(4, '0');
const substitutions = {
  __NAME__: name,
  __PASCAL__: pascal,
  __CAMEL__: camel,
  __SNAKE__: snake,
  __MIGRATION__: prefix,
};

const templateDirectory = resolve(import.meta.dirname, 'module-template');
const targets = [
  ['migration.sql.template', `db/migrations/${prefix}_${snake}.sql.template`],
  ['schema.ts.template', `shared/src/schemas/${name}.ts.template`],
  ['repo.ts.template', `server/src/modules/${name}/repo.ts.template`],
  ['service.ts.template', `server/src/modules/${name}/service.ts.template`],
  ['policy.ts.template', `server/src/modules/${name}/policy.ts.template`],
  ['routes.ts.template', `server/src/modules/${name}/routes.ts.template`],
  ['module.ts.template', `server/src/modules/${name}/module.ts.template`],
  [
    'routes.test.ts.template',
    `server/src/modules/${name}/routes.test.ts.template`,
  ],
  ['List.tsx.template', `web/src/${name}/List.tsx.template`],
  ['Detail.tsx.template', `web/src/${name}/Detail.tsx.template`],
  ['Form.tsx.template', `web/src/${name}/Form.tsx.template`],
  ['routes.tsx.template', `web/src/${name}/routes.tsx.template`],
  ['nav.ts.template', `web/src/${name}/nav.ts.template`],
  ['README.md.template', `server/src/modules/${name}/README.generated.md`],
];

for (const [, relativeTarget] of targets) {
  const path = resolve(repositoryRoot, relativeTarget);
  try {
    await readFile(path);
    throw new Error(`Refusing to overwrite ${relativeTarget}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}

for (const [template, relativeTarget] of targets) {
  let content = await readFile(join(templateDirectory, template), 'utf8');
  for (const [token, replacement] of Object.entries(substitutions)) {
    content = content.replaceAll(token, replacement);
  }
  const target = resolve(repositoryRoot, relativeTarget);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { flag: 'wx' });
}

process.stdout.write(
  `Generated inactive ${name} module templates with migration ${prefix}; specialize and rename .template files before running registry or shipping.\n`,
);

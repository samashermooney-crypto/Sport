import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import * as ts from 'typescript';

const root = process.cwd();
const sourceRoots = ['server/src', 'shared/src'];

function isStaticFragment(node, staticConstants = new Set()) {
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return true;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return isStaticFragment(node.expression, staticConstants);
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isStaticFragment(node.whenTrue, staticConstants) &&
      isStaticFragment(node.whenFalse, staticConstants)
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return (
      isStaticFragment(node.left, staticConstants) &&
      isStaticFragment(node.right, staticConstants)
    );
  }
  if (ts.isIdentifier(node) && staticConstants.has(node.text)) return true;
  return false;
}

function staticTopLevelConstants(sourceFile) {
  const names = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !declaration.initializer ||
          names.has(declaration.name.text) ||
          !isStaticFragment(declaration.initializer, names)
        ) {
          continue;
        }
        names.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return names;
}

function importedSqlBindings(sourceFile) {
  const named = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'kysely' ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'sql') {
        named.add(element.name.text);
      }
    }
  }
  return { named, namespaces };
}

function unwrapExpression(node) {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function staticMemberName(node) {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteralLike(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function isSqlRawCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false;
  const access = unwrapExpression(node.expression);
  if (staticMemberName(access) !== 'raw') return false;
  const rawAccess =
    ts.isPropertyAccessExpression(access) ||
    ts.isElementAccessExpression(access)
      ? access.expression
      : access;
  const sqlBinding = unwrapExpression(rawAccess);
  if (ts.isIdentifier(sqlBinding) && bindings.named.has(sqlBinding.text))
    return true;
  if (staticMemberName(sqlBinding) !== 'sql') return false;
  const sqlAccess = unwrapExpression(sqlBinding);
  const kyselyNamespace =
    ts.isPropertyAccessExpression(sqlAccess) ||
    ts.isElementAccessExpression(sqlAccess)
      ? unwrapExpression(sqlAccess.expression)
      : null;
  return (
    kyselyNamespace !== null &&
    ts.isIdentifier(kyselyNamespace) &&
    bindings.namespaces.has(kyselyNamespace.text)
  );
}

function hasReviewedDynamicFragment(sourceText, node) {
  const prefix = sourceText.slice(0, node.getStart());
  const trailingTrivia =
    prefix.match(/(?:\s|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*$/)?.[0] ??
    '';
  return /@sql-raw-safe\b/.test(trailingTrivia);
}

export function findUnsafeSqlRaw(sourceText, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = importedSqlBindings(sourceFile);
  const staticConstants = staticTopLevelConstants(sourceFile);
  const violations = [];

  const visit = (node) => {
    if (isSqlRawCall(node, bindings)) {
      const argument = node.arguments[0];
      if (argument) {
        const interpolatedTemplate = ts.isTemplateExpression(argument);
        const dynamicConcatenation =
          ts.isBinaryExpression(argument) &&
          argument.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          !isStaticFragment(argument);
        const unreviewedDynamicFragment =
          !isStaticFragment(argument, staticConstants) &&
          !hasReviewedDynamicFragment(sourceText, node);
        if (
          interpolatedTemplate ||
          dynamicConcatenation ||
          unreviewedDynamicFragment
        ) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          violations.push({
            line: line + 1,
            argument: argument.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

function verifyGuardExamples() {
  const unsafe = findUnsafeSqlRaw(
    "import { sql as query } from 'kysely'; query.raw(`SELECT ${userValue}`);",
  );
  const staticValue = findUnsafeSqlRaw(
    "import { sql } from 'kysely'; sql.raw('SELECT 1');",
  );
  const reviewedValue = findUnsafeSqlRaw(
    "import { sql } from 'kysely';\nsql`SELECT ${/* @sql-raw-safe: value comes from static route metadata. */ sql.raw(column.source)}`;",
  );
  const staleReview = findUnsafeSqlRaw(
    "import { sql } from 'kysely';\n// @sql-raw-safe: stale note.\nconst marker = true;\nsql.raw(column.source);",
  );
  const dynamicConcatenation = findUnsafeSqlRaw(
    "import { sql } from 'kysely'; sql.raw('SELECT ' + userValue);",
  );
  const elementAccess = findUnsafeSqlRaw(
    "import { sql as query } from 'kysely'; query['raw'](`SELECT ${userValue}`);",
  );
  const namespaceElementAccess = findUnsafeSqlRaw(
    "import * as kysely from 'kysely'; kysely['sql']['raw'](column.source);",
  );
  if (
    unsafe.length !== 1 ||
    staticValue.length ||
    reviewedValue.length ||
    staleReview.length !== 1 ||
    dynamicConcatenation.length !== 1 ||
    elementAccess.length !== 1 ||
    namespaceElementAccess.length !== 1
  ) {
    throw new Error('SQL raw guard self-check failed');
  }
}

async function main() {
  verifyGuardExamples();
  const violations = [];
  for (const directory of sourceRoots) {
    for (const file of await sourceFiles(resolve(root, directory))) {
      const sourceText = await readFile(file, 'utf8');
      for (const violation of findUnsafeSqlRaw(sourceText, file)) {
        violations.push(
          `${relative(root, file)}:${String(violation.line)}: unsafe or unreviewed sql.raw(${violation.argument}); use parameterized sql templates or add a reviewed @sql-raw-safe comment for a trusted static fragment`,
        );
      }
    }
  }
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('No interpolated or unreviewed sql.raw calls found.\n');
}

await main();

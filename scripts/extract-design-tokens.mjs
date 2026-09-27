import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import postcss from 'postcss';

const sources = [
  'legacy/web/styles.css',
  'legacy/web/admin-platform.css',
  'legacy/web/landing.css',
];
const custom = new Map();
const spacing = new Map();
const fontSizes = new Map();
const radii = new Map();
const controlHeights = new Map();
const colors = new Map();
const shadows = new Set();

function count(map, value) {
  map.set(value, (map.get(value) ?? 0) + 1);
}

for (const source of sources) {
  const tree = postcss.parse(await readFile(resolve(source), 'utf8'), {
    from: source,
  });
  tree.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    const value = declaration.value.trim();
    if (property.startsWith('--')) {
      const earlier = custom.get(property);
      if (earlier && earlier !== value) {
        throw new Error(`${property} has multiple legacy values`);
      }
      custom.set(property, value);
      return;
    }
    if (
      /^(gap|row-gap|column-gap|margin|margin-|padding|padding-)/.test(property)
    ) {
      for (const match of value.matchAll(/(?<![\w.-])(\d+)px\b/g)) {
        const number = Number(match[1]);
        if (number > 0 && number <= 64) count(spacing, number);
      }
    }
    if (property === 'font-size' && /^\d+px$/.test(value))
      count(fontSizes, Number(value.slice(0, -2)));
    if (
      property === 'border-radius' &&
      (/^\d+px$/.test(value) || value === '50%')
    )
      count(radii, value);
    if (
      (property === 'height' || property === 'min-height') &&
      /^\d+px$/.test(value)
    ) {
      const number = Number(value.slice(0, -2));
      if (number >= 24 && number <= 68) count(controlHeights, number);
    }
    if (property === 'box-shadow' && value !== 'none') {
      shadows.add(value.replace(/\s+/g, ' '));
    }
    if (/color|background|border|fill|stroke/.test(property)) {
      for (const match of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        count(colors, match[0].toLowerCase());
      }
    }
  });
}

const tokens = Object.fromEntries(custom);
tokens['--font-app'] = '"Open Sans", Arial, sans-serif';
tokens['--font-display'] = '"Barlow Semi Condensed", Arial, sans-serif';
tokens['--font-serif'] = 'Georgia, serif';
for (const [value, uses] of spacing)
  if (uses >= 2) tokens[`--space-${value}`] = `${value}px`;
for (const [value, uses] of fontSizes)
  if (uses >= 2) tokens[`--font-size-${value}`] = `${value}px`;
for (const [value, uses] of radii)
  if (uses >= 2) {
    tokens[
      value === '50%' ? '--radius-round' : `--radius-${value.slice(0, -2)}`
    ] = value;
  }
for (const [value, uses] of controlHeights)
  if (uses >= 2) tokens[`--control-height-${value}`] = `${value}px`;
for (const [value, uses] of colors)
  if (uses >= 3) {
    tokens[`--legacy-color-${value.slice(1)}`] = value;
  }
let shadowNumber = 0;
for (const value of shadows) {
  shadowNumber += 1;
  tokens[`--shadow-${String(shadowNumber).padStart(2, '0')}`] = value;
}

const snapshot = {
  sourceRevision: '9ef77bb',
  sources,
  tokens: Object.fromEntries(
    Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b)),
  ),
};
await writeFile(
  resolve('e2e/visual-reference/tokens.json'),
  JSON.stringify(snapshot, null, 2) + '\n',
);
const css = [
  ':root {',
  ...Object.entries(snapshot.tokens).map(
    ([name, value]) => `  ${name}: ${value};`,
  ),
  '}',
  '',
].join('\n');
await writeFile(resolve('web/src/ui/tokens.css'), css);

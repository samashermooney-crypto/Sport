import { readFile } from 'node:fs/promises';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

interface TokenSnapshot {
  sourceRevision: string;
  tokens: Record<string, string>;
}

function normalizedCssValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replaceAll('"', "'")
    .replace(/,\s*/g, ', ')
    .trim();
}

describe('legacy design tokens', () => {
  it('keeps every frozen custom property and extracted literal at its reference value', async () => {
    const snapshot = JSON.parse(
      await readFile('e2e/visual-reference/tokens.json', 'utf8'),
    ) as TokenSnapshot;
    expect(snapshot.sourceRevision).toBe('9ef77bb');
    const stylesheet = postcss.parse(
      await readFile('web/src/ui/tokens.css', 'utf8'),
    );
    const actual = new Map<string, string>();
    stylesheet.walkDecls((declaration) => {
      actual.set(declaration.prop, normalizedCssValue(declaration.value));
    });
    expect(Object.fromEntries(actual)).toEqual(
      Object.fromEntries(
        Object.entries(snapshot.tokens).map(([name, value]) => [
          name,
          normalizedCssValue(value),
        ]),
      ),
    );
  });
});

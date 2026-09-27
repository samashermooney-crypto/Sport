import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

interface TokenSnapshot {
  sourceRevision: string;
  tokens: Record<string, string>;
}

const forbiddenStyleDependencyPatterns = [
  /^(?:tailwindcss|bootstrap|react-bootstrap|bulma|react-bulma-components|foundation-sites|materialize-css|tachyons|unocss|windicss|daisyui|flowbite|@picocss\/pico)$/,
  /^@tailwindcss\//,
  /^@unocss\//,
  /^(?:styled-components|@emotion\/(?:react|styled)|@stitches\/(?:react|core)|@vanilla-extract\/)/,
  /^(?:linaria|@linaria\/|@compiled\/react|goober|jss)$/,
  /^(?:@mui\/|@material-ui\/|@chakra-ui\/|@mantine\/|@radix-ui\/themes$|shadcn(?:-ui)?$)/,
  /^(?:antd|@ant-design\/|semantic-ui-react|semantic-ui-css)$/,
  /^(?:@blueprintjs\/|@fluentui\/|@carbon\/|@nextui-org\/|@heroui\/|@gluestack-ui\/|@tamagui\/|tamagui$|primereact$|primevue$|vuetify$|quasar$|grommet$|evergreen-ui$)/,
  /^react-select$/,
];

function isForbiddenStyleDependency(name: string): boolean {
  return forbiddenStyleDependencyPatterns.some((pattern) => pattern.test(name));
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

  it('does not add a CSS framework or styled component library', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve('package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const dependencies = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });
    expect(dependencies.filter(isForbiddenStyleDependency)).toEqual([]);
  });

  it('recognizes common CSS frameworks and styled component libraries', () => {
    expect(
      [
        'tailwindcss',
        '@tailwindcss/vite',
        'bootstrap',
        'styled-components',
        '@emotion/react',
        '@mui/material',
        '@chakra-ui/react',
        '@mantine/core',
        '@radix-ui/themes',
        'antd',
        'shadcn-ui',
      ].filter(isForbiddenStyleDependency),
    ).toHaveLength(11);
  });
});

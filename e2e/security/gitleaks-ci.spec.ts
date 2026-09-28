import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

test('SEC-CI-001: Gitleaks scans pull requests and protected-branch pushes', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  expect(workflow).toMatch(/^\s*gitleaks:\s*$/m);
  expect(workflow).toMatch(/gitleaks\/gitleaks-action@v3/);
  expect(workflow).toMatch(/fetch-depth:\s*0/);
  expect(workflow).toMatch(/GITLEAKS_VERSION:\s*8\.29\.1/);
  expect(workflow).toMatch(/gitleaks/i);
  expect(workflow).toMatch(/pull_request/i);
  expect(workflow).toMatch(/push/i);
});

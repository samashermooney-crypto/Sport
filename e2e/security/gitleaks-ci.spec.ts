import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

test.fixme('SEC-CI-001 / Track C: Gitleaks scans pull requests and protected-branch pushes', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  expect(workflow).toMatch(/gitleaks/i);
  expect(workflow).toMatch(/pull_request/i);
  expect(workflow).toMatch(/push/i);
});

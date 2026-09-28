import { expect, it } from 'vitest';

import { isPublicWebsiteDomainAddress } from './domain-security';

it.each([
  ['8.8.8.8', true],
  ['203.0.113.10', false],
  ['127.0.0.1', false],
  ['10.20.30.40', false],
  ['169.254.169.254', false],
  ['2001:4860:4860::8888', true],
  ['2001:db8::1', false],
  ['2002:c000:0201::1', false],
  ['::1', false],
  ['::ffff:127.0.0.1', false],
])('classifies %s as publicly routable: %s', (address, expected) => {
  expect(isPublicWebsiteDomainAddress(address)).toBe(expected);
});

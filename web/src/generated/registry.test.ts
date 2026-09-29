import { describe, expect, it } from 'vitest';

import { consoleNav } from '../console/nav';
import { portalNav } from '../portal/nav';

import { webFeatures } from './registry';

describe('generated web feature registry', () => {
  it('registers the public marketing routes', () => {
    const marketing = webFeatures.find(({ name }) => name === 'marketing');

    expect(marketing?.routes.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['/welcome', '/pricing', '/legal/:slug']),
    );
  });

  it('includes the console and portal evaluation navigation contributions', () => {
    expect(consoleNav.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '/console/orgs/:orgId/evaluations',
        '/console/orgs/:orgId/help',
        '/console/orgs/:orgId/onboarding',
        '/console/orgs/:orgId/onboarding/imports',
      ]),
    );
    expect(portalNav.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '/portal/orgs/:orgId/offers',
        '/portal/orgs/:orgId/results',
        '/portal/orgs/:orgId/placement-preferences',
        '/portal/orgs/:orgId/help',
      ]),
    );
  });
});

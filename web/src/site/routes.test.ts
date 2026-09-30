import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { siteRoutes } from './routes';

describe('generated public site routes', () => {
  it.each([
    ['/site/club/standings/program-id', '/site/:orgSlug/standings/:programId'],
    ['/site/club/brackets/bracket-id', '/site/:orgSlug/brackets/:bracketId'],
    ['/site/club/facilities', '/site/:orgSlug/facilities'],
    ['/site/club/news/season-update', '/site/:orgSlug/news/:newsSlug'],
    [
      '/site/club/facilities/facility-id',
      '/site/:orgSlug/facilities/:facilityId',
    ],
  ])('matches %s to its public view', (pathname, expectedRoute) => {
    const matchedRoute = matchRoutes([...siteRoutes], pathname)?.at(-1)?.route;
    expect(matchedRoute?.path).toBe(expectedRoute);
  });
});

import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';

import { consoleNav } from '../console/nav';
import { portalNav } from '../portal/nav';

import { webNestedRoutes } from './nested-routes';
import { webFeatures } from './registry';
import { webRouteInventory } from './route-inventory';

function registeredPaths(): string[] {
  const paths: string[] = [];
  const visit = (routes: readonly RouteObject[], parent = '') => {
    for (const route of routes) {
      const path = route.path
        ? route.path.startsWith('/')
          ? route.path
          : `${parent.replace(/\/$/, '')}/${route.path}`
        : parent;
      if (route.path) paths.push(path);
      if (route.children) visit(route.children, path);
    }
  };

  visit([
    ...webFeatures.flatMap(({ routes }) => [...routes]),
    ...webNestedRoutes,
  ]);
  return [...new Set(paths)].sort();
}

function matchesRoutePattern(pattern: string, path: string): boolean {
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}/?$`).test(path);
}

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

  it('covers every registered route with actor and synthetic fixture expectations', () => {
    const registered = registeredPaths();

    expect(webRouteInventory.length).toBeGreaterThan(100);
    for (const path of registered) {
      expect(
        webRouteInventory.some((entry) =>
          matchesRoutePattern(entry.path, path),
        ),
        `missing crawler inventory for registered route ${path}`,
      ).toBe(true);
    }
    for (const entry of webRouteInventory) {
      expect(entry.actorContexts.length, entry.path).toBeGreaterThan(0);
      expect(
        entry.fixtures.length,
        `${entry.path} fixture keys should cover every dynamic parameter`,
      ).toBe(
        entry.dynamicParameters.length + (entry.path.includes('*') ? 1 : 0),
      );
      expect(
        registered.some((path) => matchesRoutePattern(entry.path, path)),
        `inventory entry ${entry.path} is not a registered route`,
      ).toBe(true);
    }

    const guardianDocuments = webRouteInventory.find(
      ({ path }) => path === '/me/family/:orgId/:personId/documents',
    );
    expect(guardianDocuments?.actorContexts).toContain('linked-guardian');
    expect(guardianDocuments?.fixtures).toEqual(
      expect.arrayContaining(['organization', 'person']),
    );

    const officialSchedule = webRouteInventory.find(
      ({ path }) => path === '/portal/orgs/:orgId/schedule/officials',
    );
    expect(officialSchedule?.actorContexts).toContain('official');
  });
});

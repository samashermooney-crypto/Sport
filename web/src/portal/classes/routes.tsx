import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

const FamilyAcademyScreen = lazy(() =>
  import('./FamilyAcademyScreen').then(({ FamilyAcademyScreen: screen }) => ({
    default: screen,
  })),
);

function FamilyAcademyRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <PortalShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading classes…</main>}>
        <FamilyAcademyScreen orgId={orgId} />
      </Suspense>
    </PortalShell>
  );
}

export const portalClassesRoutes: readonly RouteObject[] = [
  { path: '/me/orgs/:orgId/classes', element: <FamilyAcademyRoute /> },
];

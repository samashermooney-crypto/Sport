import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { AuditViewer } from './AuditViewer';

function AuditRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <AuditViewer orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

export const auditConsoleRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/audit', element: <AuditRoute /> },
];

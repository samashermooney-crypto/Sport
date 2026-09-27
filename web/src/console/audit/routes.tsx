import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { ConsoleShell } from '../../ui/ConsoleShell';

import { AuditViewer } from './AuditViewer';

function AuditRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <ConsoleShell orgId={orgId}>
      <AuditViewer orgId={orgId} />
    </ConsoleShell>
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleAuditRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/audit', element: <AuditRoute /> },
];

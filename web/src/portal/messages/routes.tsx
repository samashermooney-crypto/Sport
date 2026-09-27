import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

const MessagesPortal = lazy(() =>
  import('./MessagesPortal').then(({ MessagesPortal: Component }) => ({
    default: Component,
  })),
);

function PortalMessagesRoute(): React.JSX.Element {
  const { t } = useTranslation('portal');
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <Suspense
        fallback={
          <main role="status">{t('messageCenter.loadingMessages')}</main>
        }
      >
        <MessagesPortal orgId={orgId} />
      </Suspense>
    </PortalShell>
  ) : (
    <main>{t('messageCenter.organizationNotFound')}</main>
  );
}

export const portalMessagesRoutes: readonly RouteObject[] = [
  { path: '/me/orgs/:orgId/messages', element: <PortalMessagesRoute /> },
];

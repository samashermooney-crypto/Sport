import type { PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { AppShell } from '../ui/shell';

export function PortalShell({
  orgId,
  children,
}: PropsWithChildren<{ orgId: string }>): React.JSX.Element {
  const { t } = useTranslation('portal');
  const location = useLocation();
  const items = [
    {
      label: t('messages'),
      to: `/me/orgs/${orgId}/messages`,
    },
    {
      label: t('notifications'),
      to: `/portal/orgs/${orgId}/notifications`,
    },
    { label: t('money'), to: `/portal/orgs/${orgId}/money` },
    { label: 'Help', to: `/portal/orgs/${orgId}/help` },
    { label: t('account'), to: '/me' },
  ].map((item) => ({ ...item, current: location.pathname === item.to }));
  return (
    <AppShell
      orgName={t('familyPortal')}
      navigation={[{ label: t('navigate'), items }]}
      mobileTabs={items}
    >
      {children}
    </AppShell>
  );
}

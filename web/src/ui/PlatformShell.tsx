import type { PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { AppShell } from './shell';

export function PlatformShell({
  children,
}: PropsWithChildren): React.JSX.Element {
  const { t } = useTranslation('platform');
  const location = useLocation();
  const items = [
    { label: t('platform'), to: '/platform' },
    { label: t('account'), to: '/me' },
  ].map((item) => ({ ...item, current: location.pathname === item.to }));
  return (
    <AppShell
      orgName={t('platformOperations')}
      navigation={[{ label: t('navigate'), items }]}
      mobileTabs={items}
    >
      {children}
    </AppShell>
  );
}

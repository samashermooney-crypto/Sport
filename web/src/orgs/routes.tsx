import type { RouteObject } from 'react-router';

import { ConsoleRouteShell } from '../ui/ConsoleShell';

import { AcceptInvitation } from './AcceptInvitation';
import { AcceptOwnershipTransfer } from './AcceptOwnershipTransfer';
import { Credentials } from './Credentials';
import { Profile } from './Profile';
import { Staff } from './Staff';
import { Start } from './Start';

export const orgsRoutes: readonly RouteObject[] = [
  { path: '/start', element: <Start /> },
  {
    path: '/orgs/:orgId/credentials',
    element: (
      <ConsoleRouteShell>
        <Credentials />
      </ConsoleRouteShell>
    ),
  },
  {
    path: '/orgs/:orgId/profile',
    element: (
      <ConsoleRouteShell>
        <Profile />
      </ConsoleRouteShell>
    ),
  },
  {
    path: '/orgs/:orgId/staff',
    element: (
      <ConsoleRouteShell>
        <Staff />
      </ConsoleRouteShell>
    ),
  },
  { path: '/invitations/:orgId/:token', element: <AcceptInvitation /> },
  {
    path: '/ownership-transfer/:orgId/:token',
    element: <AcceptOwnershipTransfer />,
  },
];

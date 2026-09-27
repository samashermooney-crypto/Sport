import type { RouteObject } from 'react-router';

import { AcceptInvitation } from './AcceptInvitation';
import { AcceptOwnershipTransfer } from './AcceptOwnershipTransfer';
import { Credentials } from './Credentials';
import { Profile } from './Profile';
import { Staff } from './Staff';
import { Start } from './Start';

export const orgsRoutes: readonly RouteObject[] = [
  { path: '/start', element: <Start /> },
  { path: '/orgs/:orgId/credentials', element: <Credentials /> },
  { path: '/orgs/:orgId/profile', element: <Profile /> },
  { path: '/orgs/:orgId/staff', element: <Staff /> },
  { path: '/invitations/:orgId/:token', element: <AcceptInvitation /> },
  {
    path: '/ownership-transfer/:orgId/:token',
    element: <AcceptOwnershipTransfer />,
  },
];

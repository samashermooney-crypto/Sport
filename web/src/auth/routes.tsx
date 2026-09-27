import type { RouteObject } from 'react-router';

import { AccountHome } from './AccountHome';
import { MagicRequest } from './MagicRequest';
import { MfaChallenge } from './MfaChallenge';
import { ResetConfirm } from './ResetConfirm';
import { ResetRequest } from './ResetRequest';
import { SecuritySettings } from './SecuritySettings';
import { SignIn } from './SignIn';
import { SignUp } from './SignUp';
import { TokenAction } from './TokenAction';

export const authRoutes: readonly RouteObject[] = [
  { path: '/', element: <SignIn /> },
  { path: '/sign-up', element: <SignUp /> },
  { path: '/forgot-password', element: <ResetRequest /> },
  { path: '/reset/:token', element: <ResetConfirm /> },
  { path: '/email-link', element: <MagicRequest /> },
  { path: '/magic/:token', element: <TokenAction purpose="magic" /> },
  { path: '/verify/:token', element: <TokenAction purpose="verify" /> },
  {
    path: '/verify-email-change/:token',
    element: <TokenAction purpose="email-change" />,
  },
  { path: '/mfa', element: <MfaChallenge /> },
  { path: '/me', element: <AccountHome /> },
  { path: '/me/security', element: <SecuritySettings /> },
];

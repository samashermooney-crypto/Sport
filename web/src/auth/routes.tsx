import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

import { RouteLoading } from '../ui/RouteLoading';

const AccountHome = lazy(() =>
  import('./AccountHome').then(({ AccountHome: Component }) => ({
    default: Component,
  })),
);
const MagicRequest = lazy(() =>
  import('./MagicRequest').then(({ MagicRequest: Component }) => ({
    default: Component,
  })),
);
const MfaChallenge = lazy(() =>
  import('./MfaChallenge').then(({ MfaChallenge: Component }) => ({
    default: Component,
  })),
);
const ResetConfirm = lazy(() =>
  import('./ResetConfirm').then(({ ResetConfirm: Component }) => ({
    default: Component,
  })),
);
const ResetRequest = lazy(() =>
  import('./ResetRequest').then(({ ResetRequest: Component }) => ({
    default: Component,
  })),
);
const SecuritySettings = lazy(() =>
  import('./SecuritySettings').then(({ SecuritySettings: Component }) => ({
    default: Component,
  })),
);
const SignIn = lazy(() =>
  import('./SignIn').then(({ SignIn: Component }) => ({ default: Component })),
);
const SignUp = lazy(() =>
  import('./SignUp').then(({ SignUp: Component }) => ({ default: Component })),
);
const TokenAction = lazy(() =>
  import('./TokenAction').then(({ TokenAction: Component }) => ({
    default: Component,
  })),
);

function loading(element: React.ReactNode): React.JSX.Element {
  return <Suspense fallback={<RouteLoading />}>{element}</Suspense>;
}

export const authRoutes: readonly RouteObject[] = [
  { path: '/', element: loading(<SignIn />) },
  { path: '/sign-up', element: loading(<SignUp />) },
  { path: '/forgot-password', element: loading(<ResetRequest />) },
  { path: '/reset/:token', element: loading(<ResetConfirm />) },
  { path: '/email-link', element: loading(<MagicRequest />) },
  {
    path: '/magic/:token',
    element: loading(<TokenAction purpose="magic" />),
  },
  {
    path: '/verify/:token',
    element: loading(<TokenAction purpose="verify" />),
  },
  {
    path: '/verify-email-change/:token',
    element: loading(<TokenAction purpose="email-change" />),
  },
  { path: '/mfa', element: loading(<MfaChallenge />) },
  { path: '/me', element: loading(<AccountHome />) },
  { path: '/me/security', element: loading(<SecuritySettings />) },
];

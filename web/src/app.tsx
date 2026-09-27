import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';

import { AccountHome } from './auth/AccountHome';
import { MagicRequest } from './auth/MagicRequest';
import { MfaChallenge } from './auth/MfaChallenge';
import { ResetConfirm } from './auth/ResetConfirm';
import { ResetRequest } from './auth/ResetRequest';
import { SecuritySettings } from './auth/SecuritySettings';
import { SignIn } from './auth/SignIn';
import { SignUp } from './auth/SignUp';
import { TokenAction } from './auth/TokenAction';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="/sign-up" element={<SignUp />} />
          <Route path="/forgot-password" element={<ResetRequest />} />
          <Route path="/reset/:token" element={<ResetConfirm />} />
          <Route path="/email-link" element={<MagicRequest />} />
          <Route
            path="/magic/:token"
            element={<TokenAction purpose="magic" />}
          />
          <Route
            path="/verify/:token"
            element={<TokenAction purpose="verify" />}
          />
          <Route
            path="/verify-email-change/:token"
            element={<TokenAction purpose="email-change" />}
          />
          <Route path="/mfa" element={<MfaChallenge />} />
          <Route path="/me" element={<AccountHome />} />
          <Route path="/me/security" element={<SecuritySettings />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

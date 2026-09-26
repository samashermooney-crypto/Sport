import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { SignIn } from './auth/SignIn';
import './ui/sign-in.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');
createRoot(root).render(
  <StrictMode>
    <SignIn />
  </StrictMode>,
);

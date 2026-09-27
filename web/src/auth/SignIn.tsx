import { authSignInResponseSchema } from '@shared/schemas/auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';

import { apiPost } from '../api/client';
import { AuthFrame, AuthLink, Button, ErrorBox, Field } from '../ui/auth';

interface Credentials {
  email: string;
  password: string;
}

export function SignIn(): React.JSX.Element {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>();

  async function submit(values: Credentials): Promise<void> {
    setError('');
    try {
      const result = await apiPost(
        '/auth/sign-in',
        values,
        authSignInResponseSchema,
      );
      if (result.status === 'mfa_required') {
        void navigate('/mfa', {
          state: { challengeToken: result.challengeToken },
        });
      } else {
        void navigate('/me', { replace: true });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed.');
    }
  }

  return (
    <AuthFrame>
      <h1>Welcome back.</h1>
      <p>Sign in to manage your organization.</p>
      <ErrorBox error={error} />
      <form onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
        <Field label="Email address" required error={errors.email?.message}>
          <input
            type="email"
            autoComplete="username"
            {...register('email', {
              required: 'Enter your email address.',
              pattern: {
                value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                message: 'Enter a valid email address.',
              },
            })}
          />
        </Field>
        <Field label="Password" required error={errors.password?.message}>
          <input
            type="password"
            autoComplete="current-password"
            {...register('password', {
              required: 'Enter your password.',
            })}
          />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="auth-secondary">
        <AuthLink to="/forgot-password">Forgot your password?</AuthLink>
      </p>
      <p className="auth-secondary">
        <AuthLink to="/email-link">Email me a sign-in link</AuthLink>
      </p>
      <p className="auth-secondary">
        <AuthLink to="/sign-up">Create an account</AuthLink>
      </p>
    </AuthFrame>
  );
}

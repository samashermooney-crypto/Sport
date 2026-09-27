import { authStatusResponseSchema } from '@shared/schemas/auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router';

import { apiPost } from '../api/client';
import {
  AuthFrame,
  AuthLink,
  Button,
  ErrorBox,
  Field,
  Input,
} from '../ui/auth';

interface ChallengeState {
  challengeToken: string;
}

export function MfaChallenge(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as ChallengeState | null;
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [error, setError] = useState('');
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<{ code: string }>();

  if (!state?.challengeToken) {
    return (
      <AuthFrame>
        <h1>Sign in again</h1>
        <p>Your verification challenge is no longer available.</p>
        <AuthLink to="/">Return to sign in</AuthLink>
      </AuthFrame>
    );
  }

  async function submit(values: { code: string }): Promise<void> {
    setError('');
    try {
      await apiPost(
        '/auth/mfa/challenge',
        {
          challengeToken: state?.challengeToken,
          code: values.code.trim(),
          method,
        },
        authStatusResponseSchema,
      );
      void navigate('/me', { replace: true, state: null });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Verification failed. Sign in again.',
      );
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">Start over</AuthLink>}>
      <h1>Verify it’s you</h1>
      <p>
        {method === 'totp'
          ? 'Enter the six-digit code from your authenticator app.'
          : 'Enter one unused recovery code.'}
      </p>
      <ErrorBox error={error} />
      <form onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
        <Field
          label={method === 'totp' ? 'Authenticator code' : 'Recovery code'}
          required
          error={errors.code?.message}
        >
          <Input
            autoComplete="one-time-code"
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            {...register('code', { required: 'Enter your code.' })}
          />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Verifying…' : 'Verify and sign in'}
        </Button>
      </form>
      <p className="auth-secondary">
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setMethod(method === 'totp' ? 'recovery' : 'totp');
            reset();
            setError('');
          }}
        >
          {method === 'totp'
            ? 'Use a recovery code'
            : 'Use an authenticator code'}
        </button>
      </p>
    </AuthFrame>
  );
}

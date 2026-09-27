import { authStatusResponseSchema } from '@shared/schemas/auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('auth');
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
        <h1>{t('signInAgain')}</h1>
        <p>{t('challengeExpired')}</p>
        <AuthLink to="/">{t('returnToSignIn')}</AuthLink>
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
        caught instanceof Error ? caught.message : t('verificationFailed'),
      );
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">{t('startOver')}</AuthLink>}>
      <h1>{t('verifyIdentity')}</h1>
      <p>
        {method === 'totp'
          ? t('authenticatorInstructions')
          : t('recoveryInstructions')}
      </p>
      <ErrorBox error={error} />
      <form onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
        <Field
          label={method === 'totp' ? t('authenticatorCode') : t('recoveryCode')}
          required
          error={errors.code?.message}
        >
          <Input
            autoComplete="one-time-code"
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            {...register('code', { required: t('codeRequired') })}
          />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('verifying') : t('verifyAndSignIn')}
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
          {method === 'totp' ? t('useRecoveryCode') : t('useAuthenticatorCode')}
        </button>
      </p>
    </AuthFrame>
  );
}

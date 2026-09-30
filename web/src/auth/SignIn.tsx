import {
  authMeResponseSchema,
  authSignInResponseSchema,
} from '@shared/schemas/auth';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import {
  AuthFrame,
  AuthLink,
  Button,
  ErrorBox,
  Field,
  Input,
} from '../ui/auth';

interface Credentials {
  email: string;
  password: string;
}

export function SignIn(): React.JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation('auth');
  const [error, setError] = useState('');
  // Someone already signed in goes to their account home, not this form.
  const session = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
    retry: false,
  });
  useEffect(() => {
    if (session.data) void navigate('/me', { replace: true });
  }, [session.data, navigate]);
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
      setError(caught instanceof Error ? caught.message : t('signInFailed'));
    }
  }

  return (
    <AuthFrame>
      <h1>{t('welcome')}</h1>
      <p>{t('signInDescription')}</p>
      <ErrorBox error={error} />
      <form onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
        <Field label={t('emailAddress')} required error={errors.email?.message}>
          <Input
            type="email"
            autoComplete="username"
            {...register('email', {
              required: t('emailRequired'),
              pattern: {
                value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                message: t('emailInvalid'),
              },
            })}
          />
        </Field>
        <Field label={t('password')} required error={errors.password?.message}>
          <Input
            type="password"
            autoComplete="current-password"
            {...register('password', {
              required: t('passwordRequired'),
            })}
          />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('signingIn') : t('signIn')}
        </Button>
      </form>
      <p className="auth-secondary">
        <AuthLink to="/forgot-password">{t('forgotPassword')}</AuthLink>
      </p>
      <p className="auth-secondary">
        <AuthLink to="/email-link">{t('emailLink')}</AuthLink>
      </p>
      <p className="auth-secondary">
        <AuthLink to="/sign-up">{t('createAccount')}</AuthLink>
      </p>
    </AuthFrame>
  );
}

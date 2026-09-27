import { zodResolver } from '@hookform/resolvers/zod';
import {
  authLegalResponseSchema,
  authCaptchaConfigResponseSchema,
  authMessageResponseSchema,
  signUpSchema,
} from '@shared/schemas/auth';
import type { SignUpInput } from '@shared/schemas/auth';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiGet, apiPost } from '../api/client';
import { i18n } from '../lib/i18n';
import {
  AuthFrame,
  AuthLink,
  Button,
  Checkbox,
  ErrorBox,
  Field,
  Input,
} from '../ui/auth';

import { TurnstileWidget } from './TurnstileWidget';

export function SignUp(): React.JSX.Element {
  const legal = useQuery({
    queryKey: ['auth', 'legal'],
    queryFn: () => apiGet('/auth/legal', authLegalResponseSchema),
  });
  const captcha = useQuery({
    queryKey: ['auth', 'captcha-config'],
    queryFn: () =>
      apiGet('/auth/captcha-config', authCaptchaConfigResponseSchema),
  });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { captchaToken: '' },
  });
  const captchaToken = watch('captchaToken');
  useEffect(() => {
    if (captcha.data?.mode === 'preview')
      setValue('captchaToken', 'local-preview');
  }, [captcha.data, setValue]);
  const onToken = useCallback(
    (token: string) => {
      setValue('captchaToken', token, { shouldValidate: true });
    },
    [setValue],
  );
  const onChallengeError = useCallback((message: string) => {
    setError(message);
  }, []);

  async function submit(values: SignUpInput): Promise<void> {
    setError('');
    try {
      const result = await apiPost(
        '/auth/sign-up',
        { ...values, locale: i18n.resolvedLanguage === 'es' ? 'es' : 'en' },
        authMessageResponseSchema,
      );
      setMessage(result.message);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Account creation failed.',
      );
      if (captcha.data?.mode === 'turnstile') {
        setValue('captchaToken', '');
        setChallengeAttempt((previous) => previous + 1);
      }
    }
  }

  return (
    <AuthFrame
      footer={<AuthLink to="/">Already have an account? Sign in</AuthLink>}
    >
      <h1>Create your account</h1>
      {message ? (
        <p role="status">{message}</p>
      ) : (
        <>
          <p>
            You must be at least 13. A parent or guardian manages younger
            athletes.
          </p>
          <ErrorBox error={error} />
          {(legal.isPending || captcha.isPending) && (
            <p role="status">Loading account requirements…</p>
          )}
          {(legal.isError || captcha.isError) && (
            <ErrorBox error="Account requirements could not be loaded. Try again later." />
          )}
          {legal.isSuccess && captcha.isSuccess && (
            <form
              onSubmit={(event) => void handleSubmit(submit)(event)}
              noValidate
            >
              <Field
                label="First name"
                required
                error={errors.firstName?.message}
              >
                <Input autoComplete="given-name" {...register('firstName')} />
              </Field>
              <Field
                label="Last name"
                required
                error={errors.lastName?.message}
              >
                <Input autoComplete="family-name" {...register('lastName')} />
              </Field>
              <Field
                label="Email address"
                required
                error={errors.email?.message}
              >
                <Input
                  type="email"
                  autoComplete="email"
                  {...register('email')}
                />
              </Field>
              <Field
                label="Date of birth"
                required
                error={errors.dateOfBirth?.message}
              >
                <Input
                  type="date"
                  autoComplete="bday"
                  {...register('dateOfBirth')}
                />
              </Field>
              <Field label="Password" required error={errors.password?.message}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...register('password')}
                />
              </Field>
              <details className="legal-text">
                <summary>Terms of service ({legal.data.terms.version})</summary>
                <p>{legal.data.terms.text}</p>
              </details>
              <label className="consent">
                <Checkbox {...register('termsAccepted')} /> I have read and
                accept the Terms of service.
              </label>
              {errors.termsAccepted && (
                <small className="field-error" role="alert">
                  Accept the Terms to continue.
                </small>
              )}
              <details className="legal-text">
                <summary>Privacy notice ({legal.data.privacy.version})</summary>
                <p>{legal.data.privacy.text}</p>
              </details>
              <label className="consent">
                <Checkbox {...register('privacyAccepted')} /> I have read and
                accept the Privacy notice.
              </label>
              {errors.privacyAccepted && (
                <small className="field-error" role="alert">
                  Accept the Privacy notice to continue.
                </small>
              )}
              {captcha.data.mode === 'turnstile' && (
                <TurnstileWidget
                  key={challengeAttempt}
                  siteKey={captcha.data.siteKey}
                  onToken={onToken}
                  onError={onChallengeError}
                />
              )}
              <input type="hidden" {...register('captchaToken')} />
              {errors.captchaToken && (
                <small className="field-error" role="alert">
                  Complete the bot protection challenge.
                </small>
              )}
              <Button type="submit" disabled={isSubmitting || !captchaToken}>
                {isSubmitting ? 'Creating account…' : 'Create account'}
              </Button>
            </form>
          )}
        </>
      )}
    </AuthFrame>
  );
}

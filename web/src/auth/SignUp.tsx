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
import { useTranslation } from 'react-i18next';

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
  const { t, i18n: language } = useTranslation('auth');
  const locale = language.resolvedLanguage === 'es' ? 'es' : 'en';
  const legal = useQuery({
    queryKey: ['auth', 'legal', locale],
    queryFn: () =>
      apiGet(`/auth/legal?locale=${locale}`, authLegalResponseSchema),
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
      await apiPost(
        '/auth/sign-up',
        { ...values, locale: i18n.resolvedLanguage === 'es' ? 'es' : 'en' },
        authMessageResponseSchema,
      );
      setMessage(t('accountCreated'));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t('createAccountFailed'),
      );
      if (captcha.data?.mode === 'turnstile') {
        setValue('captchaToken', '');
        setChallengeAttempt((previous) => previous + 1);
      }
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">{t('alreadyHaveAccount')}</AuthLink>}>
      <h1>{t('createYourAccount')}</h1>
      {message ? (
        <p role="status">{message}</p>
      ) : (
        <>
          <p>{t('minimumAge')}</p>
          <ErrorBox error={error} />
          {(legal.isPending || captcha.isPending) && (
            <p role="status">{t('loadingRequirements')}</p>
          )}
          {(legal.isError || captcha.isError) && (
            <ErrorBox error={t('requirementsFailed')} />
          )}
          {legal.isSuccess && captcha.isSuccess && (
            <form
              onSubmit={(event) => void handleSubmit(submit)(event)}
              noValidate
            >
              <Field
                label={t('firstName')}
                required
                error={errors.firstName?.message}
              >
                <Input autoComplete="given-name" {...register('firstName')} />
              </Field>
              <Field
                label={t('lastName')}
                required
                error={errors.lastName?.message}
              >
                <Input autoComplete="family-name" {...register('lastName')} />
              </Field>
              <Field
                label={t('emailAddress')}
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
                label={t('dateOfBirth')}
                required
                error={errors.dateOfBirth?.message}
              >
                <Input
                  type="date"
                  autoComplete="bday"
                  {...register('dateOfBirth')}
                />
              </Field>
              <Field
                label={t('password')}
                required
                error={errors.password?.message}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...register('password')}
                />
              </Field>
              <details className="legal-text">
                <summary>
                  {t('termsTitle', { version: legal.data.terms.version })}
                </summary>
                <p>{legal.data.terms.text}</p>
              </details>
              <label className="consent">
                <Checkbox {...register('termsAccepted')} /> {t('acceptTerms')}
              </label>
              {errors.termsAccepted && (
                <small className="field-error" role="alert">
                  {t('termsRequired')}
                </small>
              )}
              <details className="legal-text">
                <summary>
                  {t('privacyTitle', { version: legal.data.privacy.version })}
                </summary>
                <p>{legal.data.privacy.text}</p>
              </details>
              <label className="consent">
                <Checkbox {...register('privacyAccepted')} />{' '}
                {t('acceptPrivacy')}
              </label>
              {errors.privacyAccepted && (
                <small className="field-error" role="alert">
                  {t('privacyRequired')}
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
                  {t('captchaRequired')}
                </small>
              )}
              <Button type="submit" disabled={isSubmitting || !captchaToken}>
                {isSubmitting ? t('creatingAccount') : t('createAccountAction')}
              </Button>
            </form>
          )}
        </>
      )}
    </AuthFrame>
  );
}

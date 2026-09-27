import { authStatusResponseSchema } from '@shared/schemas/auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { apiPost } from '../api/client';
import {
  AuthFrame,
  AuthLink,
  Button,
  ErrorBox,
  Field,
  Input,
} from '../ui/auth';

interface ResetFields {
  newPassword: string;
  confirmPassword: string;
}

export function ResetConfirm(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const { token } = useParams();
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetFields>();

  async function submit(values: ResetFields): Promise<void> {
    if (!token) return;
    setError('');
    try {
      await apiPost(
        '/auth/password/reset/confirm',
        { token, newPassword: values.newPassword },
        authStatusResponseSchema,
      );
      setComplete(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t('passwordResetFailed'),
      );
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">{t('backToSignIn')}</AuthLink>}>
      <h1>{t('choosePassword')}</h1>
      {complete ? (
        <p role="status">{t('passwordChanged')}</p>
      ) : (
        <>
          <p>{t('passwordAdvice')}</p>
          <ErrorBox error={error} />
          <form
            onSubmit={(event) => void handleSubmit(submit)(event)}
            noValidate
          >
            <Field
              label={t('newPassword')}
              required
              error={errors.newPassword?.message}
            >
              <Input
                type="password"
                autoComplete="new-password"
                {...register('newPassword', {
                  required: t('newPasswordRequired'),
                  minLength: {
                    value: 10,
                    message: t('passwordMinLength'),
                  },
                })}
              />
            </Field>
            <Field
              label={t('confirmPassword')}
              required
              error={errors.confirmPassword?.message}
            >
              <Input
                type="password"
                autoComplete="new-password"
                {...register('confirmPassword', {
                  required: t('confirmPasswordRequired'),
                  validate: (value) =>
                    value === watch('newPassword') || t('passwordMismatch'),
                })}
              />
            </Field>
            <Button type="submit" disabled={isSubmitting || !token}>
              {isSubmitting ? t('updating') : t('resetPassword')}
            </Button>
          </form>
        </>
      )}
    </AuthFrame>
  );
}

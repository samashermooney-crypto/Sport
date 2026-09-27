import { authMessageResponseSchema } from '@shared/schemas/auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { apiPost } from '../api/client';
import {
  AuthFrame,
  AuthLink,
  Button,
  ErrorBox,
  Field,
  Input,
} from '../ui/auth';

export function MagicRequest(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string }>();

  async function submit(values: { email: string }): Promise<void> {
    setError('');
    try {
      await apiPost('/auth/magic/request', values, authMessageResponseSchema);
      setMessage(t('magicRequested'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'));
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">{t('backToSignIn')}</AuthLink>}>
      <h1>{t('magicTitle')}</h1>
      <p>{t('magicDescription')}</p>
      <ErrorBox error={error} />
      {message ? (
        <p role="status">{message}</p>
      ) : (
        <form onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
          <Field
            label={t('emailAddress')}
            required
            error={errors.email?.message}
          >
            <Input
              type="email"
              autoComplete="email"
              {...register('email', { required: t('emailRequired') })}
            />
          </Field>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('sending') : t('sendMagicLink')}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

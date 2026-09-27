import { authMessageResponseSchema } from '@shared/schemas/auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiPost } from '../api/client';
import { AuthFrame, AuthLink, Button, ErrorBox, Field } from '../ui/auth';

export function ResetRequest(): React.JSX.Element {
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
      const result = await apiPost(
        '/auth/password/reset/request',
        values,
        authMessageResponseSchema,
      );
      setMessage(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed.');
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">Back to sign in</AuthLink>}>
      <h1>Reset your password</h1>
      <p>
        Enter your account email. If it has an account, we’ll send a reset link.
      </p>
      <ErrorBox error={error} />
      {message ? (
        <p role="status">{message}</p>
      ) : (
        <form onSubmit={(event) => void handleSubmit(submit)(event)} noValidate>
          <Field label="Email address" required error={errors.email?.message}>
            <input
              type="email"
              autoComplete="email"
              {...register('email', { required: 'Enter your email address.' })}
            />
          </Field>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

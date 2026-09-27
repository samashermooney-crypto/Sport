import { authStatusResponseSchema } from '@shared/schemas/auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router';

import { apiPost } from '../api/client';
import { AuthFrame, AuthLink, Button, ErrorBox, Field } from '../ui/auth';

interface ResetFields {
  newPassword: string;
  confirmPassword: string;
}

export function ResetConfirm(): React.JSX.Element {
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
        caught instanceof Error ? caught.message : 'Password reset failed.',
      );
    }
  }

  return (
    <AuthFrame footer={<AuthLink to="/">Back to sign in</AuthLink>}>
      <h1>Choose a new password</h1>
      {complete ? (
        <p role="status">Password changed. You can now sign in.</p>
      ) : (
        <>
          <p>Use at least 10 characters. Avoid a password you use elsewhere.</p>
          <ErrorBox error={error} />
          <form
            onSubmit={(event) => void handleSubmit(submit)(event)}
            noValidate
          >
            <Field
              label="New password"
              required
              error={errors.newPassword?.message}
            >
              <input
                type="password"
                autoComplete="new-password"
                {...register('newPassword', {
                  required: 'Enter a new password.',
                  minLength: {
                    value: 10,
                    message: 'Use at least 10 characters.',
                  },
                })}
              />
            </Field>
            <Field
              label="Confirm new password"
              required
              error={errors.confirmPassword?.message}
            >
              <input
                type="password"
                autoComplete="new-password"
                {...register('confirmPassword', {
                  required: 'Confirm your new password.',
                  validate: (value) =>
                    value === watch('newPassword') || 'Passwords do not match.',
                })}
              />
            </Field>
            <Button type="submit" disabled={isSubmitting || !token}>
              {isSubmitting ? 'Updating…' : 'Reset password'}
            </Button>
          </form>
        </>
      )}
    </AuthFrame>
  );
}

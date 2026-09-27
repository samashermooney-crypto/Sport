import {
  authMeResponseSchema,
  authStatusResponseSchema,
  deletionRequestResponseSchema,
  mfaEnrollmentResponseSchema,
  recoveryCodesResponseSchema,
  sessionsResponseSchema,
} from '@shared/schemas/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';

import { apiDelete, apiGet, apiPost } from '../api/client';
import { disconnectBrowserPush } from '../push/browser';
import {
  AuthFrame,
  AuthLink,
  Button,
  ErrorBox,
  Field,
  Input,
  Select,
} from '../ui/auth';

import { BrowserPush } from './BrowserPush';

interface PasswordFields {
  currentPassword: string;
  newPassword: string;
}
interface EmailFields {
  email: string;
}
interface CodeFields {
  code: string;
}
interface StepUpFields {
  secret: string;
}

export function SecuritySettings(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const account = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
  });
  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => apiGet('/auth/sessions', sessionsResponseSchema),
    enabled: account.isSuccess,
  });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    manualKey: string;
    qr: string;
  } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [stepMethod, setStepMethod] = useState<'password' | 'totp'>('password');
  const passwordForm = useForm<PasswordFields>();
  const emailForm = useForm<EmailFields>();
  const codeForm = useForm<CodeFields>();
  const stepForm = useForm<StepUpFields>();

  async function perform(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The request failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(values: PasswordFields): Promise<void> {
    await perform(async () => {
      await apiPost('/auth/password/change', values, authStatusResponseSchema);
      passwordForm.reset();
      setNotice('Password changed. Other sessions have been revoked.');
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    });
  }

  async function changeEmail(values: EmailFields): Promise<void> {
    await perform(async () => {
      await apiPost(
        '/auth/email/change/request',
        values,
        authStatusResponseSchema,
      );
      emailForm.reset();
      setNotice(
        'Check your new address for a confirmation link. Your old address was notified.',
      );
    });
  }

  async function stepUp(values: StepUpFields): Promise<void> {
    await perform(async () => {
      await apiPost(
        '/auth/step-up',
        stepMethod === 'password'
          ? { method: 'password', password: values.secret }
          : { method: 'totp', code: values.secret },
        authStatusResponseSchema,
      );
      stepForm.reset();
      setNotice('Identity confirmed for 15 minutes.');
    });
  }

  async function startEnrollment(): Promise<void> {
    await perform(async () => {
      const result = await apiPost(
        '/auth/mfa/enroll/start',
        {},
        mfaEnrollmentResponseSchema,
      );
      const qr = await QRCode.toDataURL(result.otpauthUrl, {
        margin: 1,
        width: 192,
      });
      setEnrollment({ manualKey: result.manualKey, qr });
      setCodes(null);
    });
  }

  async function confirmEnrollment(values: CodeFields): Promise<void> {
    await perform(async () => {
      const result = await apiPost(
        '/auth/mfa/enroll/confirm',
        values,
        recoveryCodesResponseSchema,
      );
      setEnrollment(null);
      setCodes(result.codes);
      codeForm.reset();
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    });
  }

  async function regenerateCodes(): Promise<void> {
    await perform(async () => {
      const result = await apiPost(
        '/auth/mfa/recovery/regenerate',
        {},
        recoveryCodesResponseSchema,
      );
      setCodes(result.codes);
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    });
  }

  async function revoke(id: string, current: boolean): Promise<void> {
    await perform(async () => {
      if (current) await disconnectBrowserPush();
      await apiDelete(`/auth/sessions/${id}`, authStatusResponseSchema);
      if (current) {
        queryClient.removeQueries({ queryKey: ['auth'] });
        void navigate('/', { replace: true });
      } else {
        await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
        setNotice('Session revoked.');
      }
    });
  }

  async function requestDeletion(): Promise<void> {
    await perform(async () => {
      const result = await apiPost(
        '/auth/account-deletion',
        {},
        deletionRequestResponseSchema,
      );
      setNotice(
        `Deletion request ${result.requestId} was submitted for privacy review.`,
      );
    });
  }

  if (account.isPending)
    return (
      <AuthFrame>
        <h1>Loading security…</h1>
      </AuthFrame>
    );
  if (account.isError)
    return (
      <AuthFrame>
        <h1>Sign in to continue</h1>
        <AuthLink to="/">Sign in</AuthLink>
      </AuthFrame>
    );

  return (
    <AuthFrame footer={<AuthLink to="/me">Back to account</AuthLink>}>
      <h1>Account security</h1>
      <p>Signed in as {account.data.email}</p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}

      <section
        className="security-section"
        aria-labelledby="change-password-heading"
      >
        <h2 id="change-password-heading">Change password</h2>
        <form
          onSubmit={(event) =>
            void passwordForm.handleSubmit(changePassword)(event)
          }
          noValidate
        >
          <Field
            label="Current password"
            required
            error={passwordForm.formState.errors.currentPassword?.message}
          >
            <Input
              type="password"
              autoComplete="current-password"
              {...passwordForm.register('currentPassword', {
                required: 'Enter your current password.',
              })}
            />
          </Field>
          <Field
            label="New password"
            required
            error={passwordForm.formState.errors.newPassword?.message}
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...passwordForm.register('newPassword', {
                required: 'Enter a new password.',
                minLength: {
                  value: 10,
                  message: 'Use at least 10 characters.',
                },
              })}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Change password
          </Button>
        </form>
      </section>

      <section className="security-section" aria-labelledby="reauth-heading">
        <h2 id="reauth-heading">Confirm your identity</h2>
        <p>
          Confirm again before changing your email, regenerating recovery codes,
          or requesting deletion.
        </p>
        <form
          onSubmit={(event) => void stepForm.handleSubmit(stepUp)(event)}
          noValidate
        >
          <Field label="Verification method">
            <Select
              value={stepMethod}
              onChange={(event) => {
                setStepMethod(event.target.value as 'password' | 'totp');
              }}
            >
              <option value="password">Password</option>
              {account.data.mfaEnabled && (
                <option value="totp">Authenticator code</option>
              )}
            </Select>
          </Field>
          <Field
            label={
              stepMethod === 'password' ? 'Password' : 'Authenticator code'
            }
            required
            error={stepForm.formState.errors.secret?.message}
          >
            <Input
              type={stepMethod === 'password' ? 'password' : 'text'}
              autoComplete={
                stepMethod === 'password' ? 'current-password' : 'one-time-code'
              }
              {...stepForm.register('secret', {
                required: 'Enter your verification secret.',
              })}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Confirm identity
          </Button>
        </form>
      </section>

      <section
        className="security-section"
        aria-labelledby="change-email-heading"
      >
        <h2 id="change-email-heading">Change email</h2>
        <form
          onSubmit={(event) => void emailForm.handleSubmit(changeEmail)(event)}
          noValidate
        >
          <Field
            label="New email address"
            required
            error={emailForm.formState.errors.email?.message}
          >
            <Input
              type="email"
              autoComplete="email"
              {...emailForm.register('email', {
                required: 'Enter your new email address.',
              })}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Send confirmation
          </Button>
        </form>
      </section>

      <section className="security-section" aria-labelledby="mfa-heading">
        <h2 id="mfa-heading">Authenticator</h2>
        {account.data.mfaEnabled ? (
          <p>Your authenticator is enabled.</p>
        ) : (
          <>
            <p>
              Protect your account with a time-based code from an authenticator
              app.
            </p>
            {!enrollment && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void startEnrollment()}
              >
                Set up authenticator
              </Button>
            )}
          </>
        )}
        {enrollment && (
          <>
            <img
              className="mfa-qr"
              src={enrollment.qr}
              alt="Authenticator setup QR code"
            />
            <p>
              Scan the QR code or enter this key manually:{' '}
              <code>{enrollment.manualKey}</code>
            </p>
            <form
              onSubmit={(event) =>
                void codeForm.handleSubmit(confirmEnrollment)(event)
              }
              noValidate
            >
              <Field
                label="Six-digit authenticator code"
                required
                error={codeForm.formState.errors.code?.message}
              >
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  {...codeForm.register('code', {
                    required: 'Enter the code from your app.',
                  })}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                Verify and enable
              </Button>
            </form>
          </>
        )}
        {account.data.mfaEnabled && !codes && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => void regenerateCodes()}
          >
            Regenerate recovery codes
          </Button>
        )}
        {codes && (
          <div role="status" className="recovery-codes">
            <p>
              Save these 10 recovery codes now. They will not be shown again.
            </p>
            <ol>
              {codes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              onClick={() => {
                setCodes(null);
              }}
            >
              I saved these codes
            </Button>
          </div>
        )}
      </section>

      <section className="security-section" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Sessions</h2>
        {sessions.isPending && <p role="status">Loading sessions…</p>}
        {sessions.isError && <ErrorBox error="Sessions could not be loaded." />}
        {sessions.data?.sessions.map((session) => (
          <div className="session-row" key={session.id}>
            <div>
              <strong>
                {session.client.toUpperCase()}{' '}
                {session.current ? '(current)' : ''}
              </strong>
              <small>
                Last used {new Date(session.lastSeenAt).toLocaleString()}
              </small>
            </div>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void revoke(session.id, session.current)}
            >
              Revoke
            </Button>
          </div>
        ))}
      </section>

      <section className="security-section" aria-labelledby="deletion-heading">
        <h2 id="deletion-heading">Account deletion</h2>
        <p>
          Request a privacy review of your account and retained records. Your
          account is not deleted immediately.
        </p>
        <Button
          type="button"
          disabled={busy}
          onClick={() => void requestDeletion()}
        >
          Request deletion review
        </Button>
      </section>
      <BrowserPush />
    </AuthFrame>
  );
}

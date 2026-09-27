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
import { useTranslation } from 'react-i18next';
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
  const { t, i18n } = useTranslation('auth');
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
        caught instanceof Error ? caught.message : t('securityRequestFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(values: PasswordFields): Promise<void> {
    await perform(async () => {
      await apiPost('/auth/password/change', values, authStatusResponseSchema);
      passwordForm.reset();
      setNotice(t('passwordChangedSessions'));
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
      setNotice(t('emailChangeNotice'));
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
      setNotice(t('stepUpNotice'));
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
        setNotice(t('sessionRevoked'));
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
      setNotice(t('deletionSubmitted', { id: result.requestId }));
    });
  }

  if (account.isPending)
    return (
      <AuthFrame>
        <h1>{t('securityLoading')}</h1>
      </AuthFrame>
    );
  if (account.isError)
    return (
      <AuthFrame>
        <h1>{t('signInToContinue')}</h1>
        <AuthLink to="/">{t('signIn')}</AuthLink>
      </AuthFrame>
    );

  return (
    <AuthFrame footer={<AuthLink to="/me">{t('backToAccount')}</AuthLink>}>
      <h1>{t('accountSecurity')}</h1>
      <p>{t('signedInAs', { email: account.data.email })}</p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}

      <section
        className="security-section"
        aria-labelledby="change-password-heading"
      >
        <h2 id="change-password-heading">{t('changePassword')}</h2>
        <form
          onSubmit={(event) =>
            void passwordForm.handleSubmit(changePassword)(event)
          }
          noValidate
        >
          <Field
            label={t('currentPassword')}
            required
            error={passwordForm.formState.errors.currentPassword?.message}
          >
            <Input
              type="password"
              autoComplete="current-password"
              {...passwordForm.register('currentPassword', {
                required: t('currentPasswordRequired'),
              })}
            />
          </Field>
          <Field
            label={t('newPassword')}
            required
            error={passwordForm.formState.errors.newPassword?.message}
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...passwordForm.register('newPassword', {
                required: t('newPasswordRequired'),
                minLength: {
                  value: 10,
                  message: t('passwordMinLength'),
                },
              })}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {t('changePassword')}
          </Button>
        </form>
      </section>

      <section className="security-section" aria-labelledby="reauth-heading">
        <h2 id="reauth-heading">{t('confirmIdentity')}</h2>
        <p>{t('confirmIdentityDescription')}</p>
        <form
          onSubmit={(event) => void stepForm.handleSubmit(stepUp)(event)}
          noValidate
        >
          <Field label={t('verificationMethod')}>
            <Select
              value={stepMethod}
              onChange={(event) => {
                setStepMethod(event.target.value as 'password' | 'totp');
              }}
            >
              <option value="password">{t('password')}</option>
              {account.data.mfaEnabled && (
                <option value="totp">{t('authenticatorCode')}</option>
              )}
            </Select>
          </Field>
          <Field
            label={
              stepMethod === 'password' ? t('password') : t('authenticatorCode')
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
                required: t('verificationSecretRequired'),
              })}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {t('confirmIdentityAction')}
          </Button>
        </form>
      </section>

      <section
        className="security-section"
        aria-labelledby="change-email-heading"
      >
        <h2 id="change-email-heading">{t('changeEmail')}</h2>
        <form
          onSubmit={(event) => void emailForm.handleSubmit(changeEmail)(event)}
          noValidate
        >
          <Field
            label={t('newEmailAddress')}
            required
            error={emailForm.formState.errors.email?.message}
          >
            <Input
              type="email"
              autoComplete="email"
              {...emailForm.register('email', {
                required: t('newEmailRequired'),
              })}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {t('sendConfirmation')}
          </Button>
        </form>
      </section>

      <section className="security-section" aria-labelledby="mfa-heading">
        <h2 id="mfa-heading">{t('authenticator')}</h2>
        {account.data.mfaEnabled ? (
          <p>{t('authenticatorEnabled')}</p>
        ) : (
          <>
            <p>{t('authenticatorDescription')}</p>
            {!enrollment && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void startEnrollment()}
              >
                {t('setupAuthenticator')}
              </Button>
            )}
          </>
        )}
        {enrollment && (
          <>
            <img
              className="mfa-qr"
              src={enrollment.qr}
              alt={t('authenticatorQrAlt')}
            />
            <p>
              {t('authenticatorScan')} <code>{enrollment.manualKey}</code>
            </p>
            <form
              onSubmit={(event) =>
                void codeForm.handleSubmit(confirmEnrollment)(event)
              }
              noValidate
            >
              <Field
                label={t('sixDigitCode')}
                required
                error={codeForm.formState.errors.code?.message}
              >
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  {...codeForm.register('code', {
                    required: t('codeFromAppRequired'),
                  })}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {t('verifyAndEnable')}
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
            {t('regenerateCodes')}
          </Button>
        )}
        {codes && (
          <div role="status" className="recovery-codes">
            <p>{t('saveRecoveryCodes')}</p>
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
              {t('codesSaved')}
            </Button>
          </div>
        )}
      </section>

      <section className="security-section" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">{t('sessions')}</h2>
        {sessions.isPending && <p role="status">{t('loadingSessions')}</p>}
        {sessions.isError && <ErrorBox error={t('sessionsFailed')} />}
        {sessions.data?.sessions.map((session) => (
          <div className="session-row" key={session.id}>
            <div>
              <strong>
                {session.client.toUpperCase()}{' '}
                {session.current ? t('currentSession') : ''}
              </strong>
              <small>
                {t('lastUsed', {
                  date: new Date(session.lastSeenAt).toLocaleString(
                    i18n.resolvedLanguage,
                  ),
                })}
              </small>
            </div>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void revoke(session.id, session.current)}
            >
              {t('revoke')}
            </Button>
          </div>
        ))}
      </section>

      <section className="security-section" aria-labelledby="deletion-heading">
        <h2 id="deletion-heading">{t('accountDeletion')}</h2>
        <p>{t('deletionDescription')}</p>
        <Button
          type="button"
          disabled={busy}
          onClick={() => void requestDeletion()}
        >
          {t('requestDeletion')}
        </Button>
      </section>
      <BrowserPush />
    </AuthFrame>
  );
}

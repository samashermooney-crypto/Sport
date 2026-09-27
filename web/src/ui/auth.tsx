import type { PropsWithChildren, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { i18n } from '../lib/i18n';

import { Link, Select } from './primitives';

export { Button, Checkbox, Field, Input, Select } from './primitives';

export function AuthFrame({
  children,
  footer,
}: PropsWithChildren<{ footer?: ReactNode }>): React.JSX.Element {
  const { t } = useTranslation('auth');
  return (
    <main className="login-page">
      <div className="login-brand" aria-label="Athlentry">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <strong>ATHLENTRY</strong>
      </div>
      <section className="login-card">{children}</section>
      {footer && <p className="login-caption">{footer}</p>}
      <div className="login-caption">
        <label htmlFor="auth-language">{t('language')}</label>{' '}
        <Select
          id="auth-language"
          value={i18n.resolvedLanguage ?? 'en'}
          options={[
            { value: 'en', label: t('english') },
            { value: 'es', label: t('spanish') },
          ]}
          onChange={(event) => {
            void i18n.changeLanguage(event.target.value);
          }}
        />
      </div>
    </main>
  );
}

export function AuthLink({
  to,
  children,
}: PropsWithChildren<{ to: string }>): React.JSX.Element {
  return <Link to={to}>{children}</Link>;
}

export function ErrorBox({
  error,
}: {
  error: string;
}): React.JSX.Element | null {
  return error ? (
    <div className="error-box" role="alert">
      {error}
    </div>
  ) : null;
}

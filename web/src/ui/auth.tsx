import type { PropsWithChildren, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { i18n } from '../lib/i18n';

import { Link, Select } from './primitives';

export { Button, Checkbox, Field, Input, Select } from './primitives';

export function AuthFrame({
  children,
  footer,
  onLanguageChange,
  languageDisabled = false,
}: PropsWithChildren<{
  footer?: ReactNode;
  onLanguageChange?: (language: 'en' | 'es') => void;
  languageDisabled?: boolean;
}>): React.JSX.Element {
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
          disabled={languageDisabled}
          options={[
            { value: 'en', label: t('english') },
            { value: 'es', label: t('spanish') },
          ]}
          onChange={(event) => {
            const language = event.target.value === 'es' ? 'es' : 'en';
            if (onLanguageChange) onLanguageChange(language);
            else void i18n.changeLanguage(language);
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

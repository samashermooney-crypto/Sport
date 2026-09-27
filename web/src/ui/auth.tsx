import type { PropsWithChildren, ReactNode } from 'react';
import { Link } from 'react-router';

export function AuthFrame({
  children,
  footer,
}: PropsWithChildren<{ footer?: ReactNode }>): React.JSX.Element {
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
    </main>
  );
}

export function AuthLink({
  to,
  children,
}: PropsWithChildren<{ to: string }>): React.JSX.Element {
  return <Link to={to}>{children}</Link>;
}

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>,
): React.JSX.Element {
  return (
    <button
      {...props}
      className={`button${props.className ? ` ${props.className}` : ''}`}
    />
  );
}

export function Field({
  label,
  children,
  required,
  error,
}: PropsWithChildren<{
  label: string;
  required?: boolean;
  error?: string | undefined;
}>): React.JSX.Element {
  return (
    <label className="field">
      <span>
        {label}
        {required && <b className="required"> *</b>}
      </span>
      {children}
      {error && (
        <small className="field-error" role="alert">
          {error}
        </small>
      )}
    </label>
  );
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

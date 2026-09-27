import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export interface EmailBranding {
  organizationName: string;
  accentColor?: string;
  logoUrl?: string;
}

/** Shared, dependency-light React Email compatible shell used by transactional templates. */
export function EmailLayout(props: {
  branding: EmailBranding;
  locale: 'en' | 'es';
  title: string;
  children: React.ReactNode;
}) {
  const { branding, locale, title, children } = props;
  return (
    <html lang={locale}>
      <body
        style={{
          margin: 0,
          backgroundColor: '#f5f6f7',
          color: '#20252b',
          fontFamily: 'Arial, sans-serif',
        }}
      >
        <main
          style={{
            maxWidth: 600,
            margin: '24px auto',
            background: '#fff',
            padding: 24,
            borderRadius: 8,
          }}
        >
          {branding.logoUrl ? (
            <img
              src={branding.logoUrl}
              alt={branding.organizationName}
              style={{ maxHeight: 48, maxWidth: 200 }}
            />
          ) : (
            <strong style={{ color: branding.accentColor ?? '#2257a5' }}>
              {branding.organizationName}
            </strong>
          )}
          <h1>{title}</h1>
          {children}
          <hr />
          <small>
            {branding.organizationName} ·{' '}
            {locale === 'es'
              ? 'Este mensaje se envió a su dirección de correo electrónico.'
              : 'This message was sent to your email address.'}
          </small>
        </main>
      </body>
    </html>
  );
}

export function renderEmailLayout(
  props: Parameters<typeof EmailLayout>[0],
): string {
  return `<!doctype html>${renderToStaticMarkup(<EmailLayout {...props} />)}`;
}

import type { EmailMessage } from '../sender';

import { renderEmailLayout } from './layout';
import type { EmailBranding } from './layout';

type AuthEmailKind =
  | 'verification'
  | 'magic-link'
  | 'password-reset'
  | 'invitation'
  | 'security-alert';
const copy = {
  en: {
    verification: [
      'Verify your email',
      'Use the secure link below to verify your email address.',
    ],
    'magic-link': [
      'Sign in to Athlentry',
      'Use this one-time link to sign in.',
    ],
    'password-reset': [
      'Reset your password',
      'Use the secure link below to choose a new password.',
    ],
    invitation: [
      'You are invited',
      'An organization invited you to join Athlentry.',
    ],
    'security-alert': [
      'Security notice',
      'A security change was made to your Athlentry account.',
    ],
  },
  es: {
    verification: [
      'Verifique su correo electrónico',
      'Use el enlace seguro para verificar su correo electrónico.',
    ],
    'magic-link': [
      'Inicie sesión en Athlentry',
      'Use este enlace de un solo uso para iniciar sesión.',
    ],
    'password-reset': [
      'Restablezca su contraseña',
      'Use el enlace seguro para elegir una contraseña nueva.',
    ],
    invitation: [
      'Tiene una invitación',
      'Una organización le invitó a unirse a Athlentry.',
    ],
    'security-alert': [
      'Aviso de seguridad',
      'Se realizó un cambio de seguridad en su cuenta de Athlentry.',
    ],
  },
} as const;

export function createAuthEmail(input: {
  kind: AuthEmailKind;
  to: string;
  url?: string;
  locale: 'en' | 'es';
  branding?: EmailBranding;
}): EmailMessage {
  const [subject, introduction] = copy[input.locale][input.kind];
  const branding = input.branding ?? { organizationName: 'Athlentry' };
  const urlText = input.url
    ? `${input.locale === 'es' ? 'Continuar' : 'Continue'}: ${input.url}`
    : '';
  const html = renderEmailLayout({
    branding,
    locale: input.locale,
    title: subject,
    children: (
      <>
        <p>{introduction}</p>
        {input.url ? (
          <p>
            <a href={input.url}>
              {input.locale === 'es' ? 'Continuar' : 'Continue'}
            </a>
          </p>
        ) : null}
      </>
    ),
  });
  return {
    to: input.to,
    subject,
    text: `${introduction}${urlText ? `\n\n${urlText}` : ''}`,
    html,
    kind: 'security',
  };
}

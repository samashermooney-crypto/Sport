import React from 'react';

import type { EmailMessage } from '../sender';

import { renderEmailLayout } from './layout';
import type { EmailBranding } from './layout';

type AuthEmailKind =
  | 'verification'
  | 'magic-link'
  | 'password-reset'
  | 'invitation'
  | 'guardian-invitation'
  | 'athlete-invitation'
  | 'person-claim'
  | 'ownership-transfer'
  | 'email-change-verification'
  | 'password-reset-confirmed'
  | 'password-changed'
  | 'email-change-requested'
  | 'email-changed'
  | 'mfa-enabled'
  | 'recovery-codes-changed'
  | 'security-alert';
export const emailTranslationCatalog = {
  en: {
    verification: [
      'Verify your email',
      'Use the secure link below to verify your email address. This link expires in 24 hours.',
    ],
    'magic-link': [
      'Sign in to Athlentry',
      'Use this one-time link to sign in. This link expires in 15 minutes.',
    ],
    'password-reset': [
      'Reset your password',
      'Use the secure link below to choose a new password. This link expires in 1 hour.',
    ],
    invitation: [
      'Join your Athlentry organization',
      'An organization invited you to join Athlentry. This link expires in 7 days.',
    ],
    'guardian-invitation': [
      'Accept guardian access in Athlentry',
      'An organization invited you to manage a family member in Athlentry. Sign in with this email address and accept within 7 days.',
    ],
    'athlete-invitation': [
      'Join your athlete profile in Athlentry',
      'Your guardian invited you to connect your athlete account. Create or verify an account with this email address, then accept within 7 days.',
    ],
    'person-claim': [
      'Claim your Athlentry profile',
      'An organization invited you to link your adult profile to this account. Sign in with this email address and accept within 7 days.',
    ],
    'ownership-transfer': [
      'Accept Athlentry organization ownership',
      'An organization owner asked to transfer ownership to you. Sign in and use this link within 24 hours.',
    ],
    'email-change-verification': [
      'Verify your new Athlentry email',
      'Confirm your new email address with this link within 1 hour.',
    ],
    'password-reset-confirmed': [
      'Your Athlentry password was reset',
      'Your password was reset. If you did not make this change, contact Athlentry support immediately.',
    ],
    'password-changed': [
      'Your Athlentry password changed',
      'Your password was changed. If you did not make this change, contact Athlentry support immediately.',
    ],
    'email-change-requested': [
      'Athlentry email change requested',
      'A change to your account email was requested. If this was not you, contact Athlentry support immediately.',
    ],
    'email-changed': [
      'Your Athlentry email changed',
      'Your account email changed. If you did not make this change, contact Athlentry support immediately.',
    ],
    'mfa-enabled': [
      'Athlentry MFA enabled',
      'Multi-factor authentication was enabled on your account. If you did not make this change, contact Athlentry support immediately.',
    ],
    'recovery-codes-changed': [
      'Athlentry recovery codes changed',
      'Your MFA recovery codes were regenerated. If you did not make this change, contact Athlentry support immediately.',
    ],
    'security-alert': [
      'Security notice',
      'A security change was made to your Athlentry account.',
    ],
  },
  es: {
    verification: [
      'Verifique su correo electrónico',
      'Use el enlace seguro para verificar su correo electrónico. Este enlace vence en 24 horas.',
    ],
    'magic-link': [
      'Inicie sesión en Athlentry',
      'Use este enlace de un solo uso para iniciar sesión. Este enlace vence en 15 minutos.',
    ],
    'password-reset': [
      'Restablezca su contraseña',
      'Use el enlace seguro para elegir una contraseña nueva. Este enlace vence en 1 hora.',
    ],
    invitation: [
      'Únase a su organización en Athlentry',
      'Una organización le invitó a unirse a Athlentry. Este enlace vence en 7 días.',
    ],
    'guardian-invitation': [
      'Acepte acceso como tutor en Athlentry',
      'Una organización le invitó a gestionar a un familiar en Athlentry. Inicie sesión con este correo y acepte en un plazo de 7 días.',
    ],
    'athlete-invitation': [
      'Conecte su perfil de atleta en Athlentry',
      'Su tutor le invitó a conectar su cuenta de atleta. Cree o verifique una cuenta con este correo y acepte en un plazo de 7 días.',
    ],
    'person-claim': [
      'Vincule su perfil de Athlentry',
      'Una organización le invitó a vincular su perfil adulto a esta cuenta. Inicie sesión con este correo y acepte en un plazo de 7 días.',
    ],
    'ownership-transfer': [
      'Acepte la titularidad de una organización en Athlentry',
      'Una persona propietaria solicitó transferirle la titularidad. Inicie sesión y use este enlace en las próximas 24 horas.',
    ],
    'email-change-verification': [
      'Verifique su nuevo correo electrónico de Athlentry',
      'Confirme su nuevo correo electrónico con este enlace en la próxima hora.',
    ],
    'password-reset-confirmed': [
      'Se restableció su contraseña de Athlentry',
      'Se restableció su contraseña. Si usted no hizo este cambio, comuníquese con soporte de Athlentry de inmediato.',
    ],
    'password-changed': [
      'Cambió su contraseña de Athlentry',
      'Se cambió su contraseña. Si usted no hizo este cambio, comuníquese con soporte de Athlentry de inmediato.',
    ],
    'email-change-requested': [
      'Se solicitó cambiar su correo electrónico de Athlentry',
      'Se solicitó cambiar el correo electrónico de su cuenta. Si usted no lo solicitó, comuníquese con soporte de Athlentry de inmediato.',
    ],
    'email-changed': [
      'Cambió su correo electrónico de Athlentry',
      'Cambió el correo electrónico de su cuenta. Si usted no hizo este cambio, comuníquese con soporte de Athlentry de inmediato.',
    ],
    'mfa-enabled': [
      'Se activó la autenticación multifactor de Athlentry',
      'Se activó la autenticación multifactor en su cuenta. Si usted no hizo este cambio, comuníquese con soporte de Athlentry de inmediato.',
    ],
    'recovery-codes-changed': [
      'Cambiaron sus códigos de recuperación de Athlentry',
      'Se regeneraron sus códigos de recuperación. Si usted no hizo este cambio, comuníquese con soporte de Athlentry de inmediato.',
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
  const [subject, introduction] =
    emailTranslationCatalog[input.locale][input.kind];
  const branding = input.branding ?? { organizationName: 'Athlentry' };
  const urlText = input.url
    ? `${input.locale === 'es' ? 'Continuar' : 'Continue'}: ${input.url}`
    : '';
  const html = renderEmailLayout({
    branding,
    locale: input.locale,
    title: subject,
    children: (
      <React.Fragment>
        <p>{introduction}</p>
        {input.url ? (
          <p>
            <a href={input.url}>
              {input.locale === 'es' ? 'Continuar' : 'Continue'}
            </a>
          </p>
        ) : null}
      </React.Fragment>
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

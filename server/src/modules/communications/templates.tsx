import React from 'react';

import { renderEmailLayout } from '../../integrations/email/templates/layout';

import { phase10NotificationTemplates } from './schema';

export type Phase10NotificationType = keyof typeof phase10NotificationTemplates;

export function renderPhase10Notification(input: {
  type: Phase10NotificationType;
  locale: 'en' | 'es';
  organizationName: string;
  physicalAddress: string;
  authenticatedUrl: string;
}) {
  const template = phase10NotificationTemplates[input.type];
  const copy = template[input.locale];
  const why =
    input.locale === 'es'
      ? 'Recibes este mensaje porque tienes una relación activa con esta organización.'
      : 'You are receiving this message because you have an active relationship with this organization.';
  const address = input.physicalAddress;
  const linkLabel =
    input.locale === 'es'
      ? 'Inicia sesión para revisar los detalles.'
      : 'Sign in to review the details.';
  const html = renderEmailLayout({
    branding: { organizationName: input.organizationName },
    locale: input.locale,
    title: copy.title,
    children: React.createElement(
      'div',
      null,
      React.createElement('p', null, copy.body),
      React.createElement(
        'p',
        null,
        React.createElement('a', { href: input.authenticatedUrl }, linkLabel),
      ),
      React.createElement('p', null, address),
      React.createElement('small', null, why),
    ),
  });
  return {
    subject: copy.title,
    html,
    text: `${copy.body}\n\n${linkLabel} ${input.authenticatedUrl}\n\n${address}\n${why}`,
    sms: copy.sms,
    push: copy.push,
    category: template.category,
    defaultChannels: template.defaultChannels,
    marketingOptInRequired: template.marketingOptInRequired,
  };
}

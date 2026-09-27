import { withOrg } from '../../db/withOrg';
import {
  FakeEmailSender,
  createResendEmailSender,
} from '../../integrations/email/sender';
import type { EmailSender } from '../../integrations/email/sender';
import {
  PreviewPushSender,
  WebPushSender,
} from '../../integrations/push/sender';
import type { PushSender } from '../../integrations/push/sender';
import type { WebPushClient } from '../../integrations/push/sender';
import {
  PreviewSmsSender,
  createTwilioSmsSender,
} from '../../integrations/sms/sender';
import type { SmsSender } from '../../integrations/sms/sender';
import { createNotification } from '../notifications/service';

import type { DeliveryDependencies, NotificationSink } from './delivery';

export function createCommunicationNotificationSink(
  runWithOrg: typeof withOrg = withOrg,
): NotificationSink {
  return async ({ context, accountId, type, payload }) => {
    const isChat = type === 'communications.chat_message';
    const resourceId = isChat ? payload.conversationId : payload.campaignId;
    if (!resourceId) throw new Error('Notification resource is unavailable');
    const notificationType =
      type === 'communications.emergency'
        ? 'safety.emergency'
        : 'organization.announcement';
    const safePayload = {
      resourceType: isChat ? 'conversation' : 'message_campaign',
      resourceId,
      href: isChat
        ? `/me/orgs/${context.orgId}/messages?conversation=${resourceId}`
        : `/me/orgs/${context.orgId}/messages`,
    };
    return runWithOrg(context, (trx) =>
      createNotification(trx, context, {
        accountId,
        type: notificationType,
        payload: safePayload,
      }),
    );
  };
}

export function createCommunicationAdapters(
  input: {
    email?: EmailSender;
    appUrl?: string;
    runWithOrg?: typeof withOrg;
  } = {},
): DeliveryDependencies {
  const appUrl = input.appUrl ?? process.env.APP_URL ?? 'http://127.0.0.1:5173';
  if (process.env.DELIVERY_MODE !== 'live') {
    return {
      email: input.email ?? new FakeEmailSender(),
      sms: new PreviewSmsSender(),
      push: new PreviewPushSender(),
      appUrl,
      notifications: createCommunicationNotificationSink(input.runWithOrg),
    };
  }
  if (process.env.NODE_ENV !== 'production')
    throw new Error(
      'Live email, SMS, and push delivery is restricted to production',
    );
  const email: EmailSender =
    input.email ??
    createResendEmailSender({
      apiKey: required('RESEND_API_KEY'),
      from: required('EMAIL_FROM'),
      campaignFrom: required('CAMPAIGN_EMAIL_FROM'),
    });
  const sms: SmsSender = createTwilioSmsSender({
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    messagingServiceSid: required('TWILIO_MESSAGING_SERVICE_SID'),
    statusCallbackUrl: required('TWILIO_STATUS_CALLBACK_URL'),
  });
  const pushConfig = {
    subject: required('WEB_PUSH_SUBJECT'),
    publicKey: required('WEB_PUSH_PUBLIC_KEY'),
    privateKey: required('WEB_PUSH_PRIVATE_KEY'),
  };
  let sender: Promise<PushSender> | undefined;
  const push: PushSender = {
    async send(subscription, message) {
      const moduleName = 'web-push';
      sender ??= import(moduleName).then((library: unknown) => {
        const client = (library as { default: WebPushClient }).default;
        return new WebPushSender(client, pushConfig);
      });
      return (await sender).send(subscription, message);
    },
  };
  return {
    email,
    sms,
    push,
    appUrl,
    notifications: createCommunicationNotificationSink(input.runWithOrg),
  };
}

function required(key: string): string {
  const value = process.env[key];
  if (!value)
    throw new Error(`${key} is required for live communication delivery`);
  return value;
}

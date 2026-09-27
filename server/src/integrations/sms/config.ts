import { z } from 'zod';

export const smsConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fake') }),
  z.strictObject({ mode: z.literal('preview') }),
  z.strictObject({
    mode: z.literal('twilio'),
    accountSid: z.string().startsWith('AC'),
    authToken: z.string().min(1),
    messagingServiceSid: z.string().startsWith('MG'),
    statusCallbackUrl: z.url().startsWith('https://'),
  }),
]);
export type SmsConfig = z.infer<typeof smsConfigSchema>;

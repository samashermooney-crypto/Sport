import { parseTwilioInbound } from './sender';

export interface SmsSuppressions {
  suppress(phoneE164: string, reason: 'opt_out'): Promise<void>;
  unsuppress(phoneE164: string): Promise<void>;
}
export async function handleTwilioInbound(
  input: Parameters<typeof parseTwilioInbound>[0],
  suppressions: SmsSuppressions,
): Promise<{ command: 'STOP' | 'START' | 'HELP' | null; response: string }> {
  const message = parseTwilioInbound(input);
  if (message.command === 'STOP')
    await suppressions.suppress(message.from, 'opt_out');
  if (message.command === 'START') await suppressions.unsuppress(message.from);
  const response =
    message.command === 'HELP'
      ? 'Athlentry messages. Reply STOP to unsubscribe.'
      : message.command === 'STOP'
        ? 'You will no longer receive SMS messages.'
        : message.command === 'START'
          ? 'You are subscribed to SMS messages.'
          : '';
  return { command: message.command, response };
}

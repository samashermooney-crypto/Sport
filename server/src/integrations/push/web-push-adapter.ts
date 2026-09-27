import { WebPushSender } from './sender';
import type { PushSender } from './sender';

export async function createWebPushSender(config: {
  subject: string;
  publicKey: string;
  privateKey: string;
}): Promise<PushSender> {
  const library = await import('web-push');
  return new WebPushSender(library.default, config);
}

declare module 'web-push' {
  const client: {
    setVapidDetails(
      subject: string,
      publicKey: string,
      privateKey: string,
    ): void;
    sendNotification(
      subscription: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      },
      payload: string,
      options?: {
        TTL?: number;
        urgency?: 'very-low' | 'low' | 'normal' | 'high';
        agent?: import('node:https').Agent;
      },
    ): Promise<unknown>;
  };
  // The web-push package exposes its client as the default CommonJS export.
  // eslint-disable-next-line import/no-default-export
  export default client;
}

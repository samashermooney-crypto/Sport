import type { Response } from 'express';
import pg from 'pg';

export type SseEvent = { id?: string; event: string; data: unknown };

export function writeSseEvent(response: Response, event: SseEvent): void {
  if (!/^[a-z][a-z0-9.:-]*$/.test(event.event))
    throw new RangeError('Invalid SSE event name');
  if (event.id && !/^[A-Za-z0-9_-]{1,128}$/.test(event.id))
    throw new RangeError('Invalid SSE event ID');
  if (event.id) response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.event}\n`);
  response.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export async function listenSse(
  response: Response,
  options: {
    connectionString: string;
    channel: string;
    accept: (payload: string) => SseEvent | null;
    heartbeatMs?: number;
    authorize?: () => Promise<boolean>;
  },
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.channel))
    throw new RangeError('Invalid PostgreSQL notification channel');
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query(`LISTEN ${options.channel}`);
  } catch (error) {
    await client.end();
    throw error;
  }
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
  response.write(': connected\n\n');
  const heartbeat = setInterval(() => {
    if (!options.authorize) {
      if (!closed && !response.destroyed) response.write(': heartbeat\n\n');
      return;
    }
    void options
      .authorize()
      .then((authorized) => {
        if (!authorized) close();
        else if (!closed && !response.destroyed)
          response.write(': heartbeat\n\n');
      })
      .catch(close);
  }, options.heartbeatMs ?? 20_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    client.removeAllListeners('notification');
    client.removeAllListeners('error');
    response.off('close', close);
    if (!response.destroyed) response.end();
    void client.end().catch(() => undefined);
  };
  client.on('notification', (message) => {
    if (message.channel !== options.channel || !message.payload) return;
    try {
      const event = options.accept(message.payload);
      if (event && !closed && !response.destroyed)
        writeSseEvent(response, event);
    } catch {
      close();
    }
  });
  client.on('error', close);
  response.on('close', close);
}

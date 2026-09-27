import { z } from 'zod';

export interface CaptchaProvider {
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

export class AlwaysPassCaptcha implements CaptchaProvider {
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export class CaptchaServiceUnavailableError extends Error {
  constructor() {
    super('Captcha verification is temporarily unavailable');
  }
}

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

export class TurnstileCaptcha implements CaptchaProvider {
  constructor(
    private readonly secret: string,
    private readonly hostname: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async verify(token: string, remoteIp?: string): Promise<boolean> {
    if (!token || token.length > 2048) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    let response: Response;
    try {
      response = await this.fetcher(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new CaptchaServiceUnavailableError();
      const parsed = siteverifyResponseSchema.parse(await response.json());
      return (
        parsed.success &&
        parsed.hostname === this.hostname &&
        parsed.action === 'sign-up'
      );
    } catch {
      throw new CaptchaServiceUnavailableError();
    }
  }
}

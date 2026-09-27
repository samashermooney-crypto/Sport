export interface CaptchaProvider {
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

export class AlwaysPassCaptcha implements CaptchaProvider {
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

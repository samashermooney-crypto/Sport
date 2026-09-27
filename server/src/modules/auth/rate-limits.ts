import { createHash } from 'node:crypto';

import pg from 'pg';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';

import { AuthDomainError } from './domain-error';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class RateLimitExceededError extends AuthDomainError {
  readonly retryAfterSeconds: number;

  constructor(msBeforeNext: number) {
    super(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    this.retryAfterSeconds = Math.max(1, Math.ceil(msBeforeNext / 1_000));
  }
}

export interface AuthRateLimits {
  signIn(ip: string, email: string): Promise<void>;
  magic(ip: string, email: string): Promise<void>;
  reset(ip: string, email: string): Promise<void>;
  signUp(ip: string): Promise<void>;
  mfa(ip: string): Promise<void>;
  close(): Promise<void>;
}

export function createAuthRateLimits(connectionString: string): AuthRateLimits {
  const pool = new pg.Pool({ connectionString });
  const limiter = (keyPrefix: string, points: number, duration: number) =>
    new RateLimiterPostgres({
      storeClient: pool,
      tableName: 'rate_limit_points',
      tableCreated: true,
      clearExpiredByTimeout: false,
      keyPrefix,
      points,
      duration,
    });
  const signIn = limiter('auth-sign-in', 8, 15 * 60);
  const magicEmail = limiter('auth-magic-email', 5, 60 * 60);
  const magicIp = limiter('auth-magic-ip', 30, 60 * 60);
  const resetEmail = limiter('auth-reset-email', 5, 60 * 60);
  const resetIp = limiter('auth-reset-ip', 30, 60 * 60);
  const signUp = limiter('auth-sign-up-ip', 5, 60 * 60);
  const mfa = limiter('auth-mfa-ip', 8, 15 * 60);

  async function consume(
    target: RateLimiterPostgres,
    key: string,
  ): Promise<void> {
    try {
      await target.consume(digest(key));
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        throw new RateLimitExceededError(error.msBeforeNext);
      }
      throw new AuthDomainError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Request protection is temporarily unavailable',
      );
    }
  }

  async function consumeDual(
    emailLimiter: RateLimiterPostgres,
    ipLimiter: RateLimiterPostgres,
    ip: string,
    email: string,
  ): Promise<void> {
    await consume(ipLimiter, ip);
    await consume(emailLimiter, email.trim().toLowerCase());
  }

  return {
    signIn: (ip, email) =>
      consume(signIn, `${ip}\0${email.trim().toLowerCase()}`),
    magic: (ip, email) => consumeDual(magicEmail, magicIp, ip, email),
    reset: (ip, email) => consumeDual(resetEmail, resetIp, ip, email),
    signUp: (ip) => consume(signUp, ip),
    mfa: (ip) => consume(mfa, ip),
    close: () => pool.end(),
  };
}

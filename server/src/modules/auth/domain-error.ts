import type { ErrorCode } from '@shared/schemas/errors';

export class AuthDomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

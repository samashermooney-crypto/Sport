import { z } from 'zod';

export class VersionConflictError<T> extends Error {
  readonly code = 'CONFLICT';
  readonly status = 409;

  constructor(readonly current: T) {
    super('The record changed since it was loaded');
  }
}

export function parseExpectedVersion(input: unknown): number {
  return z.number().int().positive().parse(input);
}

export function requireVersion<T extends { version: number }>(
  current: T,
  expectedVersion: number,
): T {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new RangeError('Expected version must be a positive integer');
  if (current.version !== expectedVersion)
    throw new VersionConflictError(current);
  return current;
}

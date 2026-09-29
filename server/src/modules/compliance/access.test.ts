import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  AccessError,
  isComplianceOfficer,
  isOwner,
  mutationOriginIsValid,
  requireAnyRole,
  sendModuleError,
} from './access';

function request(headers: Record<string, string | undefined>): Request {
  return {
    headers: {},
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function response() {
  const result = {
    status: vi.fn(),
    json: vi.fn(),
  };
  result.status.mockImplementation(() => result);
  return result as unknown as Response & typeof result;
}

describe('compliance access helpers', () => {
  it('requires one of the permitted roles and distinguishes compliance from ownership', () => {
    expect(() => {
      requireAnyRole(['compliance'], ['owner', 'compliance']);
    }).not.toThrow();
    expect(isComplianceOfficer(['compliance'])).toBe(true);
    expect(isComplianceOfficer(['registrar'])).toBe(false);
    expect(isOwner(['owner', 'admin'])).toBe(true);
    expect(isOwner(['compliance'])).toBe(false);
    expect(() => {
      requireAnyRole(['registrar'], ['owner', 'compliance']);
    }).toThrow(
      new AccessError(404, 'NOT_FOUND', 'Organization resource not found'),
    );
  });

  it('checks request markers, browser origins, and originless bearer calls', () => {
    expect(
      mutationOriginIsValid(
        request({
          'x-athlentry-request': '1',
          origin: 'https://athlentry.test',
        }),
        'https://athlentry.test/app',
      ),
    ).toBe(true);
    expect(
      mutationOriginIsValid(
        request({
          'x-athlentry-request': '1',
          authorization: `Bearer ${'a'.repeat(43)}`,
        }),
        'https://athlentry.test',
      ),
    ).toBe(true);
    expect(
      mutationOriginIsValid(
        request({
          'x-athlentry-request': '1',
          origin: 'https://attacker.test',
        }),
        'https://athlentry.test',
      ),
    ).toBe(false);
    expect(
      mutationOriginIsValid(
        request({
          origin: 'https://athlentry.test',
        }),
        'https://athlentry.test',
      ),
    ).toBe(false);
    expect(
      mutationOriginIsValid(
        request({
          'x-athlentry-request': '1',
          authorization: 'Bearer malformed',
        }),
        'https://athlentry.test',
      ),
    ).toBe(false);
  });

  it('maps validation, access, service, and unknown failures to safe responses', () => {
    const invalid = response();
    try {
      z.string().parse(7);
    } catch (error) {
      sendModuleError(invalid, error);
    }
    expect(invalid.status.mock.calls).toContainEqual([400]);
    expect(invalid.json.mock.calls).toContainEqual([
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the submitted details',
        },
      },
    ]);

    const denied = response();
    sendModuleError(
      denied,
      new AccessError(403, 'FORBIDDEN', 'Step up required'),
    );
    expect(denied.status.mock.calls).toContainEqual([403]);

    const domain = response();
    sendModuleError(
      domain,
      Object.assign(new Error('Conflict'), { status: 409, code: 'CONFLICT' }),
    );
    expect(domain.status.mock.calls).toContainEqual([409]);
    expect(domain.json.mock.calls).toContainEqual([
      {
        error: { code: 'CONFLICT', message: 'Conflict' },
      },
    ]);

    const unknown = response();
    sendModuleError(unknown, new Error('private detail'));
    expect(unknown.status.mock.calls).toContainEqual([500]);
    expect(unknown.json.mock.calls).toContainEqual([
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed',
        },
      },
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { sendScheduleError } from './http';

describe('schedule HTTP error responses', () => {
  it('maps database error codes to the safe internal error contract', () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const databaseError = Object.assign(new Error('invalid JSON value'), {
      code: '22P02',
    });

    sendScheduleError(response as never, databaseError);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
      },
    });
  });
});

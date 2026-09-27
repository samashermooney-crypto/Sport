import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessagesConsole } from './MessagesConsole';
import { communicationsRequest } from './api';

vi.mock('./api', () => ({ communicationsRequest: vi.fn() }));

const requestMock = vi.mocked(communicationsRequest);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockImplementation(
    <T,>(path: string, method = 'GET'): Promise<T> => {
      if (path.endsWith('/audience-options'))
        return Promise.resolve({
          people: [
            {
              id: '00000000-0000-4000-8000-000000000002',
              label: 'Riley Athlete',
            },
          ],
          teams: [],
          programs: [],
        } as T);
      if (path.endsWith('/campaigns') && method === 'GET')
        return Promise.resolve({ items: [] } as T);
      if (path.endsWith('/campaigns') && method === 'POST')
        return Promise.resolve({
          id: '00000000-0000-4000-8000-000000000001',
          status: 'draft',
          category: 'announcement',
          channels: ['in_app', 'email'],
          subject: null,
          scheduledFor: null,
          sentAt: null,
          resolvedRecipientCount: null,
          version: 1,
          createdAt: '2026-09-27T12:00:00.000Z',
        } as T);
      if (path.endsWith('/audience-preview') || path.endsWith('/preview'))
        return Promise.resolve({
          recipientCount: 1,
          counts: { in_app: 1, email: 1 },
          recipients: [
            {
              displayName: 'Marta López',
              locale: 'es',
              aboutPersonId: '00000000-0000-4000-8000-000000000002',
              channels: ['in_app', 'email'],
            },
          ],
        } as T);
      return Promise.reject(
        new Error(`Unexpected communications request: ${method} ${path}`),
      );
    },
  );
});

describe('campaign audience preview', () => {
  it('updates the preview when a selector changes and shows recipient details', async () => {
    render(<MessagesConsole orgId="00000000-0000-4000-8000-000000000003" />);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Riley Athlete' }),
    );

    const recipients = await screen.findByRole('list', {
      name: 'Audience recipients',
    });
    expect(recipients.textContent).toContain('Marta López');
    expect(recipients.textContent).toContain('Español · in_app, email');
    const previewRequest = requestMock.mock.calls.find(
      ([path]) =>
        path === '/orgs/00000000-0000-4000-8000-000000000003/audience-preview',
    );
    expect(previewRequest?.[1]).toBe('POST');
    expect(previewRequest?.[2]).toMatchObject({
      category: 'announcement',
      channels: ['in_app', 'email'],
      audience: {
        include: { personIds: ['00000000-0000-4000-8000-000000000002'] },
      },
    });
  });
});

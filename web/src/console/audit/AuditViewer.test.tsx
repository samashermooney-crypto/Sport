import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditViewer } from './AuditViewer';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('audit viewer', () => {
  it('loads real entries, filters, and follows the next cursor', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              {
                id: '1',
                action: 'restricted.read',
                entityType: 'medical_profile',
                entityId: null,
                actorAccountId: null,
                createdAt: '2026-09-01T10:00:00Z',
                changes: { notes: '[redacted]' },
              },
            ],
            nextCursor: 'next',
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ items: [], nextCursor: null }),
      });
    vi.stubGlobal('fetch', fetcher);
    render(<AuditViewer orgId="org-1" />);
    await waitFor(() => {
      expect(screen.getByText('restricted.read')).toBeDefined();
    });
    expect(screen.getByText('System')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(String(fetcher.mock.calls[1]?.[0])).toContain('cursor=next');
    });
    fireEvent.change(screen.getByLabelText('Record type'), {
      target: { value: 'person' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain(
        'entityType=person',
      );
    });
  });

  it('carries impersonation context on Restricted audit reads', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    vi.stubGlobal('fetch', fetcher);
    sessionStorage.setItem('athlentry.impersonation', 'impersonation-id');
    render(<AuditViewer orgId="org-1" />);
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining('/audit/orgs/org-1'),
        expect.objectContaining({
          headers: { 'X-Athlentry-Impersonation': 'impersonation-id' },
        }),
      );
    });
  });
});

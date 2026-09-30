import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiToolsScreen } from './AiToolsScreen';

function jsonResponse(value: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('AI tools feature gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders no AI UI and makes no request when disabled', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const view = render(<AiToolsScreen orgId="org-demo" enabled={false} />);

    expect(view.container.firstChild).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows configured tools and uses the fake provider response', async () => {
    const orgId = '0199a413-a221-7000-8000-000000000011';
    const fetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url === '/api/v1/ai/status') {
          return jsonResponse({
            enabled: true,
            provider: 'fake',
            model: 'local-test',
            orgId,
          });
        }
        if (url === '/api/v1/ai/translate') {
          if (typeof init?.body !== 'string') {
            throw new Error('Expected translation request to send JSON text');
          }
          expect(JSON.parse(init.body)).toEqual({
            text: 'Welcome, families.',
            target: 'es',
          });
          return jsonResponse({
            text: 'Bienvenidas las familias.',
            redactions: 0,
          });
        }
        throw new Error(`Unexpected AI request: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={client}>
        <AiToolsScreen orgId={orgId} enabled />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'AI assistance' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Provider: fake (local-test). Drafts are never saved until you apply them.',
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Text'), {
      target: { value: 'Welcome, families.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }));
    const translation = await screen.findByLabelText('Translation', {
      exact: false,
    });
    expect((translation as HTMLTextAreaElement).value).toBe(
      'Bienvenidas las familias.',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

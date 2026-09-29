import type { WebsiteEmbed, WebsiteEmbedConfig } from '@shared/schemas/website';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { WebsiteEmbedsConsole } from './WebsiteEmbedsConsole';

const orgId = '11111111-1111-4111-8111-111111111111';
const programId = '22222222-2222-4222-8222-222222222222';
const embedId = '33333333-3333-4333-8333-333333333333';
const stamp = '2026-09-28T12:00:00.000Z';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  return typeof body === 'string' ? body : '';
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('saves a typed public registration widget and provides iframe code', async () => {
  const embeds: WebsiteEmbed[] = [];
  let savedConfig: WebsiteEmbedConfig | undefined;
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      let result: unknown;
      let status = 200;
      if (url.endsWith('/workspace')) {
        result = {
          id: orgId,
          name: 'Northstar Youth Sports',
          slug: 'northstar',
          canManage: true,
          canAudit: true,
        };
      } else if (url.endsWith('/embeds') && method === 'GET') {
        result = { items: embeds };
      } else if (url.endsWith('/programs/catalog/northstar')) {
        result = {
          programs: [
            { id: programId, slug: 'fall-soccer', name: 'Fall Soccer' },
          ],
        };
      } else if (url.endsWith('/embeds') && method === 'POST') {
        const body = JSON.parse(requestBody(init?.body)) as {
          config: WebsiteEmbedConfig;
        };
        savedConfig = body.config;
        const embed: WebsiteEmbed = {
          id: embedId,
          publicKey: 'K'.repeat(43),
          config: body.config,
          version: 1,
          updatedAt: stamp,
        };
        embeds.push(embed);
        result = { embed };
        status = 201;
      } else {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      return Promise.resolve(
        new Response(JSON.stringify(result), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WebsiteEmbedsConsole orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: 'Website embeds' }),
  ).toBeTruthy();
  const widgetType = screen.getAllByRole('combobox')[0];
  if (!widgetType) throw new Error('Widget type selector was not rendered');
  fireEvent.change(widgetType, {
    target: { value: 'registration_button' },
  });
  fireEvent.change(screen.getByLabelText(/Button label/), {
    target: { value: 'Register for soccer' },
  });
  await screen.findByRole('option', { name: 'Fall Soccer' });
  const programSelector = screen.getAllByRole('combobox')[1];
  if (!programSelector) throw new Error('Program selector was not rendered');
  fireEvent.change(programSelector, {
    target: { value: 'fall-soccer' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save widget' }));

  await waitFor(() => {
    expect(savedConfig).toEqual({
      kind: 'registration_button',
      label: 'Register for soccer',
      programSlug: 'fall-soccer',
    });
  });
  expect(
    await screen.findByText(
      'Widget saved. Copy the iframe code into your website.',
    ),
  ).toBeTruthy();
  const code = screen.getByLabelText('Iframe code for Register for soccer');
  expect((code as HTMLTextAreaElement).value).toContain(
    '/embed/northstar/' + 'K'.repeat(43),
  );
});

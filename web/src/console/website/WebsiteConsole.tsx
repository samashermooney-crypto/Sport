import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import {
  websitePageListSchema,
  websiteSaveResponseSchema,
} from '@shared/schemas/website';
import type {
  WebsiteBlock,
  WebsitePage,
  WebsiteSeo,
} from '@shared/schemas/website';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGet } from '../../api/client';
import {
  Button,
  Card,
  Field,
  Input,
  Link,
  Textarea,
} from '../../ui/primitives';
import { AppShell } from '../../ui/shell';
import './website.css';

type WebsiteEditorDraft = {
  slug: string;
  title: string;
  blocks: WebsiteBlock[];
  seo: WebsiteSeo;
  status: 'draft' | 'published' | 'archived';
};

const emptyPage = {
  slug: '',
  title: '',
  blocks: [{ type: 'paragraph' as const, text: '' }],
  seo: { title: '', description: '', canonicalPath: '' },
  status: 'draft' as const,
};

async function savePage(
  orgId: string,
  page: WebsiteEditorDraft & { expectedVersion?: number },
  pageId?: string,
): Promise<WebsitePage> {
  const response = await fetch(
    `/api/v1/website/orgs/${orgId}/pages${pageId ? `/${pageId}` : ''}`,
    {
      method: pageId ? 'PUT' : 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify(page),
    },
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value as { error?: { message?: string } } | null;
    throw new Error(error?.error?.message ?? 'The page could not be saved.');
  }
  return websiteSaveResponseSchema.parse(value).page;
}

export function WebsiteConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WebsiteEditorDraft>(emptyPage);
  const [error, setError] = useState<string | null>(null);
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
  });
  const pages = useQuery({
    queryKey: ['orgs', orgId, 'website-pages'],
    queryFn: () =>
      apiGet(`/website/orgs/${orgId}/pages`, websitePageListSchema),
  });
  const selected = useMemo(
    () => pages.data?.items.find((item) => item.id === selectedId) ?? null,
    [pages.data?.items, selectedId],
  );
  const mutation = useMutation({
    mutationFn: (status: 'draft' | 'published') =>
      savePage(
        orgId,
        {
          ...draft,
          status,
          ...(selected ? { expectedVersion: selected.version } : {}),
        },
        selected?.id,
      ),
    onSuccess: async (page) => {
      setSelectedId(page.id);
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'website-pages'],
      });
    },
    onError: (cause: Error) => {
      setError(cause.message);
    },
  });

  function selectPage(page: WebsitePage | null): void {
    setSelectedId(page?.id ?? null);
    setDraft(
      page
        ? {
            slug: page.slug,
            title: page.title,
            blocks: page.blocks.length
              ? page.blocks
              : [{ type: 'paragraph' as const, text: '' }],
            seo: page.seo,
            status: page.status,
          }
        : emptyPage,
    );
    setError(null);
  }

  if (workspace.isPending || pages.isPending)
    return <p role="status">Loading website editor…</p>;
  if (workspace.isError || pages.isError)
    return <main role="alert">The organization website is unavailable.</main>;

  const navTo = `/console/orgs/${orgId}/website`;
  return (
    <AppShell
      orgName={workspace.data.name}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            { label: 'Website', to: navTo, current: true },
            { label: 'Reports', to: `/console/orgs/${orgId}/reports` },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Website', to: navTo, current: true },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="page-content">
        <header className="page-heading">
          <div>
            <p className="eyebrow">Public organization site</p>
            <h1>Website pages</h1>
            <p>Write and publish pages that are visible to families.</p>
          </div>
          <Button
            type="button"
            secondary
            onClick={() => {
              selectPage(null);
            }}
          >
            New page
          </Button>
          <Link to={`${navTo}/settings`}>Website settings</Link>
          <Link to={`${navTo}/news`}>{t('websiteNews.manageNews')}</Link>
          <Link to={`${navTo}/contacts`}>Contact inbox</Link>
        </header>
        <div className="website-editor-layout">
          <Card>
            <h2>Pages</h2>
            {pages.data.items.length === 0 ? (
              <p>No pages yet. Create your first page to get started.</p>
            ) : (
              <ul className="website-page-list">
                {pages.data.items.map((page) => (
                  <li key={page.id}>
                    <button
                      className="website-page-choice"
                      type="button"
                      aria-current={page.id === selectedId ? 'page' : undefined}
                      onClick={() => {
                        selectPage(page);
                      }}
                    >
                      <span>{page.title}</span>
                      <small>{page.status}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <form
              className="website-page-form"
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate('draft');
              }}
            >
              <h2>{selected ? 'Edit page' : 'New page'}</h2>
              <Field label="Page title" required>
                <Input
                  required
                  maxLength={180}
                  value={draft.title}
                  onChange={(event) => {
                    setDraft({ ...draft, title: event.currentTarget.value });
                  }}
                />
              </Field>
              <Field
                label="Page address"
                hint="Use lowercase letters and hyphens."
              >
                <Input
                  required
                  maxLength={200}
                  pattern="[a-z0-9][a-z0-9-/]*"
                  value={draft.slug}
                  onChange={(event) => {
                    setDraft({ ...draft, slug: event.currentTarget.value });
                  }}
                />
              </Field>
              <Field label="Page text">
                <Textarea
                  rows={8}
                  maxLength={4000}
                  value={
                    draft.blocks[0]?.type === 'paragraph'
                      ? draft.blocks[0].text
                      : ''
                  }
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      blocks: [
                        { type: 'paragraph', text: event.currentTarget.value },
                      ],
                    });
                  }}
                />
              </Field>
              <Field label="Search title" hint="Up to 70 characters">
                <Input
                  maxLength={70}
                  value={draft.seo.title}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      seo: { ...draft.seo, title: event.currentTarget.value },
                    });
                  }}
                />
              </Field>
              <Field label="Search description" hint="Up to 160 characters">
                <Textarea
                  rows={3}
                  maxLength={160}
                  value={draft.seo.description}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      seo: {
                        ...draft.seo,
                        description: event.currentTarget.value,
                      },
                    });
                  }}
                />
              </Field>
              {error && <p role="alert">{error}</p>}
              <div className="website-page-actions">
                <Button type="submit" disabled={mutation.isPending} secondary>
                  {mutation.isPending ? 'Saving…' : 'Save draft'}
                </Button>
                <Button
                  type="button"
                  disabled={mutation.isPending || !draft.title || !draft.slug}
                  onClick={() => {
                    mutation.mutate('published');
                  }}
                >
                  {mutation.isPending ? 'Publishing…' : 'Publish page'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </main>
    </AppShell>
  );
}

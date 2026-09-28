import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import {
  websiteNewsBodySchema,
  websiteNewsListSchema,
  websiteNewsSaveResponseSchema,
} from '@shared/schemas/website';
import type { WebsiteNewsPost } from '@shared/schemas/website';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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

type NewsDraft = {
  slug: string;
  title: string;
  excerpt: string;
  bodyText: string;
};

const emptyDraft: NewsDraft = {
  slug: '',
  title: '',
  excerpt: '',
  bodyText: '',
};

async function saveNewsPost(
  orgId: string,
  draft: NewsDraft & {
    status: 'draft' | 'published';
    expectedVersion?: number;
  },
  postId?: string,
): Promise<WebsiteNewsPost> {
  const response = await fetch(
    `/api/v1/website/orgs/${orgId}/news${postId ? `/${postId}` : ''}`,
    {
      method: postId ? 'PUT' : 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify({ ...draft, excerpt: draft.excerpt || null }),
    },
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value as { error?: { message?: string } } | null;
    throw new Error(
      error?.error?.message ?? 'The news post could not be saved.',
    );
  }
  return websiteNewsSaveResponseSchema.parse(value).post;
}

export function WebsiteNewsConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewsDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
  });
  const news = useQuery({
    queryKey: ['orgs', orgId, 'website-news'],
    queryFn: () => apiGet(`/website/orgs/${orgId}/news`, websiteNewsListSchema),
  });
  const selected =
    news.data?.items.find((post) => post.id === selectedId) ?? null;
  const mutation = useMutation({
    mutationFn: (status: 'draft' | 'published') =>
      saveNewsPost(
        orgId,
        {
          ...draft,
          status,
          ...(selected ? { expectedVersion: selected.version } : {}),
        },
        selected?.id,
      ),
    onSuccess: async (post) => {
      setSelectedId(post.id);
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'website-news'],
      });
    },
    onError: (cause: Error) => {
      setError(cause.message);
    },
  });

  function selectPost(post: WebsiteNewsPost | null): void {
    setSelectedId(post?.id ?? null);
    setDraft(
      post
        ? {
            slug: post.slug,
            title: post.title,
            excerpt: post.excerpt ?? '',
            bodyText: post.bodyText,
          }
        : emptyDraft,
    );
    setError(null);
  }

  if (workspace.isPending || news.isPending)
    return <p role="status">{t('websiteNews.loading')}</p>;
  if (workspace.isError || news.isError)
    return <main role="alert">{t('websiteNews.unavailable')}</main>;

  const websitePath = `/console/orgs/${orgId}/website`;
  const newsPath = `${websitePath}/news`;
  const publicNewsPath = `/site/${workspace.data.slug}/news`;
  return (
    <AppShell
      orgName={workspace.data.name}
      navigation={[
        {
          label: t('websiteNews.manage'),
          items: [
            { label: t('websiteNews.home'), to: `/console/orgs/${orgId}` },
            { label: t('websiteNews.websitePages'), to: websitePath },
            { label: t('websiteNews.news'), to: newsPath, current: true },
            {
              label: t('websiteNews.reports'),
              to: `/console/orgs/${orgId}/reports`,
            },
            { label: t('websiteNews.account'), to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: t('websiteNews.home'), to: `/console/orgs/${orgId}` },
        {
          label: t('websiteNews.news'),
          to: newsPath,
          current: true,
        },
        { label: t('websiteNews.account'), to: '/me' },
      ]}
    >
      <main className="page-content">
        <header className="page-heading">
          <div>
            <p className="eyebrow">{t('websiteNews.publicOrganizationSite')}</p>
            <h1>{t('websiteNews.title')}</h1>
            <p>{t('websiteNews.description')}</p>
          </div>
          <Button
            type="button"
            secondary
            onClick={() => {
              selectPost(null);
            }}
          >
            {t('websiteNews.newPost')}
          </Button>
          <Link to={publicNewsPath} target="_blank" rel="noreferrer">
            {t('websiteNews.viewPublicNews')}
          </Link>
        </header>
        <div className="website-editor-layout">
          <Card>
            <h2>{t('websiteNews.posts')}</h2>
            {news.data.items.length === 0 ? (
              <p>{t('websiteNews.empty')}</p>
            ) : (
              <ul className="website-page-list">
                {news.data.items.map((post) => (
                  <li key={post.id}>
                    <button
                      className="website-page-choice"
                      type="button"
                      aria-pressed={post.id === selectedId}
                      onClick={() => {
                        selectPost(post);
                      }}
                    >
                      <span>{post.title}</span>
                      <small>{post.status}</small>
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
              <h2>
                {selected
                  ? t('websiteNews.editPost')
                  : t('websiteNews.newPostHeading')}
              </h2>
              <Field label={t('websiteNews.titleField')} required>
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
                label={t('websiteNews.address')}
                hint={t('websiteNews.addressHint')}
                required
              >
                <Input
                  required
                  maxLength={200}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  value={draft.slug}
                  onChange={(event) => {
                    setDraft({ ...draft, slug: event.currentTarget.value });
                  }}
                />
              </Field>
              <Field
                label={t('websiteNews.summary')}
                hint={t('websiteNews.summaryHint')}
              >
                <Textarea
                  rows={3}
                  maxLength={320}
                  value={draft.excerpt}
                  onChange={(event) => {
                    setDraft({ ...draft, excerpt: event.currentTarget.value });
                  }}
                />
              </Field>
              <Field
                label={t('websiteNews.postText')}
                hint={t('websiteNews.bodyHint')}
              >
                <Textarea
                  required
                  rows={10}
                  maxLength={12000}
                  value={draft.bodyText}
                  onChange={(event) => {
                    setDraft({ ...draft, bodyText: event.currentTarget.value });
                  }}
                />
              </Field>
              {error ? <p role="alert">{error}</p> : null}
              <div className="website-page-actions">
                <Button type="submit" secondary disabled={mutation.isPending}>
                  {mutation.isPending && mutation.variables === 'draft'
                    ? t('websiteNews.saving')
                    : t('websiteNews.saveDraft')}
                </Button>
                <Button
                  type="button"
                  disabled={mutation.isPending || !draft.title || !draft.slug}
                  onClick={() => {
                    const parsed = websiteNewsBodySchema.safeParse({
                      ...draft,
                      excerpt: draft.excerpt || null,
                      status: 'published',
                    });
                    if (!parsed.success) {
                      setError(
                        parsed.error.issues[0]?.message ??
                          t('websiteNews.checkDetails'),
                      );
                      return;
                    }
                    mutation.mutate('published');
                  }}
                >
                  {mutation.isPending && mutation.variables === 'published'
                    ? t('websiteNews.publishing')
                    : t('websiteNews.publishPost')}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </main>
    </AppShell>
  );
}

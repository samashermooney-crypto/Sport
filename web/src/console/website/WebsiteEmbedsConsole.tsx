import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import {
  websiteEmbedBodySchema,
  websiteEmbedConfigSchema,
  websiteEmbedListSchema,
  websiteEmbedResponseSchema,
} from '@shared/schemas/website';
import type { WebsiteEmbed, WebsiteEmbedConfig } from '@shared/schemas/website';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost, apiPut } from '../../api/client';
import { Button, Card, Field, Input, Link, Select } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';
import './website.css';

const publicProgramsSchema = z.object({
  programs: z.array(
    z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
  ),
});

type EmbedDraft = {
  kind: WebsiteEmbedConfig['kind'];
  title: string;
  limit: string;
  programId: string;
  programSlug: string;
};

const blankDraft: EmbedDraft = {
  kind: 'program_list',
  title: 'Programs',
  limit: '10',
  programId: '',
  programSlug: '',
};

function iframeSnippet(src: string, title: string): string {
  const escapeAttribute = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  return `<iframe src="${escapeAttribute(src)}" title="${escapeAttribute(title)}" width="100%" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

function draftFromConfig(config: WebsiteEmbedConfig): EmbedDraft {
  switch (config.kind) {
    case 'program_list':
      return {
        kind: config.kind,
        title: config.title,
        limit: String(config.limit),
        programId: '',
        programSlug: '',
      };
    case 'schedule':
      return {
        kind: config.kind,
        title: config.title,
        limit: String(config.limit),
        programId: config.programId ?? '',
        programSlug: '',
      };
    case 'standings':
      return {
        kind: config.kind,
        title: config.title,
        limit: '10',
        programId: config.programId,
        programSlug: '',
      };
    case 'registration_button':
      return {
        kind: config.kind,
        title: config.label,
        limit: '10',
        programId: '',
        programSlug: config.programSlug,
      };
  }
}

export function WebsiteEmbedsConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<EmbedDraft>(blankDraft);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
  });
  const embeds = useQuery({
    queryKey: ['orgs', orgId, 'website-embeds'],
    queryFn: () =>
      apiGet(`/website/orgs/${orgId}/embeds`, websiteEmbedListSchema),
  });
  const programs = useQuery({
    queryKey: ['website-public-programs', workspace.data?.slug],
    queryFn: () =>
      apiGet(
        `/programs/catalog/${String(workspace.data?.slug)}`,
        publicProgramsSchema,
      ),
    enabled: Boolean(workspace.data?.slug),
  });
  const saveEmbed = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string | null;
      body: z.infer<typeof websiteEmbedBodySchema>;
    }) =>
      id
        ? apiPut(
            `/website/orgs/${orgId}/embeds/${id}`,
            body,
            websiteEmbedResponseSchema,
          )
        : apiPost(
            `/website/orgs/${orgId}/embeds`,
            body,
            websiteEmbedResponseSchema,
          ),
    onSuccess: async ({ embed }) => {
      setSelectedId(embed.id);
      setDraft(draftFromConfig(embed.config));
      setError(null);
      setNotice('Widget saved. Copy the iframe code into your website.');
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'website-embeds'],
      });
    },
    onError: (cause: Error) => {
      setError(cause.message);
    },
  });

  if (workspace.isPending || embeds.isPending)
    return <p role="status">Loading website widgets…</p>;
  if (workspace.isError || embeds.isError)
    return <main role="alert">Website widgets could not be loaded.</main>;

  const workspaceData = workspace.data;
  const websitePath = `/console/orgs/${orgId}/website`;
  const programsList = programs.data?.programs ?? [];
  const embedItems = embeds.data.items;
  const selected = embedItems.find((embed) => embed.id === selectedId);
  const navItems = [
    { label: 'Home', to: `/console/orgs/${orgId}` },
    { label: 'Website pages', to: websitePath },
    { label: 'Website settings', to: `${websitePath}/settings` },
    { label: 'Domains', to: `${websitePath}/domains` },
    { label: 'Embeds', to: `${websitePath}/embeds`, current: true },
    { label: 'Reports', to: `/console/orgs/${orgId}/reports` },
    { label: 'Account', to: '/me' },
  ];

  function chooseEmbed(id: string): void {
    const embed = embedItems.find((item) => item.id === id);
    if (!embed) return;
    setSelectedId(embed.id);
    setDraft(draftFromConfig(embed.config));
    setError(null);
    setNotice(null);
  }

  function createNew(): void {
    setSelectedId(null);
    setDraft(blankDraft);
    setError(null);
    setNotice(null);
  }

  function configFromDraft(): WebsiteEmbedConfig {
    switch (draft.kind) {
      case 'program_list':
        return websiteEmbedConfigSchema.parse({
          kind: draft.kind,
          title: draft.title,
          limit: Number(draft.limit),
        });
      case 'schedule':
        return websiteEmbedConfigSchema.parse({
          kind: draft.kind,
          title: draft.title,
          limit: Number(draft.limit),
          programId: draft.programId || null,
        });
      case 'standings':
        return websiteEmbedConfigSchema.parse({
          kind: draft.kind,
          title: draft.title,
          programId: draft.programId,
        });
      case 'registration_button':
        return websiteEmbedConfigSchema.parse({
          kind: draft.kind,
          label: draft.title,
          programSlug: draft.programSlug,
        });
    }
  }

  function save(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const body = websiteEmbedBodySchema.parse({
      config: configFromDraft(),
      ...(selected ? { expectedVersion: selected.version } : {}),
    });
    saveEmbed.mutate({ id: selectedId, body });
  }

  function embedSnippet(embed: WebsiteEmbed): string {
    const title =
      'title' in embed.config ? embed.config.title : embed.config.label;
    const src = new URL(
      `/embed/${encodeURIComponent(workspaceData.slug)}/${encodeURIComponent(embed.publicKey)}`,
      window.location.origin,
    ).toString();
    return iframeSnippet(src, title);
  }

  return (
    <AppShell
      orgName={workspaceData.name}
      navigation={[{ label: 'Manage', items: navItems }]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Website', to: websitePath, current: true },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="page-content">
        <header className="page-heading">
          <div>
            <p className="eyebrow">Public organization site</p>
            <h1>Website embeds</h1>
            <p>
              Add a public programs list, schedule, standings table, or
              registration button to an external website.
            </p>
          </div>
          <Link to={websitePath}>Edit website pages</Link>
        </header>
        <div className="website-embeds-layout">
          <Card>
            <h2>Saved widgets</h2>
            <ul className="website-page-list">
              {embedItems.map((embed) => (
                <li key={embed.id}>
                  <button
                    type="button"
                    className="website-page-choice"
                    aria-pressed={selectedId === embed.id}
                    onClick={() => {
                      chooseEmbed(embed.id);
                    }}
                  >
                    <span>
                      {'title' in embed.config
                        ? embed.config.title
                        : embed.config.label}
                    </span>
                    <span>{embed.config.kind.replaceAll('_', ' ')}</span>
                  </button>
                  <label className="website-embed-code-label">
                    Iframe code
                    <textarea
                      readOnly
                      rows={3}
                      aria-label={`Iframe code for ${'title' in embed.config ? embed.config.title : embed.config.label}`}
                      value={embedSnippet(embed)}
                      onFocus={(event) => {
                        event.currentTarget.select();
                      }}
                    />
                  </label>
                </li>
              ))}
            </ul>
            <Button type="button" secondary onClick={createNew}>
              Create widget
            </Button>
          </Card>
          <Card>
            <form className="website-embed-form" onSubmit={save}>
              <h2>{selected ? 'Edit widget' : 'Create widget'}</h2>
              <Field label="Widget type">
                <Select
                  value={draft.kind}
                  onChange={(event) => {
                    const kind = event.currentTarget
                      .value as EmbedDraft['kind'];
                    setSelectedId(null);
                    setDraft({ ...blankDraft, kind });
                  }}
                  options={[
                    { value: 'program_list', label: 'Program list' },
                    { value: 'schedule', label: 'Schedule' },
                    { value: 'standings', label: 'Standings' },
                    {
                      value: 'registration_button',
                      label: 'Registration button',
                    },
                  ]}
                />
              </Field>
              <Field
                label={
                  draft.kind === 'registration_button'
                    ? 'Button label'
                    : 'Title'
                }
                required
              >
                <Input
                  required
                  maxLength={80}
                  value={draft.title}
                  onChange={(event) => {
                    setDraft({ ...draft, title: event.currentTarget.value });
                  }}
                />
              </Field>
              {(draft.kind === 'program_list' || draft.kind === 'schedule') && (
                <Field label="Maximum items">
                  <Input
                    required
                    type="number"
                    min={1}
                    max={draft.kind === 'program_list' ? 20 : 50}
                    value={draft.limit}
                    onChange={(event) => {
                      setDraft({ ...draft, limit: event.currentTarget.value });
                    }}
                  />
                </Field>
              )}
              {draft.kind === 'schedule' && (
                <Field label="Program filter">
                  <Select
                    value={draft.programId}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        programId: event.currentTarget.value,
                      });
                    }}
                    options={[
                      { value: '', label: 'All public programs' },
                      ...programsList.map((program) => ({
                        value: program.id,
                        label: program.name,
                      })),
                    ]}
                  />
                </Field>
              )}
              {(draft.kind === 'standings' ||
                draft.kind === 'registration_button') && (
                <Field
                  label={
                    draft.kind === 'standings'
                      ? 'Public program standings'
                      : 'Registration program'
                  }
                  required
                >
                  <Select
                    required
                    value={
                      draft.kind === 'standings'
                        ? draft.programId
                        : draft.programSlug
                    }
                    onChange={(event) => {
                      setDraft(
                        draft.kind === 'standings'
                          ? { ...draft, programId: event.currentTarget.value }
                          : {
                              ...draft,
                              programSlug: event.currentTarget.value,
                            },
                      );
                    }}
                    options={[
                      { value: '', label: 'Select a public program' },
                      ...programsList.map((program) => ({
                        value:
                          draft.kind === 'standings'
                            ? program.id
                            : program.slug,
                        label: program.name,
                      })),
                    ]}
                  />
                </Field>
              )}
              {programs.isError && (
                <p role="alert">Public programs could not be loaded.</p>
              )}
              {programs.isSuccess && programsList.length === 0 && (
                <p>No public programs are available to add to a widget.</p>
              )}
              {error && <p role="alert">{error}</p>}
              {notice && <p role="status">{notice}</p>}
              <Button
                type="submit"
                disabled={
                  saveEmbed.isPending ||
                  programs.isPending ||
                  (programs.isSuccess &&
                    programsList.length === 0 &&
                    draft.kind !== 'program_list' &&
                    draft.kind !== 'schedule')
                }
              >
                {saveEmbed.isPending ? 'Saving…' : 'Save widget'}
              </Button>
            </form>
          </Card>
        </div>
      </main>
    </AppShell>
  );
}

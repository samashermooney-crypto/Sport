import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import {
  websiteMenuListSchema,
  websiteMenuResponseSchema,
  websiteSettingsResponseSchema,
} from '@shared/schemas/website';
import type {
  WebsiteMenu,
  WebsiteMenuItem,
  WebsiteSettings,
} from '@shared/schemas/website';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { apiGet, apiPut } from '../../api/client';
import { Button, Card, Field, Input, Link, Select } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';
import './website.css';

type SettingsDraft = {
  published: boolean;
  robotsPolicy: 'index' | 'noindex';
  primary: string;
  secondary: string;
  seoTitle: string;
  seoDescription: string;
  canonicalPath: string;
  openGraphImageUrl: string;
  contactInboxEmail: string;
};

type MenuDraft = Record<'header' | 'footer', WebsiteMenu>;

function draftFromSettings(settings: WebsiteSettings): SettingsDraft {
  return {
    published: settings.published,
    robotsPolicy: settings.robotsPolicy,
    primary: settings.theme.primary,
    secondary: settings.theme.secondary,
    seoTitle: settings.seo.title,
    seoDescription: settings.seo.description,
    canonicalPath: settings.seo.canonicalPath,
    openGraphImageUrl: settings.seo.openGraphImageUrl ?? '',
    contactInboxEmail: settings.contactInboxEmail ?? '',
  };
}

function defaultMenus(): MenuDraft {
  return {
    header: { location: 'header', items: [], version: 0 },
    footer: { location: 'footer', items: [], version: 0 },
  };
}

export function WebsiteSettingsConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [menusDraft, setMenusDraft] = useState<MenuDraft>(defaultMenus);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
  });
  const settings = useQuery({
    queryKey: ['orgs', orgId, 'website-settings'],
    queryFn: () =>
      apiGet(`/website/orgs/${orgId}/settings`, websiteSettingsResponseSchema),
  });
  const menus = useQuery({
    queryKey: ['orgs', orgId, 'website-menus'],
    queryFn: () =>
      apiGet(`/website/orgs/${orgId}/menus`, websiteMenuListSchema),
  });

  useEffect(() => {
    if (settings.data) setDraft(draftFromSettings(settings.data.settings));
  }, [settings.data]);

  useEffect(() => {
    if (!menus.data) return;
    const current = defaultMenus();
    for (const menu of menus.data.items) current[menu.location] = menu;
    setMenusDraft(current);
  }, [menus.data]);

  const saveSettings = useMutation({
    mutationFn: (value: SettingsDraft) => {
      const current = settings.data?.settings;
      if (!current) throw new Error('Website settings are still loading.');
      return apiPut(
        `/website/orgs/${orgId}/settings`,
        {
          expectedVersion: current.version,
          published: value.published,
          robotsPolicy: value.robotsPolicy,
          theme: { primary: value.primary, secondary: value.secondary },
          seo: {
            title: value.seoTitle,
            description: value.seoDescription,
            canonicalPath: value.canonicalPath,
            ...(value.openGraphImageUrl
              ? { openGraphImageUrl: value.openGraphImageUrl }
              : {}),
          },
          contactInboxEmail: value.contactInboxEmail || null,
        },
        websiteSettingsResponseSchema,
      );
    },
    onSuccess: async ({ settings: saved }) => {
      setDraft(draftFromSettings(saved));
      setSettingsError(null);
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'website-settings'],
      });
    },
    onError: (error: Error) => {
      setSettingsError(error.message);
    },
  });

  const saveMenu = useMutation({
    mutationFn: (menu: WebsiteMenu) =>
      apiPut(
        `/website/orgs/${orgId}/menus`,
        {
          location: menu.location,
          items: menu.items,
          expectedVersion: menu.version,
        },
        websiteMenuResponseSchema,
      ),
    onSuccess: async () => {
      setMenuError(null);
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'website-menus'],
      });
    },
    onError: (error: Error) => {
      setMenuError(error.message);
    },
  });

  if (workspace.isPending || settings.isPending || menus.isPending || !draft)
    return <p role="status">Loading website settings…</p>;
  if (workspace.isError || settings.isError || menus.isError)
    return <main role="alert">Website settings could not be loaded.</main>;

  const workspaceData = workspace.data;
  const websitePath = `/console/orgs/${orgId}/website`;
  function updateMenuItem(
    location: 'header' | 'footer',
    index: number,
    item: WebsiteMenuItem,
  ): void {
    setMenusDraft((current) => ({
      ...current,
      [location]: {
        ...current[location],
        items: current[location].items.map((existing, itemIndex) =>
          itemIndex === index ? item : existing,
        ),
      },
    }));
  }

  function renderMenuEditor(location: 'header' | 'footer'): React.JSX.Element {
    const menu = menusDraft[location];
    const label = location === 'header' ? 'Header menu' : 'Footer menu';
    return (
      <Card>
        <form
          className="website-menu-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveMenu.mutate(menu);
          }}
        >
          <div>
            <h2>{label}</h2>
            <p>Links are shown on every published page.</p>
          </div>
          <ol className="website-menu-items">
            {menu.items.map((item, index) => (
              <li key={`${location}-${String(index)}`}>
                <Field label={`Link ${String(index + 1)} label`} required>
                  <Input
                    required
                    maxLength={80}
                    value={item.label}
                    onChange={(event) => {
                      updateMenuItem(location, index, {
                        ...item,
                        label: event.currentTarget.value,
                      });
                    }}
                  />
                </Field>
                <Field
                  label={`Link ${String(index + 1)} address`}
                  hint="Use a site path or an HTTPS URL."
                  required
                >
                  <Input
                    required
                    maxLength={2048}
                    value={item.href}
                    onChange={(event) => {
                      updateMenuItem(location, index, {
                        ...item,
                        href: event.currentTarget.value,
                      });
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    setMenusDraft((current) => ({
                      ...current,
                      [location]: {
                        ...current[location],
                        items: current[location].items.filter(
                          (_value, itemIndex) => itemIndex !== index,
                        ),
                      },
                    }));
                  }}
                >
                  Remove link {String(index + 1)}
                </Button>
              </li>
            ))}
          </ol>
          <div className="website-page-actions">
            <Button
              type="button"
              secondary
              disabled={menu.items.length >= 20}
              onClick={() => {
                setMenusDraft((current) => ({
                  ...current,
                  [location]: {
                    ...current[location],
                    items: [
                      ...current[location].items,
                      { label: '', href: `/site/${workspaceData.slug}` },
                    ],
                  },
                }));
              }}
            >
              Add link
            </Button>
            <Button type="submit" disabled={saveMenu.isPending}>
              {saveMenu.isPending ? 'Saving…' : `Save ${location} menu`}
            </Button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <AppShell
      orgName={workspaceData.name}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            { label: 'Website pages', to: websitePath },
            {
              label: 'Website settings',
              to: `${websitePath}/settings`,
              current: true,
            },
            { label: 'Reports', to: `/console/orgs/${orgId}/reports` },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
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
            <h1>Website settings</h1>
            <p>Control publishing, search details, colors, and navigation.</p>
          </div>
          <Link to={websitePath}>Edit website pages</Link>
        </header>
        <div className="website-settings-layout">
          <Card>
            <form
              className="website-settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveSettings.mutate(draft);
              }}
            >
              <h2>Publication and appearance</h2>
              <label className="website-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.published}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      published: event.currentTarget.checked,
                    });
                  }}
                />
                <span>Publish the organization website</span>
              </label>
              <Field label="Search indexing">
                <Select
                  value={draft.robotsPolicy}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      robotsPolicy: event.currentTarget.value as
                        'index' | 'noindex',
                    });
                  }}
                  options={[
                    { value: 'index', label: 'Allow search engines' },
                    { value: 'noindex', label: 'Hide from search engines' },
                  ]}
                />
              </Field>
              <Field
                label="Primary color"
                hint="Six digit hex color, such as #3a67b2"
              >
                <Input
                  required
                  pattern="#[0-9a-fA-F]{6}"
                  maxLength={7}
                  value={draft.primary}
                  onChange={(event) => {
                    setDraft({ ...draft, primary: event.currentTarget.value });
                  }}
                />
              </Field>
              <Field
                label="Secondary color"
                hint="Six digit hex color, such as #252b2e"
              >
                <Input
                  required
                  pattern="#[0-9a-fA-F]{6}"
                  maxLength={7}
                  value={draft.secondary}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      secondary: event.currentTarget.value,
                    });
                  }}
                />
              </Field>
              <h2>Search and contact</h2>
              <Field label="Search title" hint="Up to 70 characters">
                <Input
                  maxLength={70}
                  value={draft.seoTitle}
                  onChange={(event) => {
                    setDraft({ ...draft, seoTitle: event.currentTarget.value });
                  }}
                />
              </Field>
              <Field label="Search description" hint="Up to 160 characters">
                <Input
                  maxLength={160}
                  value={draft.seoDescription}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      seoDescription: event.currentTarget.value,
                    });
                  }}
                />
              </Field>
              <Field
                label="Canonical path"
                hint="Optional path, such as /about"
              >
                <Input
                  maxLength={300}
                  value={draft.canonicalPath}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      canonicalPath: event.currentTarget.value,
                    });
                  }}
                />
              </Field>
              <Field
                label="Social sharing image URL"
                hint="Optional secure HTTPS image URL"
              >
                <Input
                  type="url"
                  value={draft.openGraphImageUrl}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      openGraphImageUrl: event.currentTarget.value,
                    });
                  }}
                />
              </Field>
              <Field label="Contact inbox email">
                <Input
                  type="email"
                  value={draft.contactInboxEmail}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      contactInboxEmail: event.currentTarget.value,
                    });
                  }}
                />
              </Field>
              {settingsError && <p role="alert">{settingsError}</p>}
              <Button type="submit" disabled={saveSettings.isPending}>
                {saveSettings.isPending ? 'Saving…' : 'Save website settings'}
              </Button>
            </form>
          </Card>
          <div className="website-menu-stack">
            {renderMenuEditor('header')}
            {renderMenuEditor('footer')}
            {menuError && <p role="alert">{menuError}</p>}
          </div>
        </div>
      </main>
    </AppShell>
  );
}

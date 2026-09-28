import { useEffect, useRef, useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button, Input } from './primitives';

export type ShellNavItem = {
  label: string;
  to: string;
  icon?: ReactNode;
  current?: boolean;
};
export type ShellNavGroup = {
  label: string;
  icon?: ReactNode;
  items: ShellNavItem[];
};

export function AppShell({
  orgName,
  orgSwitcher,
  navigation,
  actions,
  mobileTabs,
  onGlobalSearch,
  searchResults = [],
  searchLoading = false,
  searchError,
  children,
}: PropsWithChildren<{
  orgName: string;
  orgSwitcher?: ReactNode;
  navigation: ShellNavGroup[];
  actions?: ReactNode;
  mobileTabs?: ShellNavItem[];
  onGlobalSearch?: (query: string) => void;
  searchResults?: ShellNavItem[];
  searchLoading?: boolean;
  searchError?: string | undefined;
}>): React.JSX.Element {
  const { t } = useTranslation('shell');
  const [active, setActive] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const paletteRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
      const target = event.target;
      const isEditing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.matches('input, textarea, select, [role="textbox"]'));
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !isEditing) {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key === 'Escape') {
        setActive(null);
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  useEffect(() => {
    const dialog = paletteRef.current;
    if (!dialog) return;
    if (paletteOpen && !dialog.open) dialog.showModal();
    if (!paletteOpen && dialog.open) dialog.close();
  }, [paletteOpen]);
  const allItems = navigation.flatMap((group) => group.items);
  const destinationResults = allItems.filter((item) =>
    item.label.toLowerCase().includes(query.toLowerCase()),
  );
  const results = onGlobalSearch
    ? query.trim()
      ? searchSubmitted
        ? searchResults
        : []
      : allItems
    : destinationResults;
  return (
    <div
      className={`ui-app-shell${mobileTabs?.length ? ' ui-shell-has-tabs' : ''}`}
    >
      <header className="topbar ui-topbar">
        <Link to="/" className="brand-mark" aria-label={t('brandHome')}>
          <span>A</span>
        </Link>
        {orgSwitcher ?? <span className="org-name">{orgName}</span>}
        <nav className="main-navigation" aria-label={t('mainNavigation')}>
          {navigation.map((group) => (
            <div className="ui-nav-group" key={group.label}>
              <button
                type="button"
                className={`nav-trigger${active === group.label ? ' selected' : ''}`}
                aria-expanded={active === group.label}
                onClick={() => {
                  setActive(active === group.label ? null : group.label);
                }}
              >
                {group.icon ?? group.items[0]?.icon}
                <span>{group.label}</span>
              </button>
              {active === group.label && (
                <div
                  className="mega-menu"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setActive(null);
                  }}
                >
                  {group.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      aria-current={item.current ? 'page' : undefined}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <button
          className="ui-global-search"
          type="button"
          aria-label={t('searchAthlentry')}
          onClick={() => {
            setPaletteOpen(true);
          }}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <span>{t('searchLabel')}</span>
        </button>
        <div className="ui-shell-actions">{actions}</div>
      </header>
      {active && (
        <button
          className="ui-menu-dismiss"
          aria-label={t('closeNavigationMenu')}
          onClick={() => {
            setActive(null);
          }}
        />
      )}
      {children}
      {mobileTabs?.length ? (
        <nav className="ui-mobile-tabs" aria-label={t('mobileNavigation')}>
          {mobileTabs.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-current={item.current ? 'page' : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
      ) : null}
      <dialog
        className="ui-command-dialog"
        ref={paletteRef}
        aria-label={t('commandPalette')}
        onClose={() => {
          // A queued close event from Escape can arrive after the next shortcut
          // has reopened the dialog. Keep the newer open state in that case.
          if (!paletteRef.current?.open) setPaletteOpen(false);
        }}
      >
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) {
              setSearchSubmitted(true);
              onGlobalSearch?.(query.trim());
            }
          }}
        >
          <Input
            autoFocus
            type="search"
            aria-label={
              onGlobalSearch ? t('searchAthlentry') : t('searchPagesAndActions')
            }
            aria-busy={searchLoading}
            placeholder={
              onGlobalSearch
                ? t('searchPeopleProgramsTeamsInvoices')
                : t('searchPagesAndActions')
            }
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchSubmitted(false);
            }}
          />
          <Button
            type="button"
            secondary
            aria-label={t('close')}
            onClick={() => {
              setPaletteOpen(false);
            }}
          >
            ×
          </Button>
        </form>
        <ul>
          {results.map((item) => (
            <li key={`${item.to}-${item.label}`}>
              <Link
                to={item.to}
                onClick={() => {
                  setPaletteOpen(false);
                }}
              >
                {item.label}
              </Link>
            </li>
          ))}
          {onGlobalSearch && searchLoading && (
            <li role="status">{t('searching')}</li>
          )}
          {onGlobalSearch && searchSubmitted && searchError && (
            <li role="alert">{searchError}</li>
          )}
          {!results.length &&
            !searchLoading &&
            (!searchError || !searchSubmitted) && (
              <li>
                {onGlobalSearch
                  ? searchSubmitted
                    ? t('noMatchingResults')
                    : t('pressEnterToSearch')
                  : t('noMatchingDestinations')}
              </li>
            )}
        </ul>
      </dialog>
    </div>
  );
}

export function GlobalSearch({
  value,
  onChange,
  onSubmit,
  results = [],
  loading = false,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (query: string) => void;
  results?: ShellNavItem[];
  loading?: boolean;
  placeholder?: string;
}): React.JSX.Element {
  const { t } = useTranslation('shell');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const submitted = value.trim() !== '' && value.trim() === submittedQuery;
  return (
    <form
      className="ui-global-search-form"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value.trim());
        setSubmittedQuery(value.trim());
      }}
    >
      <Input
        type="search"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        aria-busy={loading}
        placeholder={placeholder ?? t('searchPeopleProgramsInvoices')}
        aria-label={t('globalSearch')}
      />
      <Button secondary disabled={!value.trim()}>
        {t('searchButton')}
      </Button>
      {loading && <span role="status">{t('searching')}</span>}
      {!loading && submitted && (
        <ul
          className="ui-global-search-results"
          aria-label={t('searchResults')}
        >
          {results.map((result) => (
            <li key={`${result.to}-${result.label}`}>
              <Link to={result.to}>{result.label}</Link>
            </li>
          ))}
          {!results.length && <li>{t('noMatchingResults')}</li>}
        </ul>
      )}
    </form>
  );
}

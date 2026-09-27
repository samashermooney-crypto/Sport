import { useEffect, useRef, useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { Link } from 'react-router';

import { Button, Input } from './primitives';

export type ShellNavItem = {
  label: string;
  to: string;
  icon?: ReactNode;
  current?: boolean;
};
export type ShellNavGroup = { label: string; items: ShellNavItem[] };

export function AppShell({
  orgName,
  orgSwitcher,
  navigation,
  actions,
  mobileTabs,
  children,
}: PropsWithChildren<{
  orgName: string;
  orgSwitcher?: ReactNode;
  navigation: ShellNavGroup[];
  actions?: ReactNode;
  mobileTabs?: ShellNavItem[];
}>): React.JSX.Element {
  const [active, setActive] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const paletteRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
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
  const results = allItems.filter((item) =>
    item.label.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="ui-app-shell">
      <header className="topbar ui-topbar">
        <Link to="/" className="brand-mark" aria-label="Athlentry home">
          A
        </Link>
        {orgSwitcher ?? <span className="org-name">{orgName}</span>}
        <nav className="main-navigation" aria-label="Main navigation">
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
                {group.items[0]?.icon}
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
          onClick={() => {
            setPaletteOpen(true);
          }}
        >
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="ui-shell-actions">{actions}</div>
      </header>
      {active && (
        <button
          className="ui-menu-dismiss"
          aria-label="Close navigation menu"
          onClick={() => {
            setActive(null);
          }}
        />
      )}
      {children}
      {mobileTabs?.length ? (
        <nav className="ui-mobile-tabs" aria-label="Mobile navigation">
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
        aria-label="Command palette"
        onClose={() => {
          setPaletteOpen(false);
        }}
      >
        <form method="dialog">
          <Input
            autoFocus
            type="search"
            aria-label="Search pages and actions"
            placeholder="Search pages and actions"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <Button secondary value="close" aria-label="Close">
            ×
          </Button>
        </form>
        <ul>
          {results.map((item) => (
            <li key={item.to}>
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
          {!results.length && <li>No matching destinations</li>}
        </ul>
      </dialog>
    </div>
  );
}

export function GlobalSearch({
  value,
  onChange,
  onSubmit,
  placeholder = 'Search people, programs, invoices…',
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
}): React.JSX.Element {
  return (
    <form
      className="ui-global-search-form"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        type="search"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder={placeholder}
        aria-label="Global search"
      />
      <Button secondary disabled={!value.trim()}>
        Search
      </Button>
    </form>
  );
}

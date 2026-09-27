import type { CSSProperties, PropsWithChildren } from 'react';
import { Link } from 'react-router';

import './public-site-shell.css';

export type PublicSiteShellLink = {
  label: string;
  to: string;
  current?: boolean;
};

type PublicSiteShellProps = PropsWithChildren<{
  organizationName: string;
  homeTo: string;
  navigation: readonly PublicSiteShellLink[];
  memberLink: PublicSiteShellLink;
  administratorLink: PublicSiteShellLink;
  primaryColor?: string;
  secondaryColor?: string;
  footerLinks?: readonly PublicSiteShellLink[];
  footerCredit?: string;
  logoMark?: string;
  skipLinkLabel?: string;
  navigationLabel?: string;
}>;

type SiteStyle = CSSProperties & {
  '--site-primary'?: string;
  '--site-secondary'?: string;
};

function renderLink(link: PublicSiteShellLink, className?: string) {
  return (
    <Link
      key={`${link.label}:${link.to}`}
      aria-current={link.current ? 'page' : undefined}
      className={className}
      to={link.to}
    >
      {link.label}
    </Link>
  );
}

export function PublicSiteShell({
  organizationName,
  homeTo,
  navigation,
  memberLink,
  administratorLink,
  primaryColor,
  secondaryColor,
  footerLinks = [],
  footerCredit = 'Powered by Athlentry',
  logoMark = 'A',
  skipLinkLabel = 'Skip to content',
  navigationLabel = 'Website navigation',
  children,
}: PublicSiteShellProps): React.JSX.Element {
  const style: SiteStyle = {
    ...(primaryColor ? { '--site-primary': primaryColor } : {}),
    ...(secondaryColor ? { '--site-secondary': secondaryColor } : {}),
  };

  return (
    <div className="ui-public-site" style={style}>
      <a className="ui-public-site__skip-link" href="#ui-public-site-main">
        {skipLinkLabel}
      </a>
      <header className="ui-public-site__header">
        <Link
          aria-label={`${organizationName} home`}
          className="ui-public-site__brand"
          to={homeTo}
        >
          <span aria-hidden="true" className="ui-public-site__mark">
            {logoMark}
          </span>
          <span>{organizationName}</span>
        </Link>
        <div className="ui-public-site__account-links">
          {renderLink(memberLink)}
          {renderLink(administratorLink)}
        </div>
      </header>
      <nav aria-label={navigationLabel} className="ui-public-site__nav">
        <ul>
          {navigation.map((item) => (
            <li key={`${item.label}:${item.to}`}>{renderLink(item)}</li>
          ))}
        </ul>
      </nav>
      <main className="ui-public-site__main" id="ui-public-site-main">
        {children}
      </main>
      <footer className="ui-public-site__footer">
        <strong>{organizationName}</strong>
        {footerLinks.length ? (
          <div className="ui-public-site__footer-links">
            {footerLinks.map((item) => renderLink(item))}
          </div>
        ) : null}
        <small>{footerCredit}</small>
      </footer>
    </div>
  );
}

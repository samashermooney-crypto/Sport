import { Link, useParams } from 'react-router';

import './landing.css';

type LegalSection = { heading: string; body: string };
type LegalDocument = { title: string; sections: readonly LegalSection[] };

const legalDocuments: Record<string, LegalDocument> = {
  terms: {
    title: 'Terms of Service',
    sections: [
      {
        heading: 'Who these terms cover',
        body: 'These terms describe the web services Athlentry makes available to sports organizations, their staff, participants, and families. An organization controls its own programs, membership, and public website. Access and available features depend on the organization and the user’s assigned role.',
      },
      {
        heading: 'Organization responsibilities',
        body: 'Organizations are responsible for the accuracy of their content, permissions, schedules, registration terms, waivers, refund policy, and communications. Organizations must obtain any consent required before entering a child’s information, sending messages, publishing media, or collecting a payment.',
      },
      {
        heading: 'Accounts and acceptable use',
        body: 'Keep account credentials private, use only the access granted to you, and report suspected account misuse to the organization. Do not interfere with the service, access another person’s records, upload malicious material, or use the service to violate a law or another person’s rights.',
      },
      {
        heading: 'Payments and organization policies',
        body: 'Where online payments are enabled, payment details are handled by the payment provider. The organization’s displayed invoice, installment, and refund terms apply to its programs. Athlentry does not change those terms on the organization’s behalf.',
      },
      {
        heading: 'Availability and changes',
        body: 'Features may change as the service develops. Athlentry does not promise uninterrupted availability, a particular outcome, or a production service level. Mandatory consumer rights remain unaffected.',
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    sections: [
      {
        heading: 'Information processed',
        body: 'The service may process account and contact details, household relationships, participant profiles, registrations, schedules, attendance, consent records, messages, safety and compliance status, and payment or invoice records. Sensitive information is restricted by role and used only for the organization’s documented purposes.',
      },
      {
        heading: 'Children and family accounts',
        body: 'Sports organizations determine why participant information is collected and who may access it. Guardian and staff access is limited by organization relationships and permissions. Organizations must provide required notices and obtain required parent or guardian consent before entering a child’s information. Each organization must assess its duties under COPPA and other children’s privacy laws; this draft does not determine which laws apply to a particular organization or activity.',
      },
      {
        heading: 'Service providers',
        body: 'Provider use depends on the deployment and enabled features. The processor inventory includes Stripe for payment processing; email and SMS providers such as Resend and Twilio when configured; hosting and object-storage providers; Sentry when configured; and Anthropic only if an optional AI feature is enabled. Each organization should receive the current deployment-specific list before production use.',
      },
      {
        heading: 'Retention and requests',
        body: 'Organizations can request access, correction, or deletion/anonymization of eligible records. Financial, waiver, safety, compliance, and audit records may be retained or pseudonymized when required by the documented retention policy or law. A request is reviewed before any change is made.',
      },
      {
        heading: 'FERPA and education records',
        body: 'Athlentry is a sports organization management service, not a school record system, and FERPA generally does not apply to sports records held outside an educational agency or institution. Applicability depends on the organization and the specific records it shares. Organizations should obtain legal guidance before using the service with education records.',
      },
      {
        heading: 'Questions and requests',
        body: 'For information held by a sports organization, contact that organization’s privacy contact or administrator. The organization can route platform requests through its authenticated support channel.',
      },
    ],
  },
  dpa: {
    title: 'Data Processing Addendum',
    sections: [
      {
        heading: 'Roles and instructions',
        body: 'This addendum applies when a sports organization uses Athlentry to process personal data it controls. The organization acts as controller or equivalent business and provides documented instructions. Athlentry processes that data to provide, secure, and support the configured service.',
      },
      {
        heading: 'Confidentiality and security',
        body: 'Personnel and service providers with access are expected to protect personal data. The service applies organization-scoped access controls, role checks, audit events, and encryption for designated sensitive fields. Production safeguards depend on deployment configuration and must be verified before an organization relies on them.',
      },
      {
        heading: 'Subprocessors and incidents',
        body: 'The deployment-specific subprocessor list must be supplied to the organization before processing begins. The parties should agree on notice timing, cooperation, and contact routes for a confirmed personal data incident before this addendum is approved.',
      },
      {
        heading: 'Requests and end of service',
        body: 'Athlentry will provide service controls that help the organization review data-subject requests. On termination, data export and deletion are subject to the organization’s instructions, backups, legal retention obligations, and records that must be retained or pseudonymized.',
      },
    ],
  },
  'acceptable-use': {
    title: 'Acceptable Use Policy',
    sections: [
      {
        heading: 'Protect people and records',
        body: 'Use only your assigned account and role. Do not search for, disclose, or alter another person’s records without an approved purpose. Do not use participant or family information for unrelated advertising, profiling, or contact.',
      },
      {
        heading: 'Prohibited activity',
        body: 'Do not attempt to bypass authentication, tenant boundaries, safety controls, payment controls, or rate limits. Do not upload malware, exploit the service, harass users, threaten participants, or publish media without the required permission.',
      },
      {
        heading: 'Reporting and enforcement',
        body: 'Report suspected abuse or a security issue through the organization’s administrator. Access may be restricted while an organization or the service investigates a safety, privacy, security, or legal concern.',
      },
    ],
  },
  subprocessors: {
    title: 'Subprocessors',
    sections: [
      {
        heading: 'Deployment-specific inventory',
        body: 'The services below are the categories in the processor inventory. A production operator must publish the exact vendor, processing purpose, hosting region, and current status for each enabled integration before launch.',
      },
      {
        heading: 'Payment processing',
        body: 'Stripe may process payment instrument details and transaction data when an organization enables online payments. Card details are entered through Stripe-hosted or Stripe-provided components.',
      },
      {
        heading: 'Communications',
        body: 'A configured email provider (including Resend where enabled) may deliver email. Twilio may deliver SMS when the organization enables consent-based text messaging. Push delivery uses the configured browser push service.',
      },
      {
        heading: 'Hosting, storage, monitoring, and optional AI',
        body: 'The deployment’s hosting and object-storage providers may process service data. Sentry may receive diagnostic events when configured. Anthropic may process prompts only when an optional AI feature is enabled and the operator has configured it.',
      },
    ],
  },
  security: {
    title: 'Security Overview',
    sections: [
      {
        heading: 'Tenant and role boundaries',
        body: 'Organization data access is scoped to an organization context and database row-level policies. Routes check the user’s role before returning protected data or accepting a change. Restricted safety and medical details receive narrower access and read auditing.',
      },
      {
        heading: 'Data protection',
        body: 'Designated sensitive fields are encrypted at rest by the application. Payment credentials are handled by the payment provider. Audit and financial records are retained or anonymized according to their documented rules rather than silently erased.',
      },
      {
        heading: 'Development and incident response',
        body: 'Development and automated tests use fake messaging and payment adapters. Production deployment, monitoring, key management, backups, and incident response depend on operator configuration and must pass the launch checks before release.',
      },
      {
        heading: 'Report a concern',
        body: 'Organization users should contact their administrator about account or data access concerns. Operators should follow the security disclosure and incident response procedures in the repository’s security documentation.',
      },
    ],
  },
  accessibility: {
    title: 'Accessibility Statement',
    sections: [
      {
        heading: 'Our approach',
        body: 'Athlentry is being built toward WCAG 2.2 AA. The interface supports keyboard operation, visible focus, semantic labels, reduced motion preferences, and accessible error announcements where those flows have been implemented.',
      },
      {
        heading: 'Known limitations',
        body: 'Accessibility coverage is still being completed across the application and public organization sites. Some routes and third-party payment controls may not yet meet every criterion. This statement does not claim a completed independent audit or conformance certification.',
      },
      {
        heading: 'Request an accommodation',
        body: 'If a screen or workflow blocks you, contact the sports organization that provided your account and include the page and task you were trying to complete. Its administrator can route the issue to the service team.',
      },
    ],
  },
};

export function LegalPage(): React.JSX.Element {
  const { slug = '' } = useParams();
  const document = legalDocuments[slug];
  const approved = import.meta.env.LEGAL_DOCS_APPROVED === 'true';
  if (!document)
    return (
      <main className="al legal-page" role="alert">
        <h1>Document not found</h1>
        <Link to="/welcome">Return to Athlentry</Link>
      </main>
    );

  return (
    <div className="al legal-page">
      <header className="al-nav">
        <Link className="al-logo" to="/welcome" aria-label="Athlentry home">
          <span className="al-symbol">A</span>athlentry
        </Link>
        <Link className="al-nav-cta" to="/">
          Open platform
        </Link>
      </header>
      <main id="main" className="al-section">
        {!approved && (
          <p className="legal-page__draft" role="status">
            DRAFT — requires legal review
          </p>
        )}
        <p className="al-label">ATHLENTRY LEGAL AND TRUST</p>
        <h1>{document.title}</h1>
        {!approved && (
          <p className="legal-page__lead">
            This document is a draft for review. It is not approved for
            production use.
          </p>
        )}
        {document.sections.map((section, index) => {
          const headingId = `legal-${slug}-${String(index + 1)}`;
          return (
            <section key={section.heading} aria-labelledby={headingId}>
              <h2 id={headingId}>{section.heading}</h2>
              <p>{section.body}</p>
            </section>
          );
        })}
      </main>
      <footer className="al-footer">
        <Link className="al-logo" to="/welcome">
          athlentry
        </Link>
        <Link to="/legal/terms">Terms</Link>
        <Link to="/legal/privacy">Privacy</Link>
        <Link to="/legal/accessibility">Accessibility</Link>
      </footer>
    </div>
  );
}

# Organization custom domains

Organization websites support `https://{slug}.<APP_DOMAIN>` and `https://<APP_DOMAIN>/o/{slug}`. A verified custom hostname is an alias for one organization website. The application records the requested hostname, proves control with a TXT token, and resolves the hostname to the owning organization. The organization slug path remains the fallback if a custom hostname is unavailable.

## Before changing DNS

- Confirm the requesting organization is active and that the requester has the site's domain-management permission.
- Confirm the domain is not already verified or assigned to another organization. Use the exact hostname (for example, `club.example.org`); do not map a public suffix or wildcard domain.
- Ask the organization to keep its current site online until verification and TLS provisioning complete. Do not change the organization's registrar account or credentials.

## Verify and route a hostname

1. In the Athlentry website domain settings, add the exact hostname and copy the generated TXT record name and value. The token is unique to that hostname and organization; do not reuse it for another domain.
2. The domain owner adds the TXT record at its DNS provider. Wait for the record to resolve publicly, then use the product's verify action. A failed verification does not reserve the hostname permanently; check spelling, DNS propagation and duplicate ownership before retrying.
3. After verification succeeds, configure Cloudflare for SaaS custom hostnames for the production zone. Add the hostname as a customer hostname and set the target to the Athlentry fallback origin provided by the hosting setup. Keep DNS proxy/TLS settings consistent with the Cloudflare for SaaS onboarding instructions for the configured zone.
4. Complete the Cloudflare domain-control/TLS challenge and wait until the custom hostname certificate is active. The app must not advertise the custom URL as ready before TLS is active.
5. Have the organization owner test the public home page, a nested page, canonical URL and redirect behavior over HTTPS. Check that the hostname resolves to the correct organization and that another organization's unpublished pages are not exposed.
6. Record the organization ID, hostname, verification result, TLS state and operator in the audit trail. Do not record the TXT secret in support notes.

## Renewal, removal and troubleshooting

- Keep the TXT ownership record in place while the hostname is attached. If ownership expires or the record is removed, investigate before disabling the domain; do not transfer it to another organization without fresh proof of control.
- For `pending` TLS, check the Cloudflare for SaaS hostname state, DNS target, CAA records and challenge completion. Let certificate issuance finish before asking the organization to switch links.
- For a hostname resolving to the wrong site, disable that mapping through the audited domain workflow, confirm the slug URL still works, then correct the association. Never edit tenant domain rows directly.
- For a certificate or DNS incident, direct the organization to its own DNS administrator and the configured hosting operator. Do not request registrar passwords, API tokens or screenshots containing account secrets.
- When removing a custom domain, preserve domain-verification and audit records, remove the routing association, and confirm the slug URL remains available. A later owner must repeat domain verification.

Cloudflare for SaaS and TLS account setup are operator steps. The application does not claim that it provisions DNS, certificates or a Cloudflare account by itself.

import type { RequestHandler } from 'express';

export interface SecurityHeaderOptions {
  production?: boolean;
  storagePublicOrigin?: string;
}

function storageOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Storage public origin must be an absolute HTTP(S) URL');
  }
  if (!['https:', 'http:'].includes(parsed.protocol))
    throw new Error('Storage public origin must be an absolute HTTP(S) URL');
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Storage public origin must be an origin only');
  }
  return parsed.origin;
}

/**
 * Sets the Phase 16 response-header policy. Track C mounts this before API and
 * static routes in app.ts. The only framing exception is the explicit embed
 * surface; do not infer it from a query parameter or request header.
 */
export function createSecurityHeaders(
  options: SecurityHeaderOptions = {},
): RequestHandler {
  const storage = storageOrigin(options.storagePublicOrigin);
  const imageSources = [
    "'self'",
    'data:',
    'blob:',
    ...(storage ? [storage] : []),
  ];
  const production =
    options.production ?? process.env.NODE_ENV === 'production';

  return (request, response, next) => {
    const isEmbed =
      request.path === '/embed' || request.path.startsWith('/embed/');
    const frameAncestors = isEmbed ? '*' : "'none'";
    const directives = [
      "default-src 'self'",
      "script-src 'self' https://js.stripe.com https://challenges.cloudflare.com",
      'frame-src https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com',
      "connect-src 'self' https://api.stripe.com",
      `img-src ${imageSources.join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ];

    response.setHeader('Content-Security-Policy', directives.join('; '));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    if (isEmbed) response.removeHeader('X-Frame-Options');
    else response.setHeader('X-Frame-Options', 'DENY');
    if (production)
      response.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    next();
  };
}

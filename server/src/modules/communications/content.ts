const gsmBasic = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const gsmExtended = new Set([
  '^',
  '{',
  '}',
  '\\',
  '[',
  ']',
  '~',
  '|',
  '€',
  '\f',
]);

export function smsSegmentCount(text: string): number {
  let gsmUnits = 0;
  let isGsm = true;
  for (const character of text) {
    if (gsmBasic.has(character)) gsmUnits += 1;
    else if (gsmExtended.has(character)) gsmUnits += 2;
    else {
      isGsm = false;
      break;
    }
  }
  if (isGsm) return gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
  const units = text.length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

export type MergeContext = Readonly<Record<string, string | null | undefined>>;
const mergeField =
  /^\{\{\s*((?:[a-z]+\.){1,2}[a-z_]+)(?:\s*\|\s*([^{}|]{1,120}))?\s*\}\}$/;

export function renderMergeFields(
  text: string,
  context: MergeContext,
  escapeHtml = false,
): string {
  return text.replace(/\{\{[^{}]*\}\}/g, (token) => {
    const match = mergeField.exec(token);
    if (!match) return '';
    const key = match[1] ?? '';
    const fallback = match[2]?.trim() ?? '';
    const value = context[key] ?? fallback;
    return escapeHtml ? escapeHtmlText(value) : value;
  });
}

export function sanitizeCampaignHtml(html: string, appUrl: string): string {
  let safe = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      '',
    )
    .replace(
      /<(script|style|iframe|object|embed|svg|math)\b[^>]*\/?\s*>/gi,
      '',
    );
  const allowed = new Set([
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'blockquote',
    'a',
  ]);
  const origin = URL.canParse(appUrl) ? new URL(appUrl).origin : '';
  safe = safe.replace(
    /<\/?([a-zA-Z0-9]+)\b([^>]*)>/g,
    (whole, rawName: string, attrs: string) => {
      const name = rawName.toLowerCase();
      if (!allowed.has(name)) return '';
      const closing = /^<\//.test(whole);
      if (closing || name === 'br') return closing ? `</${name}>` : '<br>';
      if (name !== 'a') return `<${name}>`;
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
        attrs,
      );
      const rawHref = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
      let href = '';
      if (rawHref.startsWith('/') && !rawHref.startsWith('//')) href = rawHref;
      else if (
        origin &&
        URL.canParse(rawHref) &&
        new URL(rawHref).origin === origin
      )
        href =
          new URL(rawHref).pathname +
          new URL(rawHref).search +
          new URL(rawHref).hash;
      return href ? `<a href="${escapeHtmlAttribute(href)}">` : '<a>';
    },
  );
  return safe;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value);
}

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface HelpArticle {
  slug: string;
  locale: string;
  audience: 'admin' | 'family' | 'all';
  title: string;
  summary: string;
  category: string;
  order: number;
  body: string;
}

let cache: HelpArticle[] | null = null;
let cacheDir: string | null = null;

function findHelpDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '../docs/help'),
    path.resolve(process.cwd(), 'docs/help'),
    path.resolve(process.cwd(), '../../docs/help'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

function parseArticle(fileName: string, text: string): HelpArticle | null {
  const parts = fileName.replace(/\.md$/, '').split('.');
  if (parts.length < 2) return null;
  const locale = parts.at(-1) ?? 'en';
  const slug = parts.slice(0, -1).join('.');
  const meta: Record<string, string> = {};
  let body = text;
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (front) {
    for (const line of front[1]?.split('\n') ?? []) {
      const separator = line.indexOf(':');
      if (separator > 0)
        meta[line.slice(0, separator).trim()] = line
          .slice(separator + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
    }
    body = text.slice(front[0].length);
  }
  const audience =
    meta['audience'] === 'admin' || meta['audience'] === 'family'
      ? meta['audience']
      : 'all';
  return {
    slug,
    locale,
    audience,
    title: meta['title'] ?? slug,
    summary: meta['summary'] ?? '',
    category: meta['category'] ?? 'General',
    order: Number(meta['order'] ?? 100),
    body: body.trim(),
  };
}

export function listHelpArticles(): HelpArticle[] {
  const dir = findHelpDir();
  if (dir === cacheDir && cache) return cache;
  cache = [];
  cacheDir = dir;
  if (!dir) return cache;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md')) continue;
    const article = parseArticle(
      file,
      readFileSync(path.join(dir, file), 'utf8'),
    );
    if (article) cache.push(article);
  }
  return cache;
}

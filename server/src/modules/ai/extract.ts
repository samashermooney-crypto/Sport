import { inflateSync } from 'node:zlib';

import { readZip, isZip } from '../imports/phase15-zip';

export class ExtractError extends Error {}

function decodePdfString(raw: string): string {
  return raw.replaceAll(/\\([\\()])/g, '$1');
}

// Minimal PDF text extraction: walk content streams, inflate, and pull out the
// text operators (Tj, TJ, ', "). Covers unencrypted generated PDFs well enough
// for form drafting; richer parsing can come later.
function extractPdfText(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString('latin1');
  const out: string[] = [];
  const streamPattern = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(source))) {
    const start = match.index + match[0].length;
    const end = source.indexOf('endstream', start);
    if (end < 0) continue;
    const chunk = Buffer.from(source.slice(start, end), 'latin1');
    let content: string;
    try {
      content = inflateSync(chunk).toString('latin1');
    } catch {
      content = chunk.toString('latin1');
    }
    for (const op of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g))
      out.push(decodePdfString(op[1] ?? ''));
    for (const op of content.matchAll(/\[((?:[^\][])*)\]\s*TJ/g)) {
      const parts = op[1] ?? '';
      const pieces = [...parts.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map(
        (inner) => decodePdfString(inner[1] ?? ''),
      );
      if (pieces.length > 0) out.push(pieces.join(''));
    }
  }
  return out.join('\n');
}

function extractDocxText(bytes: Uint8Array): string {
  if (!isZip(bytes)) throw new ExtractError('Invalid DOCX file');
  const entries = readZip(bytes);
  const document = entries.find((entry) => entry.name === 'word/document.xml');
  if (!document) throw new ExtractError('DOCX has no document.xml');
  const xml = Buffer.from(document.bytes).toString('utf8');
  const paragraphs = xml
    .split(/<\/w:p>/)
    .map((paragraph) => {
      const runs = [...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(
        (run) => run[1] ?? '',
      );
      return runs.join('');
    })
    .filter((paragraph) => paragraph.trim().length > 0);
  return paragraphs.join('\n');
}

export function extractText(fileName: string, bytes: Uint8Array): string {
  const lower = fileName.toLowerCase();
  let text: string;
  if (lower.endsWith('.docx') || (isZip(bytes) && lower.endsWith('.doc'))) {
    if (!lower.endsWith('.docx'))
      throw new ExtractError('Only .docx Word files are supported');
    text = extractDocxText(bytes);
  } else if (lower.endsWith('.pdf') || bytes[0] === 0x25) {
    text = extractPdfText(bytes);
  } else if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    text = Buffer.from(bytes).toString('utf8');
  } else {
    throw new ExtractError(
      'Unsupported file type. Upload a PDF, DOCX, or text file.',
    );
  }
  const trimmed = text.trim();
  if (!trimmed) throw new ExtractError('No readable text found in that file');
  return trimmed.slice(0, 50_000);
}

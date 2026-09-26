// Source snippets for cited components.
//
// The bridge reports `file:line` from the target's own metadata; this turns
// that into the text around it, so a proposal can say where to edit rather than
// only what to change.
//
// Why the supervisor and not the target's dev server: `GET
// <target>/src/Button.tsx` answers with the *transformed* module for a Vite
// target, so the line number already in hand would not line up with the text,
// and the proxy emits no CORS headers so the body would not even be readable.
// The supervisor already knows the project root and gates its routes to the
// active app origin, which is exactly the authority this needs.
//
// The text that comes back is the target project's source: authored by the
// user, but still untrusted as far as this app is concerned, so it is bounded
// and cleaned before it is rendered or copied anywhere.

import { SUPERVISOR_DEFAULT_BASE, type FetchLike } from '../supervisor/client.ts';

export const SOURCE_BEFORE_LINES = 8;
export const SOURCE_AFTER_LINES = 8;
export const SOURCE_MAX_LINES = 400;
export const SOURCE_MAX_LINE_CHARS = 500;

export type SourceRefusal =
  | 'no-path'
  | 'bad-path'
  | 'bad-extension'
  | 'refused-directory'
  | 'outside-root'
  | 'not-a-file'
  | 'too-large'
  | 'unreadable'
  | 'supervisor-absent'
  | 'request-failed';

export interface SourceSnippet {
  /** Project-relative path, echoed by the supervisor. */
  path: string;
  /** 1-based first line in `lines`. */
  startLine: number;
  /** 1-based last line in `lines`. */
  endLine: number;
  totalLines: number;
  lines: string[];
}

export type SourceResult =
  | { ok: true; snippet: SourceSnippet }
  | { ok: false; reason: SourceRefusal };

const REFUSALS: ReadonlySet<string> = new Set([
  'no-path',
  'bad-path',
  'bad-extension',
  'refused-directory',
  'outside-root',
  'not-a-file',
  'too-large',
  'unreadable',
]);

/**
 * Every control character except the tab.
 *
 * Source files are full of box-drawing characters and emoji that survive this
 * intact, and a tab is indentation. What must not survive is everything else:
 * the host splits lines before sending, so a newline here can only come from a
 * body that is not what it claims — and one embedded newline would render as
 * two lines while the heading counted one.
 */
// oxlint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

function cleanLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(UNSAFE_CHARS, '');
  if (cleaned.length > SOURCE_MAX_LINE_CHARS) return `${cleaned.slice(0, SOURCE_MAX_LINE_CHARS - 1)}…`;
  return cleaned;
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseSnippet(value: unknown): SourceSnippet | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const path = cleanLine(raw['path']);
  if (path === null || path.length === 0) return null;
  const lines: string[] = [];
  if (Array.isArray(raw['lines'])) {
    for (const entry of raw['lines']) {
      const line = cleanLine(entry);
      if (line === null) return null;
      lines.push(line);
      if (lines.length >= SOURCE_MAX_LINES) break;
    }
  }
  if (lines.length === 0) return null;
  const startLine = boundedInt(raw['startLine'], 1, 1_000_000, 1);
  const totalLines = boundedInt(raw['totalLines'], lines.length, 1_000_000, startLine + lines.length - 1);
  return {
    path,
    startLine,
    // endLine is derived from what actually survived, and bounded on its own
    // rather than inheriting a startLine that is already at the cap.
    endLine: Math.min(1_000_000, startLine + lines.length - 1),
    totalLines,
    lines,
  };
}

export interface FetchSourceOptions {
  /** Project-relative path from the target's metadata. */
  path: string | null;
  /** 1-based cited line. */
  line: number | null;
  before?: number;
  after?: number;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchFn?: FetchLike;
}

export async function fetchSourceSnippet(options: FetchSourceOptions): Promise<SourceResult> {
  const path = typeof options.path === 'string' ? options.path.trim() : '';
  // A record with no location is the normal case for a target that never set up
  // metadata, and it is not an error worth a request.
  if (path === '') return { ok: false, reason: 'no-path' };
  const before = boundedInt(options.before, 0, SOURCE_MAX_LINES, SOURCE_BEFORE_LINES);
  const after = boundedInt(options.after, 0, SOURCE_MAX_LINES, SOURCE_AFTER_LINES);
  const line = boundedInt(options.line, 0, 1_000_000, 0);

  const base = (options.baseUrl ?? SUPERVISOR_DEFAULT_BASE).replace(/\/+$/, '');
  const query = new URLSearchParams({ path, line: String(line), before: String(before), after: String(after) });
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${base}/api/target/source?${query.toString()}`, {
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      let reason: SourceRefusal = 'request-failed';
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === 'string' && REFUSALS.has(body.error)) reason = body.error as SourceRefusal;
      } catch {
        // A body that is not the JSON we expect is just a failed request.
      }
      return { ok: false, reason };
    }
    const snippet = parseSnippet(await response.json());
    return snippet === null ? { ok: false, reason: 'request-failed' } : { ok: true, snippet };
  } catch {
    // No supervisor, wrong port, aborted, offline: all the same to the caller.
    return { ok: false, reason: 'supervisor-absent' };
  }
}

/** `file.tsx:42` for a heading, or null when there is no location to show. */
export function sourceLabel(path: string | null, line: number | null): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null;
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0
    ? `${path.trim()}:${line}`
    : path.trim();
}

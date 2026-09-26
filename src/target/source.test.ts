// Source snippets for cited components: the request the app makes, and what it
// accepts back.
//
// Everything here is untrusted in one direction or the other. The query is
// built from the target's own `file:line` metadata, and the body that comes
// back is the target project's source read by a separate process, so the tests
// pin two things: that the request is addressed to the supervisor and encoded
// well enough to survive, and that a body the app did not write cannot put a
// bad line number, a control character or an unterminated quote into the UI.

import { describe, expect, it, vi } from 'vitest';
import {
  SOURCE_AFTER_LINES,
  SOURCE_BEFORE_LINES,
  SOURCE_MAX_LINE_CHARS,
  SOURCE_MAX_LINES,
  fetchSourceSnippet,
  sourceLabel,
} from './source.ts';
import type { SourceResult, SourceSnippet } from './source.ts';

const BASE = 'http://127.0.0.1:5199';

const WINDOW = {
  path: 'src/Button.tsx',
  startLine: 12,
  endLine: 14,
  totalLines: 140,
  lines: ['export function Button() {', '  return <button />;', '}'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The union is only readable through a narrowing the matcher cannot do. */
function snippetOf(result: SourceResult): SourceSnippet {
  if (!result.ok) throw new Error(`expected a snippet, got reason ${result.reason}`);
  return result.snippet;
}

describe('fetchSourceSnippet request', () => {
  it('asks the supervisor for the window, never the target dev server', async () => {
    // The reason is in source.ts: a Vite target answers GET /src/Button.tsx with
    // the *transformed* module, so the cited line number would not line up with
    // the text the user is looking at.
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(WINDOW));
    await fetchSourceSnippet({ path: 'src/Button.tsx', line: 42, before: 4, after: 6, baseUrl: BASE, fetchFn });
    expect(fetchFn.mock.calls).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${BASE}/api/target/source?path=src%2FButton.tsx&line=42&before=4&after=6`);
    // `no-store` because the answer changes with every edit in the target, and
    // an empty init otherwise: the only other key allowed here is `signal`.
    expect(init).toEqual({ cache: 'no-store' });
  });

  it('percent-encodes a path with a space and Korean text so it survives the query', async () => {
    const path = 'src/주문 버튼.tsx';
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(WINDOW));
    await fetchSourceSnippet({ path, line: 7, baseUrl: `${BASE}///`, fetchFn });
    const [url] = fetchFn.mock.calls[0];
    // A trailing slash on the base would make the route a redirect target, and
    // a raw space or raw non-ASCII byte would truncate or mangle the request line.
    expect(url.startsWith(`${BASE}/api/target/source?`)).toBe(true);
    expect(url).not.toContain(' ');
    expect(url).not.toContain('주문');
    const sent = new URL(url).searchParams;
    expect(sent.get('path')).toBe(path);
    expect(sent.get('line')).toBe('7');
    // No cited line travels as 0, and the window defaults to 8 either side.
    expect(sent.get('before')).toBe(String(SOURCE_BEFORE_LINES));
    expect(sent.get('after')).toBe(String(SOURCE_AFTER_LINES));
  });

  it('sends no cited line as 0 rather than as a made-up one', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(WINDOW));
    await fetchSourceSnippet({ path: 'src/Button.tsx', line: null, baseUrl: BASE, fetchFn });
    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.get('line')).toBe('0');
  });

  it('bounds the requested context instead of passing a hostile one through', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(WINDOW));
    await fetchSourceSnippet({ path: 'src/Button.tsx', line: 5, before: -20, after: 99999, baseUrl: BASE, fetchFn });
    const sent = new URL(fetchFn.mock.calls[0][0]).searchParams;
    expect(sent.get('before')).toBe('0');
    expect(sent.get('after')).toBe(String(SOURCE_MAX_LINES));
  });

  it('asks nothing at all when the record carries no path', async () => {
    // A record with no location is the normal case for a target that never set
    // up metadata, so this must not be a request that can fail.
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(WINDOW));
    for (const path of [null, '', '   ', '\t\n']) {
      expect(await fetchSourceSnippet({ path, line: 3, baseUrl: BASE, fetchFn })).toEqual({ ok: false, reason: 'no-path' });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('forwards an abort signal when one is given', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(WINDOW));
    const controller = new AbortController();
    await fetchSourceSnippet({ path: 'src/Button.tsx', line: 1, baseUrl: BASE, fetchFn, signal: controller.signal });
    expect(fetchFn.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

describe('fetchSourceSnippet response', () => {
  it('parses a well-formed window and derives endLine from the lines it got', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ...WINDOW, endLine: 9999 }));
    const result = await fetchSourceSnippet({ path: 'src/Button.tsx', line: 12, baseUrl: BASE, fetchFn });
    // endLine is recomputed rather than believed: a body that claimed 9999
    // would make the heading say the snippet covers lines it does not contain.
    expect(result).toEqual({ ok: true, snippet: { ...WINDOW, endLine: WINDOW.lines.length + 11 } });
  });

  it('treats a body it cannot read as a failed request, not as an empty snippet', async () => {
    // An empty-but-ok snippet would render as a source panel with no source in
    // it, which reads as "the file is empty" when the truth is "the reply lied".
    const bodies = [
      { startLine: 1, totalLines: 1, lines: ['a'] },
      { path: '', startLine: 1, totalLines: 1, lines: ['a'] },
      { path: 'src/a.ts', startLine: 1, totalLines: 1 },
      { path: 'src/a.ts', startLine: 1, totalLines: 1, lines: 'a' },
      { path: 'src/a.ts', startLine: 1, totalLines: 1, lines: [] },
      { path: 'src/a.ts', startLine: 1, totalLines: 1, lines: [7] },
      { path: 'src/a.ts', startLine: 1, totalLines: 1, lines: ['a', null] },
      null,
    ];
    for (const body of bodies) {
      const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body));
      expect(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn }))
        .toEqual({ ok: false, reason: 'request-failed' });
    }
  });

  it('strips control characters from a line but keeps tabs, Korean, emoji and box-drawing', async () => {
    // Source files are full of the last three; only the control characters that
    // could rewrite a terminal or scroll a rendered block somewhere else go.
    const bell = String.fromCharCode(7);
    const escape = String.fromCharCode(27);
    const line = `const label = '주문하기';${bell}\t// ┌─ ${escape}[2J 😀\r`;
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ path: 'src/a.ts', startLine: 1, totalLines: 1, lines: [line] }));
    const result = await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn });
    expect(snippetOf(result).lines[0]).toBe(`const label = '주문하기';\t// ┌─ [2J 😀`);
  });

  it('caps a returned line at SOURCE_MAX_LINE_CHARS, and leaves one exactly at it alone', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ path: 'src/a.ts', startLine: 1, totalLines: 1, lines: ['x'.repeat(SOURCE_MAX_LINE_CHARS + 200)] }));
    const over = await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn });
    expect(snippetOf(over).lines[0]).toHaveLength(SOURCE_MAX_LINE_CHARS);
    expect(snippetOf(over).lines[0].endsWith('\u2026')).toBe(true);
    const atCap = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ path: 'src/a.ts', startLine: 1, totalLines: 1, lines: ['x'.repeat(SOURCE_MAX_LINE_CHARS)] }));
    const exact = await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn: atCap });
    expect(snippetOf(exact).lines[0]).toBe('x'.repeat(SOURCE_MAX_LINE_CHARS));
  });

  it('keeps at most SOURCE_MAX_LINES lines, and endLine counts only what survived', async () => {
    const lines = Array.from({ length: SOURCE_MAX_LINES + 50 }, (_, index) => `l${index + 1}`);
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ path: 'src/a.ts', startLine: 5, totalLines: 5000, lines }));
    const snippet = snippetOf(await fetchSourceSnippet({ path: 'src/a.ts', line: 5, baseUrl: BASE, fetchFn }));
    expect(snippet.lines).toHaveLength(SOURCE_MAX_LINES);
    expect(snippet.lines[SOURCE_MAX_LINES - 1]).toBe(`l${SOURCE_MAX_LINES}`);
    expect(snippet.endLine).toBe(5 + SOURCE_MAX_LINES - 1);
  });

  it('clamps a hostile body into the documented bounds and leaves no NaN behind', async () => {
    // startLine is bounded because it is what the heading prints; endLine is
    // derived from the lines that survived and is bounded on its own, so a
    // startLine already at the cap cannot push it past the same cap.
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ path: 'src/a.ts', startLine: 99999999, endLine: -1, totalLines: -5, lines: ['a', 'b'] }));
    const result = await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn });
    expect(result).toEqual({
      ok: true,
      snippet: { path: 'src/a.ts', startLine: 1_000_000, endLine: 1_000_000, totalLines: 2, lines: ['a', 'b'] },
    });
  });

  it('falls back to a real number rather than a NaN for every non-numeric field', async () => {
    // A NaN in this object renders as "NaN–NaN of NaN" in a citation, which is
    // worse than a wrong line number: it looks like a bug in the inspector.
    const cases: Array<[unknown, unknown, { startLine: number; endLine: number; totalLines: number }]> = [
      ['twelve', undefined, { startLine: 1, endLine: 2, totalLines: 2 }],
      [2.6, 4.4, { startLine: 3, endLine: 4, totalLines: 4 }],
      [null, null, { startLine: 1, endLine: 2, totalLines: 2 }],
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, { startLine: 1, endLine: 2, totalLines: 2 }],
      [0, 0, { startLine: 1, endLine: 2, totalLines: 2 }],
    ];
    for (const [startLine, totalLines, expected] of cases) {
      const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ path: 'src/a.ts', startLine, totalLines, lines: ['a', 'b'] }));
      const snippet = snippetOf(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn }));
      expect({ startLine: snippet.startLine, endLine: snippet.endLine, totalLines: snippet.totalLines }).toEqual(expected);
      for (const value of [snippet.startLine, snippet.endLine, snippet.totalLines]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(snippet.lines.every((line) => typeof line === 'string')).toBe(true);
    }
  });
});

describe('fetchSourceSnippet failures', () => {
  it('keeps the reason the supervisor refused with, so the UI can say why', async () => {
    const cases: Array<[number, string]> = [
      [404, 'outside-root'],
      [400, 'no-path'],
      [404, 'bad-path'],
      [404, 'bad-extension'],
      [404, 'refused-directory'],
      [404, 'not-a-file'],
      [413, 'too-large'],
      [404, 'unreadable'],
    ];
    for (const [status, error] of cases) {
      const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ error }, status));
      expect(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn }))
        .toEqual({ ok: false, reason: error });
    }
  });

  it('falls back to request-failed for an error string it does not recognise', async () => {
    // Only the eight reader refusals are echoed. An error the supervisor is not
    // supposed to send — including an app-side reason like `supervisor-absent`
    // — is not trusted to become a reason the UI shows the user.
    for (const error of ['teapot', 'supervisor-absent', 'request-failed', '', '  outside-root  ']) {
      const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ error }, 500));
      expect(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn }))
        .toEqual({ ok: false, reason: 'request-failed' });
    }
  });

  it('reads an error response with no usable JSON as a failed request', async () => {
    const html = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }));
    expect(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn: html }))
      .toEqual({ ok: false, reason: 'request-failed' });
    // Valid JSON of the wrong shape is the same: nothing in it is a reason.
    const scalar = vi.fn(async (_url: string, _init?: RequestInit) => new Response('"outside-root"', { status: 404 }));
    expect(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn: scalar }))
      .toEqual({ ok: false, reason: 'request-failed' });
  });

  it('reports supervisor-absent when the request never completes', async () => {
    // No supervisor, wrong port, aborted, offline: one reason, because the app
    // has nothing to offer the user beyond "the inspector is not running".
    const refused = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new TypeError('fetch failed');
    });
    expect(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn: refused }))
      .toEqual({ ok: false, reason: 'supervisor-absent' });
    const aborted = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    });
    expect(await fetchSourceSnippet({ path: 'src/a.ts', line: 1, baseUrl: BASE, fetchFn: aborted }))
      .toEqual({ ok: false, reason: 'supervisor-absent' });
  });
});

describe('sourceLabel', () => {
  it('returns null when there is no path to point at', () => {
    expect(sourceLabel(null, 12)).toBeNull();
    expect(sourceLabel('', 12)).toBeNull();
    expect(sourceLabel('   ', 12)).toBeNull();
  });

  it('trims the path and appends the cited line', () => {
    expect(sourceLabel('  a.tsx  ', 12)).toBe('a.tsx:12');
  });

  it('leaves off a line number that is absent, zero or not a whole line', () => {
    // `a.tsx:0` would be a citation to a line that cannot exist, so the bare
    // path is the honest answer for every unusable line number.
    expect(sourceLabel('a.tsx', null)).toBe('a.tsx');
    expect(sourceLabel('a.tsx', 0)).toBe('a.tsx');
    expect(sourceLabel('a.tsx', -4)).toBe('a.tsx');
    expect(sourceLabel('a.tsx', 2.5)).toBe('a.tsx');
  });
});

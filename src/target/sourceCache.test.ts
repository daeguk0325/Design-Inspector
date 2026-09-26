// The cache that sits in front of the supervisor's source route.
//
// Two consumers want the same window — the details popup and the proposal
// document — and the user can have both open for the same component. So the
// rules below are about not asking twice for one thing, and about remembering
// a refusal exactly as carefully as a success: a target that sets no metadata
// will not grow some mid-session, and a popup that re-renders on every hover
// would otherwise turn one `no-path` into a request loop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchSourceOptions, SourceResult, SourceSnippet } from './source.ts';

type FetchSource = (options: FetchSourceOptions) => Promise<SourceResult>;

// Hoisted with the module mock, because the factory below runs while
// `./source.ts` is being imported and cannot close over a later binding.
const wire = vi.hoisted(() => ({ fetch: vi.fn<FetchSource>() }));
vi.mock('./source.ts', () => ({ fetchSourceSnippet: wire.fetch }));

const { clearSourceCache, sourceSnippet, sourceSnippets } = await import('./sourceCache.ts');

function snippet(path: string, startLine: number, lines: string[]): SourceSnippet {
  return {
    path,
    startLine,
    endLine: startLine + lines.length - 1,
    totalLines: lines.length,
    lines,
  };
}

function read(path: string, startLine: number, lines: string[]): SourceResult {
  return { ok: true, snippet: snippet(path, startLine, lines) };
}

const REFUSED: SourceResult = { ok: false, reason: 'outside-root' };

beforeEach(() => {
  wire.fetch.mockReset();
  wire.fetch.mockResolvedValue(read('src/Button.tsx', 10, ['<Button />']));
});

afterEach(() => {
  // The cache is module state that outlives a test: without this, one test's
  // window would answer the next test's question and the fetch counts below
  // would mean nothing.
  clearSourceCache();
  vi.useRealTimers();
});

describe('source cache window reuse', () => {
  it('asks the route once for a window it has already read', async () => {
    const first = await sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    const second = await sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('shares one in-flight request between callers that overlap', async () => {
    // The panel and the popup can both ask in the same tick. Two callers must
    // end up holding the same request, not two requests for one file.
    const first = sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    const second = sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    expect(first).toBe(second);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps two windows of the same file apart', async () => {
    wire.fetch.mockImplementation(async (options): Promise<SourceResult> =>
      read(String(options.path), options.line ?? 0, [`// ${String(options.path)}:${String(options.line)}`]),
    );
    const first = await sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    const second = await sourceSnippet({ path: 'src/Button.tsx', line: 40 });
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    expect(first.ok && first.snippet.startLine).toBe(10);
    expect(second.ok && second.snippet.startLine).toBe(40);
  });

  it('sends the route exactly what was asked for', async () => {
    await sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    expect(wire.fetch).toHaveBeenCalledWith({ path: 'src/Button.tsx', line: 10 });
    // A base rides along only when a caller named one, so a cache hit made by
    // one consumer can never be answered with another consumer's base.
    await sourceSnippet({ path: 'src/Card.tsx', line: 4, baseUrl: 'http://127.0.0.1:6100' });
    expect(wire.fetch).toHaveBeenLastCalledWith({
      path: 'src/Card.tsx',
      line: 4,
      baseUrl: 'http://127.0.0.1:6100',
    });
  });
});

describe('source cache refusals', () => {
  it('remembers a refusal so a re-render does not re-ask', async () => {
    wire.fetch.mockResolvedValue(REFUSED);
    expect(await sourceSnippet({ path: 'src/Button.tsx', line: 10 })).toEqual(REFUSED);
    expect(await sourceSnippet({ path: 'src/Button.tsx', line: 10 })).toEqual(REFUSED);
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });

  it('answers a record with no path without asking the route at all', async () => {
    // A record with no location is the normal case for a target that never set
    // up metadata, so it is answered rather than requested.
    expect(await sourceSnippet({ path: null, line: 10 })).toEqual({ ok: false, reason: 'no-path' });
    expect(await sourceSnippet({ path: '   ', line: 10 })).toEqual({ ok: false, reason: 'no-path' });
    expect(wire.fetch).not.toHaveBeenCalled();
  });
});

describe('source cache bound', () => {
  it('keeps only the last dozen windows and re-reads the one it dropped', async () => {
    for (let line = 1; line <= 13; line += 1) {
      wire.fetch.mockResolvedValueOnce(read('src/Big.tsx', line, [`line ${line}`]));
      await sourceSnippet({ path: 'src/Big.tsx', line });
    }
    expect(wire.fetch).toHaveBeenCalledTimes(13);
    // The entry read first is the one that fell out of the bound.
    await sourceSnippet({ path: 'src/Big.tsx', line: 1 });
    expect(wire.fetch).toHaveBeenCalledTimes(14);
    // The newest is still remembered, which is what the bound is for.
    await sourceSnippet({ path: 'src/Big.tsx', line: 13 });
    expect(wire.fetch).toHaveBeenCalledTimes(14);
  });

  it('re-reads a window after the cache is cleared', async () => {
    // This is how a Revert drops what it knows about a session that is gone:
    // the next look at the same file has to be a fresh read.
    await sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    clearSourceCache();
    await sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    expect(wire.fetch).toHaveBeenCalledTimes(2);
  });

  it('lets a new read take the place of a window still in flight', async () => {
    // Clearing has to drop the pending request too, or a caller that arrives
    // after the clear would be handed the session that was just abandoned.
    const gate: { release: () => void } = { release: () => {} };
    wire.fetch.mockImplementationOnce(
      () => new Promise<SourceResult>((resolve) => { gate.release = () => resolve(REFUSED); }),
    );
    const pending = sourceSnippet({ path: 'src/Button.tsx', line: 10 });
    clearSourceCache();
    wire.fetch.mockResolvedValue(read('src/Button.tsx', 10, ['fresh']));
    expect(await sourceSnippet({ path: 'src/Button.tsx', line: 10 })).toEqual(
      read('src/Button.tsx', 10, ['fresh']),
    );
    gate.release();
    expect(await pending).toEqual(REFUSED);
  });
});

describe('source cache batch', () => {
  it('returns the windows it could read, keyed by path and line', async () => {
    wire.fetch.mockImplementation(async (options): Promise<SourceResult> =>
      options.path === 'src/Button.tsx'
        ? read('src/Button.tsx', options.line ?? 0, ['<Button />'])
        : { ok: false, reason: 'unreadable' },
    );
    const found = await sourceSnippets([
      { path: 'src/Button.tsx', line: 10 },
      { path: 'src/Icon.tsx', line: 3 },
    ]);
    // A refusal is not an entry: the document attaches a snippet only where it
    // has one, so a half-filled map would be a source section with a hole.
    expect([...found.keys()]).toEqual(['src/Button.tsx:10']);
    expect(found.get('src/Button.tsx:10')?.lines).toEqual(['<Button />']);
    expect(wire.fetch).toHaveBeenCalledTimes(2);
  });

  it('skips a record with no path rather than asking for it', async () => {
    const found = await sourceSnippets([
      { path: 'src/Button.tsx', line: 10 },
      { path: null, line: 12 },
      { path: '', line: 12 },
    ]);
    expect([...found.keys()]).toEqual(['src/Button.tsx:10']);
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });

  it('asks once for a window two entries share', async () => {
    // Two components cited from the same line is one window, not two.
    await sourceSnippets([
      { path: 'src/Button.tsx', line: 10 },
      { path: 'src/Button.tsx', line: 10 },
    ]);
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map when nothing carries a path', async () => {
    expect([...(await sourceSnippets([]))]).toEqual([]);
    expect([...(await sourceSnippets([{ path: null, line: 1 }]))]).toEqual([]);
    expect(wire.fetch).not.toHaveBeenCalled();
  });
});

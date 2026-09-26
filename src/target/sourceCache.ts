// A tiny cache in front of the source route.
//
// Two consumers want the same window — the details popup and the proposal
// document — and the user can open both for the same component. The cache is
// keyed by what was asked for, holds a handful of entries, and never expires: a
// source file does not change under a running inspector session in any way that
// matters here, and a target that has no metadata will not grow one mid-session.
// `clearSourceCache` is the seam for a caller that knows better.

import { fetchSourceSnippet, type SourceResult, type SourceSnippet } from './source.ts';

const MAX_ENTRIES = 12;

const cache = new Map<string, SourceResult>();
const inFlight = new Map<string, Promise<SourceResult>>();

function keyOf(path: string | null, line: number | null): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null;
  return `${path.trim()}:${typeof line === 'number' ? line : 0}`;
}

function remember(key: string, value: SourceResult): SourceResult {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

/**
 * A failure is remembered too, for the same reason a success is: retrying a
 * `no-path` on every render of a popup is a loop, and a target that has no
 * metadata will not grow one mid-session.
 */
export function sourceSnippet(
  options: { path: string | null; line: number | null; baseUrl?: string },
): Promise<SourceResult> {
  const key = keyOf(options.path, options.line);
  if (key === null) return Promise.resolve({ ok: false, reason: 'no-path' as const });
  const cached = cache.get(key);
  if (cached !== undefined) {
    // Re-insert so this is genuinely LRU: a window the user keeps opening
    // should outlive one they read once.
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached);
  }
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const request = fetchSourceSnippet({
    path: options.path,
    line: options.line,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  })
    .then((result) => remember(key, result))
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Test seam, and the way a Revert drops what it knows about a dead session. */
export function clearSourceCache(): void {
  cache.clear();
  inFlight.clear();
}

export function sourceSnippets(
  targets: ReadonlyArray<{ path: string | null; line: number | null }>,
  baseUrl?: string,
): Promise<Map<string, SourceSnippet>> {
  const wanted = new Map<string, { path: string; line: number | null }>();
  for (const target of targets) {
    const key = keyOf(target.path, target.line);
    if (key === null) continue;
    wanted.set(key, { path: target.path as string, line: target.line });
  }
  const keys = [...wanted.keys()];
  if (keys.length === 0) return Promise.resolve(new Map());
  return Promise.all(
    keys.map((key) => {
      const target = wanted.get(key);
      return target === undefined
        ? Promise.resolve<SourceResult>({ ok: false, reason: 'no-path' })
        : sourceSnippet({ path: target.path, line: target.line, ...(baseUrl === undefined ? {} : { baseUrl }) });
    }),
  ).then((results) => {
    const out = new Map<string, SourceSnippet>();
    results.forEach((result, index) => {
      const key = keys[index];
      if (key !== undefined && result.ok) out.set(key, result.snippet);
    });
    return out;
  });
}

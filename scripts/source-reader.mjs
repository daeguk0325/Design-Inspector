// Reading a line window out of a target project file.
//
// This is the project's first path-joining code, so it establishes the
// convention rather than reusing one. The path arrives from the target page
// (`data-inspector-file`), which means it is untrusted input, and the file it
// names lives outside this repository. The rules, in order:
//
//   1. The path must be relative, forward-slashed, free of `..`, and free of a
//      drive letter, UNC prefix or leading slash.
//   2. The extension must be on a short allowlist of source files. This is not a
//      security boundary on its own — a `.ts` can hold anything — it keeps the
//      route from becoming a general file reader.
//   3. `node_modules` and `.git` are refused at any depth, so the route cannot
//      read vendored code or a key that happens to sit inside the project.
//   4. The resolved path must still be inside the project root *after* symlinks
//      are resolved. That is the check that actually matters: a link inside the
//      project is the obvious way to walk out of it.
//   5. The file must be a regular file within a size cap, and only the requested
//      window is returned, always including the cited line.
//
// Nothing here throws and nothing here invents: an unreadable file yields a
// reason the app can act on, and a record with no `file` never gets this far.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_SOURCE_PATH_CHARS = 400;
export const MAX_SOURCE_FILE_BYTES = 512 * 1024;
export const MAX_WINDOW_LINES = 400;
export const MAX_LINE_CHARS = 500;
export const MAX_TOTAL_LINES = 1_000_000;

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro', '.css', '.scss', '.sass', '.less',
  '.html', '.json', '.md',
]);

const REFUSED_SEGMENTS = new Set(['node_modules', '.git']);

/**
 * @typedef {'no-path' | 'bad-path' | 'bad-extension' | 'refused-directory'
 *   | 'outside-root' | 'not-a-file' | 'too-large' | 'unreadable'} SourceRefusal
 * @typedef {{ path: string, startLine: number, endLine: number,
 *   totalLines: number, lines: string[] }} SourceWindow
 * @typedef {{ ok: true, window: SourceWindow }
 *   | { ok: false, reason: SourceRefusal }} SourceReadResult
 */

/** @param {string} path @returns {string} */
function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

/** True when `child` is `root` itself or sits under it. */
export function isInsideRoot(root, child) {
  const relativePath = relative(root, child);
  if (relativePath === '') return true;
  return !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath);
}

/**
 * @param {unknown} candidate
 * @returns {{ path: string } | { reason: SourceRefusal }}
 */
function checkPath(candidate) {
  if (typeof candidate !== 'string') return { reason: 'no-path' };
  const path = candidate.trim();
  if (path.length === 0) return { reason: 'no-path' };
  if (path.length > MAX_SOURCE_PATH_CHARS) return { reason: 'bad-path' };
  // Control characters, including the NUL that truncates a path in C.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return { reason: 'bad-path' };
  if (path.includes('\\')) return { reason: 'bad-path' };
  if (path.startsWith('/')) return { reason: 'bad-path' };
  if (/^[a-zA-Z]:/.test(path)) return { reason: 'bad-path' };
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return { reason: 'bad-path' };
  // Checked at every depth, not just the first segment: a monorepo puts
  // node_modules under every package, and `packages/app/node_modules/...`
  // would otherwise slip past a `segments[0]` test. Before the dotfile rule, so
  // a vendored path reports the reason that says so rather than "bad path".
  if (segments.some((segment) => REFUSED_SEGMENTS.has(segment))) return { reason: 'refused-directory' };
  if (segments.some((segment) => segment.startsWith('.'))) return { reason: 'bad-path' };
  return { path };
}

function clampWindow(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @param {{ root: unknown, path: unknown, line?: unknown, before?: unknown,
 *   after?: unknown }} options
 * @returns {SourceReadResult}
 */
export function readSourceWindow(options) {
  const root = typeof options.root === 'string' ? options.root : '';
  if (root.length === 0) return { ok: false, reason: 'outside-root' };
  const checked = checkPath(options.path);
  if ('reason' in checked) return { ok: false, reason: checked.reason };
  const path = checked.path;
  if (!SOURCE_EXTENSIONS.has(extensionOf(path))) return { ok: false, reason: 'bad-extension' };

  const absoluteRoot = resolve(root);
  const absolute = resolve(join(absoluteRoot, path));
  if (!isInsideRoot(absoluteRoot, absolute)) return { ok: false, reason: 'outside-root' };

  let contents;
  try {
    // realpath first: containment has to hold after links are followed, or a
    // link inside the project walks straight out of it.
    const realRoot = realpathSync(absoluteRoot);
    const real = realpathSync(absolute);
    if (!isInsideRoot(resolve(realRoot), real)) return { ok: false, reason: 'outside-root' };
    const stats = statSync(real);
    if (!stats.isFile()) return { ok: false, reason: 'not-a-file' };
    if (stats.size > MAX_SOURCE_FILE_BYTES) return { ok: false, reason: 'too-large' };
    contents = readFileSync(real, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const all = contents.split(/\r?\n/);
  // A trailing newline yields one empty final element that is not a line.
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const totalLines = Math.min(all.length, MAX_TOTAL_LINES);
  if (totalLines === 0) return { ok: false, reason: 'unreadable' };

  const requested = Number.isSafeInteger(options.line) ? Number(options.line) : 0;
  const anchor = requested >= 1 && requested <= totalLines ? requested : totalLines;
  const before = clampWindow(options.before, 0, MAX_WINDOW_LINES);
  const after = clampWindow(options.after, 0, MAX_WINDOW_LINES);
  let startIndex = Math.max(0, anchor - 1 - before);
  let endIndex = Math.min(totalLines, anchor + after);
  if (endIndex - startIndex > MAX_WINDOW_LINES) {
    // Too much context asked for: recentre on the cited line rather than keeping
    // the start of the slice. A window that does not contain the line it was
    // asked for is worse than a shorter one, because the heading would lie.
    startIndex = Math.max(0, Math.min(anchor - 1 - Math.floor(MAX_WINDOW_LINES / 2), totalLines - MAX_WINDOW_LINES));
    endIndex = Math.min(totalLines, startIndex + MAX_WINDOW_LINES);
  }
  const lines = all.slice(startIndex, endIndex).map((line) =>
    line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line,
  );
  if (lines.length === 0) return { ok: false, reason: 'unreadable' };

  return {
    ok: true,
    window: {
      path,
      startLine: startIndex + 1,
      endLine: startIndex + lines.length,
      totalLines,
      lines,
    },
  };
}

/**
 * The supervisor route, as a pure function of its inputs, so the origin gate and
 * the status codes can be tested without booting the server.
 *
 * @param {{ authorized: boolean, origin: string, root: string,
 *   path: string | null, line: number, before: number, after: number }} request
 * @returns {{ status: number, body: unknown, origin: string | null }}
 */
export function handleSourceRequest(request) {
  if (!request.authorized) {
    return { status: 403, body: { error: 'Origin is not the active Inspector app.' }, origin: null };
  }
  const result = readSourceWindow({
    root: request.root,
    path: request.path,
    line: request.line,
    before: request.before,
    after: request.after,
  });
  const origin = request.origin || null;
  if (!result.ok) {
    // A missing path is a malformed request; every other refusal means the file
    // is not there to be read, which is a 404 to the caller either way.
    return { status: result.reason === 'no-path' ? 400 : 404, body: { error: result.reason }, origin };
  }
  return { status: 200, body: result.window, origin };
}

// Reading a line window out of a target project file.
//
// `readSourceWindow` is the project's first path-joining code and the only one
// that reads a file outside this repository, so the containment cases carry
// more weight here than the happy path: a fixture on real disk is the only way
// to exercise `realpath` and `stat` behaviour, and every fixture file a
// traversal could reach is given a marker string so a regression shows up as a
// leaked marker rather than as a differently-shaped error.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  MAX_LINE_CHARS,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_PATH_CHARS,
  MAX_WINDOW_LINES,
  handleSourceRequest,
  isInsideRoot,
  readSourceWindow,
} from './source-reader.mjs';

const MARKER = 'TOPSECRET-OUTSIDE-THE-ROOT';
const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

let root;
let outside;
let escapeName;
let escapeFile;

beforeEach(() => {
  // realpath on the fixtures too: on macOS the temp dir is itself a symlink,
  // and the reader resolves the root, so a fixture left unresolved would test
  // a path shape this project never sees in production.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'insp-src-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'insp-outside-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), `${LINES.join('\n')}\n`);
  // A real, readable `.ts` file one level above the root, so `..` is refused on
  // its shape and not because the file happens to be missing.
  escapeName = `outside-${basename(root)}.ts`;
  escapeFile = join(dirname(root), escapeName);
  writeFileSync(escapeFile, `export const secret = '${MARKER}';\n`);
  writeFileSync(join(outside, 'secret.ts'), `export const secret = '${MARKER}';\n`);
});

afterEach(() => {
  rmSync(escapeFile, { force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('readSourceWindow window arithmetic', () => {
  it('returns the cited line plus the requested context, numbered from one', () => {
    expect(readSourceWindow({ root, path: 'src/app.ts', line: 10, before: 2, after: 3 })).toEqual({
      ok: true,
      window: {
        path: 'src/app.ts',
        startLine: 8,
        endLine: 13,
        totalLines: 20,
        lines: ['line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 13'],
      },
    });
  });

  it('stops at the end of the file when the cited line is past the last one', () => {
    // A citation past EOF is a stale build, not a reason to answer nothing:
    // the last line of the file is what the user needs to see.
    expect(readSourceWindow({ root, path: 'src/app.ts', line: 999, before: 2, after: 3 })).toEqual({
      ok: true,
      window: {
        path: 'src/app.ts',
        startLine: 18,
        endLine: 20,
        totalLines: 20,
        lines: ['line 18', 'line 19', 'line 20'],
      },
    });
  });

  it('anchors to the last line when there is no usable line number at all', () => {
    for (const line of [0, -3, undefined, Number.NaN, 'ten', null]) {
      expect(readSourceWindow({ root, path: 'src/app.ts', line, before: 0, after: 0 })).toEqual({
        ok: true,
        window: { path: 'src/app.ts', startLine: 20, endLine: 20, totalLines: 20, lines: ['line 20'] },
      });
    }
  });

  it('returns the cited line alone when the context is zero or negative', () => {
    const exact = readSourceWindow({ root, path: 'src/app.ts', line: 5, before: 0, after: 0 });
    expect(exact.ok && exact.window.lines).toEqual(['line 5']);
    const negative = readSourceWindow({ root, path: 'src/app.ts', line: 5, before: -4, after: -4 });
    expect(negative.ok && negative.window.lines).toEqual(['line 5']);
  });

  it('rounds a fractional context to whole lines', () => {
    // The request comes from a stepper in the UI, so a half-line window would
    // show a line number the file does not have.
    const result = readSourceWindow({ root, path: 'src/app.ts', line: 5, before: 1.4, after: 0.6 });
    expect(result.ok && result.window.lines).toEqual(['line 4', 'line 5', 'line 6']);
  });

  it('drops only the phantom line a trailing newline leaves behind', () => {
    writeFileSync(join(root, 'src', 'nl.ts'), 'a\nb\n');
    const trailing = readSourceWindow({ root, path: 'src/nl.ts', line: 1, before: 0, after: 9 });
    expect(trailing.ok && trailing.window).toMatchObject({ startLine: 1, endLine: 2, totalLines: 2, lines: ['a', 'b'] });
    // A deliberately blank final line is a real line and is counted as one.
    writeFileSync(join(root, 'src', 'blank.ts'), 'a\nb\n\n');
    const blank = readSourceWindow({ root, path: 'src/blank.ts', line: 1, before: 0, after: 9 });
    expect(blank.ok && blank.window).toMatchObject({ totalLines: 3, lines: ['a', 'b', ''] });
  });

  it('reads a CRLF file without leaving a carriage return on the end of a line', () => {
    writeFileSync(join(root, 'src', 'crlf.ts'), 'one\r\ntwo\r\nthree\r\n');
    expect(readSourceWindow({ root, path: 'src/crlf.ts', line: 2, before: 1, after: 1 })).toEqual({
      ok: true,
      window: { path: 'src/crlf.ts', startLine: 1, endLine: 3, totalLines: 3, lines: ['one', 'two', 'three'] },
    });
  });

  it('truncates a line over the per-line cap, and leaves one exactly at the cap alone', () => {
    writeFileSync(join(root, 'src', 'long.ts'), `x\n${'a'.repeat(MAX_LINE_CHARS + 50)}\ny\n`);
    const over = readSourceWindow({ root, path: 'src/long.ts', line: 2, before: 0, after: 0 });
    expect(over.ok && over.window.lines[0]).toHaveLength(MAX_LINE_CHARS);
    expect(over.ok && over.window.lines[0].endsWith('\u2026')).toBe(true);
    writeFileSync(join(root, 'src', 'exact.ts'), 'b'.repeat(MAX_LINE_CHARS));
    const atCap = readSourceWindow({ root, path: 'src/exact.ts', line: 1, before: 0, after: 0 });
    expect(atCap.ok && atCap.window.lines[0]).toBe('b'.repeat(MAX_LINE_CHARS));
  });

  it('caps the window at MAX_WINDOW_LINES however much context is asked for', () => {
    // The cap keeps the cited line, not the start of the slice: a window that
    // does not contain the line it was asked for would make the heading lie.
    const many = Array.from({ length: 1000 }, (_, index) => `l${index + 1}`);
    writeFileSync(join(root, 'src', 'big.ts'), `${many.join('\n')}\n`);
    const result = readSourceWindow({ root, path: 'src/big.ts', line: 500, before: 9999, after: 9999 });
    expect(result.ok && result.window.lines).toHaveLength(MAX_WINDOW_LINES);
    expect(result.ok && result.window.totalLines).toBe(1000);
    if (result.ok) {
      expect(result.window.lines).toContain('l500');
      expect(result.window.startLine).toBeLessThanOrEqual(500);
      expect(result.window.endLine).toBeGreaterThanOrEqual(500);
    }
  });

  it('reports a file with no lines as unreadable rather than as an empty snippet', () => {
    writeFileSync(join(root, 'src', 'empty.ts'), '');
    expect(readSourceWindow({ root, path: 'src/empty.ts', line: 1 })).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('readSourceWindow containment', () => {
  it('refuses a leading or an embedded `..` as bad-path, even though the file is there', () => {
    // The load-bearing case for the shape check: `escapeFile` really exists,
    // really has an allowlisted extension and really holds the marker, so the
    // only thing standing between the caller and a file outside the project is
    // the `..` refusal.
    expect(readFileSync(escapeFile, 'utf8')).toContain(MARKER);
    for (const path of [`../${escapeName}`, `src/../../${escapeName}`, `src/app.ts/../../../${escapeName}`]) {
      const result = readSourceWindow({ root, path });
      expect(result).toEqual({ ok: false, reason: 'bad-path' });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
  });

  it('refuses an absolute, UNC, drive-letter or backslash path as bad-path', () => {
    for (const path of ['/etc/hosts', '//server/share/app.ts', 'C:/x.ts', 'C:\\x.ts', 'src\\app.ts', 'src//app.ts', 'src/app.ts/']) {
      expect(readSourceWindow({ root, path })).toEqual({ ok: false, reason: 'bad-path' });
    }
  });

  it('refuses a dotfile segment anywhere, and a `.`-only path, as bad-path', () => {
    // `.env` and `src/.secret.ts` are the reason for this rule: both hold
    // secrets and both sit inside the project root, so containment alone would
    // allow them. `.git/config` is refused too, but by the vendored-segment rule,
    // which runs first so the caller is told *why* rather than "bad path".
    for (const path of ['.env', 'src/.secret.ts', '.']) {
      expect(readSourceWindow({ root, path })).toEqual({ ok: false, reason: 'bad-path' });
    }
    for (const path of ['.git/config', 'src/.git/config']) {
      expect(readSourceWindow({ root, path })).toEqual({ ok: false, reason: 'refused-directory' });
    }
  });

  it('refuses a vendored or VCS path as refused-directory, at any depth', () => {
    // Checked on every segment, not just the first: a monorepo puts
    // node_modules under each package, and `segments[0]` alone would let
    // `packages/app/node_modules/...` through.
    for (const path of [
      'node_modules/pkg/index.js',
      'node_modules/.bin/run.js',
      'node_modules/pkg/data.json',
      '.git/HEAD',
      'packages/app/node_modules/lib/index.js',
      'src/.git/config',
    ]) {
      expect(readSourceWindow({ root, path })).toEqual({ ok: false, reason: 'refused-directory' });
    }
  });

  it('refuses a NUL or any other control character in the path as bad-path', () => {
    // NUL truncates a path in C, so a check that ran after the syscall would
    // already be too late; a BEL is the same rule stated for the whole range.
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const escape = String.fromCharCode(27);
    for (const path of [`src/app${nul}.ts`, `src${bell}/app.ts`, `src/app${escape}.ts`]) {
      expect(readSourceWindow({ root, path })).toEqual({ ok: false, reason: 'bad-path' });
    }
  });

  it('refuses a path over the length cap as bad-path, and accepts one exactly at it', () => {
    const over = `${'a'.repeat(MAX_SOURCE_PATH_CHARS)}.ts`;
    expect(readSourceWindow({ root, path: over })).toEqual({ ok: false, reason: 'bad-path' });
    // Exactly at the cap the path is well formed, so it fails later for being
    // absent: that is the proof the cap is `> MAX_SOURCE_PATH_CHARS` and not `>=`.
    const atCap = `${'a'.repeat(MAX_SOURCE_PATH_CHARS - 3)}.ts`;
    expect(atCap).toHaveLength(MAX_SOURCE_PATH_CHARS);
    expect(readSourceWindow({ root, path: atCap })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('says no-path, not bad-path, when there is no path to judge', () => {
    // The distinction is honesty about why nothing happened: a record with no
    // `file` is the normal case for a target that never set up metadata.
    for (const path of [null, undefined, 42, {}, [], '', '   ', '\t\n']) {
      expect(readSourceWindow({ root, path, line: 3 })).toEqual({ ok: false, reason: 'no-path' });
    }
  });

  it('refuses an extension that is not source, and a path with no extension', () => {
    for (const path of ['logo.png', 'setup.exe', 'src/archive.zip', 'README', 'src/LICENSE', 'src/app.ts.map']) {
      expect(readSourceWindow({ root, path })).toEqual({ ok: false, reason: 'bad-extension' });
    }
  });

  it('refuses a directory as not-a-file and a missing file as unreadable', () => {
    mkdirSync(join(root, 'bundle.ts'));
    expect(readSourceWindow({ root, path: 'bundle.ts' })).toEqual({ ok: false, reason: 'not-a-file' });
    expect(readSourceWindow({ root, path: 'src/missing.ts' })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a file over the size cap as too-large, and reads one exactly at the cap', () => {
    writeFileSync(join(root, 'src', 'huge.ts'), 'x'.repeat(MAX_SOURCE_FILE_BYTES + 1024));
    expect(readSourceWindow({ root, path: 'src/huge.ts', line: 1 })).toEqual({ ok: false, reason: 'too-large' });
    // The cap is on bytes read, so exactly-at-cap is read and then truncated
    // per line like any other over-long line.
    writeFileSync(join(root, 'src', 'atcap.ts'), 'x'.repeat(MAX_SOURCE_FILE_BYTES));
    const atCap = readSourceWindow({ root, path: 'src/atcap.ts', line: 1 });
    expect(atCap.ok && atCap.window.lines[0]).toHaveLength(MAX_LINE_CHARS);
  });

  it('refuses an empty or non-string root as outside-root, because there is no tree to be inside', () => {
    for (const badRoot of ['', null, undefined, 42, {}, []]) {
      expect(readSourceWindow({ root: badRoot, path: 'src/app.ts', line: 1 })).toEqual({ ok: false, reason: 'outside-root' });
    }
  });

  it('refuses a directory link inside the root that reaches a file outside it, and reads one that stays inside', (ctx) => {
    // A directory link is the practical form of this escape on Windows: a
    // shared package or a worktree linked into the project, with a real
    // `.ts` file on the far side. It takes the same post-`realpath` path as a
    // file symlink, and unlike one it needs no Developer Mode, so this is the
    // version of the check that runs on most hosts.
    try {
      symlinkSync(outside, join(root, 'linked-out'), 'junction');
      symlinkSync(join(root, 'src'), join(root, 'linked-in'), 'junction');
    } catch (error) {
      ctx.skip(`directory link creation is unavailable on this host: ${error.code ?? error.message}`);
      return;
    }
    const escaped = readSourceWindow({ root, path: 'linked-out/secret.ts', line: 1 });
    expect(escaped).toEqual({ ok: false, reason: 'outside-root' });
    expect(JSON.stringify(escaped)).not.toContain(MARKER);
    const allowed = readSourceWindow({ root, path: 'linked-in/app.ts', line: 1, before: 0, after: 0 });
    expect(allowed).toEqual({
      ok: true,
      window: { path: 'linked-in/app.ts', startLine: 1, endLine: 1, totalLines: 20, lines: ['line 1'] },
    });
  });

  it('refuses a symlink inside the root that points at a file outside it', (ctx) => {
    // This is the check the whole module exists for. Every other refusal is a
    // syntactic rule on the requested string; a symlink passes all of them and
    // still reads outside the project, so containment is re-checked after
    // `realpath` and the marker proves nothing came back.
    const link = join(root, 'link.ts');
    try {
      symlinkSync(join(outside, 'secret.ts'), link, 'file');
    } catch (error) {
      // Windows without Developer Mode or admin refuses symlink creation; the
      // lexical cases above still hold, but this one cannot run here.
      ctx.skip(`symlink creation is unavailable on this host: ${error.code ?? error.message}`);
      return;
    }
    const result = readSourceWindow({ root, path: 'link.ts', line: 1 });
    expect(result).toEqual({ ok: false, reason: 'outside-root' });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('reads a symlink that stays inside the root, so the rule is containment and not "no symlinks"', (ctx) => {
    // Without this, refusing every link would pass the previous test while
    // breaking the ordinary case of a monorepo or a linked shared component.
    const link = join(root, 'alias.ts');
    try {
      symlinkSync(join(root, 'src', 'app.ts'), link, 'file');
    } catch (error) {
      ctx.skip(`symlink creation is unavailable on this host: ${error.code ?? error.message}`);
      return;
    }
    const result = readSourceWindow({ root, path: 'alias.ts', line: 1, before: 0, after: 0 });
    expect(result).toEqual({
      ok: true,
      window: { path: 'alias.ts', startLine: 1, endLine: 1, totalLines: 20, lines: ['line 1'] },
    });
  });

  it('echoes the requested path as given, so the caller can key its cache on it', () => {
    const result = readSourceWindow({ root, path: '  src/app.ts  ', line: 1, before: 0, after: 0 });
    expect(result.ok && result.window.path).toBe('src/app.ts');
  });
});

describe('isInsideRoot', () => {
  const root = join(tmpdir(), 'proj');

  it('counts the root itself as inside', () => {
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it('counts a direct child and a deeply nested child as inside', () => {
    expect(isInsideRoot(root, join(root, 'a.ts'))).toBe(true);
    expect(isInsideRoot(root, join(root, 'src', 'deep', 'a.ts'))).toBe(true);
  });

  it('refuses a sibling that merely shares a name prefix', () => {
    // The whole reason containment is computed with `relative` rather than
    // `startsWith`: a prefix test calls `/tmp/proj2` a child of `/tmp/proj`.
    expect(isInsideRoot(root, join(tmpdir(), 'project', 'a.ts'))).toBe(false);
    expect(isInsideRoot(root, join(tmpdir(), 'proj-2', 'a.ts'))).toBe(false);
  });

  it('refuses the parent directory', () => {
    expect(isInsideRoot(join(root, 'src'), root)).toBe(false);
  });
});

describe('handleSourceRequest', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'insp-source-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'one\ntwo\nthree\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ask = (overrides) =>
    handleSourceRequest({
      authorized: true,
      origin: 'http://127.0.0.1:5173',
      root,
      path: 'src/a.ts',
      line: 2,
      before: 1,
      after: 1,
      ...overrides,
    });

  it('answers 200 with the window and mirrors the caller origin for CORS', () => {
    const answer = ask();
    expect(answer.status).toBe(200);
    expect(answer.origin).toBe('http://127.0.0.1:5173');
    expect(answer.body).toMatchObject({ path: 'src/a.ts', startLine: 1, endLine: 3, lines: ['one', 'two', 'three'] });
  });

  it('refuses an unauthorized origin with 403 and no CORS header', () => {
    // The origin gate is the only thing between a page in the user's browser and
    // the project directory, so a refusal must not be readable by whoever sent it.
    const answer = ask({ authorized: false });
    expect(answer.status).toBe(403);
    expect(answer.origin).toBeNull();
    expect(answer.body).toEqual({ error: 'Origin is not the active Inspector app.' });
  });

  it('answers 400 for a missing path and 404 for a file that is not there', () => {
    // The distinction is deliberate: a blank path is a malformed request, while
    // a path that resolves to nothing is a 404 whichever way it was refused.
    expect(ask({ path: null })).toMatchObject({ status: 400, body: { error: 'no-path' } });
    expect(ask({ path: 'src/missing.ts' })).toMatchObject({ status: 404 });
    expect(ask({ path: '../escape.ts' })).toMatchObject({ status: 404, body: { error: 'bad-path' } });
  });

  it('answers 404 when no project folder is chosen yet', () => {
    // The supervisor runs before a target is picked; `dir` is then absent, and
    // the app has to be able to tell that apart from a crash.
    expect(ask({ root: '' })).toMatchObject({ status: 404, body: { error: 'outside-root' } });
  });

  it('sends no CORS header when the request carried no origin', () => {
    expect(ask({ origin: '' }).origin).toBeNull();
  });
});
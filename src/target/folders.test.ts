import { describe, expect, it, vi } from 'vitest';
import {
  analyzeEntries,
  probeDevServers,
  recallFolder,
  rememberFolder,
  scanFallbackFiles,
} from './folders.ts';

describe('analyzeEntries', () => {
  it('detects a Vite project with a dev script', () => {
    const facts = analyzeEntries(
      'vera-board',
      ['package.json', 'index.html', 'vite.config.ts', 'src/main.tsx'],
      JSON.stringify({ name: 'vera', scripts: { dev: 'vite' } }),
    );
    expect(facts).toMatchObject({
      folderName: 'vera-board',
      packageJsonName: 'vera',
      hasIndexHtml: true,
      hasViteConfig: true,
      devScript: 'dev',
    });
  });

  it('falls back to the start script and tolerates malformed package.json', () => {
    const start = analyzeEntries('x', ['package.json'], JSON.stringify({ scripts: { start: 'serve' } }));
    expect(start.devScript).toBe('start');
    const broken = analyzeEntries('x', ['package.json'], '{not json');
    expect(broken.packageJsonName).toBeNull();
    expect(broken.devScript).toBeNull();
  });

  it('detects build output and empty folders', () => {
    expect(analyzeEntries('d', ['dist/index.html'], null).hasDistIndex).toBe(true);
    expect(analyzeEntries('b', ['build/index.html'], null).hasDistIndex).toBe(true);
    const empty = analyzeEntries('empty', [], null);
    expect(empty).toMatchObject({ hasIndexHtml: false, hasDistIndex: false, hasViteConfig: false });
  });
});

describe('scanFallbackFiles', () => {
  it('reads package.json from a webkitdirectory file list', async () => {
    const facts = await scanFallbackFiles('vera', [
      { path: 'vera/package.json', readText: async () => JSON.stringify({ name: 'vera' }) },
      { path: 'vera/index.html', readText: async () => '' },
    ]);
    // The "<selected-folder>/" prefix is stripped so markers match.
    expect(facts.folderName).toBe('vera');
    expect(facts.packageJsonName).toBe('vera');
    expect(facts.hasIndexHtml).toBe(true);
  });
});

describe('probeDevServers', () => {
  const ok = () => Promise.resolve(new Response(null, { status: 200 }));
  const dead = () => Promise.reject(new TypeError('refused'));

  it('returns the first listening port in preference order', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === 'http://localhost:8080/') return ok();
      return dead();
    });
    const hit = await probeDevServers([3000, 8080, 9000], null, fetchFn, 500);
    expect(hit).toEqual({ url: 'http://localhost:8080', port: 8080 });
  });

  it('never probes App A itself (self port skipped)', async () => {
    const fetchFn = vi.fn(async () => ok());
    const hit = await probeDevServers([5173], '5173', fetchFn, 500);
    expect(hit).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null when nothing listens', async () => {
    const hit = await probeDevServers([3000, 3001], null, async () => dead(), 200);
    expect(hit).toBeNull();
  });
});

describe('folder memory', () => {
  it('round-trips a handle through the storage fallback', async () => {
    const fake = { name: 'vera', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
    expect(await rememberFolder(fake, 'vera')).toBe(true);
    const recalled = await recallFolder();
    expect(recalled?.folderName).toBe('vera');
    expect(recalled?.handle).toBe(fake);
  });
});

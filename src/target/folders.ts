// Folder-based target loading.
//
// Why this exists: typing `http://localhost:3000` by hand is friction, and the
// browser cannot spawn `npm run dev` itself (no process access). So the Load
// flow is: native folder picker → project scan → automatic dev-server probe
// across common local ports → iframe connects with zero typing. The chosen
// folder handle is remembered (IndexedDB, File System Access handles are
// structured-cloneable) so the next launch can reconnect with one click.
//
// A browser can NEVER start the dev server for you; if no server answers, the
// UI shows a copyable `npm run dev` command plus a one-click re-probe.

export interface ProjectFacts {
  folderName: string;
  packageJsonName: string | null;
  hasIndexHtml: boolean;
  hasDistIndex: boolean;
  hasViteConfig: boolean;
  /** e.g. "dev" when package.json scripts contain it. */
  devScript: string | null;
}

/** Ports probed in preference order for a locally running dev server. */
export const DEV_PORTS = [
  3000, 5174, 3001, 8080, 8081, 4173, 3002, 9000, 1234, 4200, 3005,
];

export function isFolderPickerSupported(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  } catch {
    return false;
  }
}

/** Pure analysis shared by the picker and fallback paths — fully testable. */
export function analyzeEntries(
  folderName: string,
  paths: string[],
  packageJsonText: string | null,
): ProjectFacts {
  const set = new Set(paths.map((p) => p.replace(/\\/g, '/')));
  let packageJsonName: string | null = null;
  let devScript: string | null = null;
  if (packageJsonText) {
    try {
      const pkg = JSON.parse(packageJsonText) as {
        name?: unknown;
        scripts?: Record<string, unknown>;
      };
      if (typeof pkg.name === 'string' && pkg.name) packageJsonName = pkg.name;
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        if (typeof pkg.scripts['dev'] === 'string') devScript = 'dev';
        else if (typeof pkg.scripts['start'] === 'string') devScript = 'start';
      }
    } catch {
      // Malformed package.json: facts stay null, scan never throws.
    }
  }
  const hasViteConfig = [...set].some((p) =>
    /(^|\/)vite\.config\.(js|ts|mjs|cjs)$/.test(p),
  );
  return {
    folderName,
    packageJsonName,
    hasIndexHtml: set.has('index.html'),
    hasDistIndex: set.has('dist/index.html') || set.has('build/index.html'),
    hasViteConfig,
    devScript,
  };
}

/** Native folder picker. Returns null when the user cancels. */
export async function pickTargetFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFolderPickerSupported()) return null;
  try {
    const handle = await window.showDirectoryPicker!({ mode: 'read' });
    return handle;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

async function tryReadText(
  dir: FileSystemDirectoryHandle,
  path: string,
): Promise<string | null> {
  try {
    const fileHandle = await dir.getFileHandle(path, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function exists(dir: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  try {
    await dir.getFileHandle(path, { create: false });
    return true;
  } catch {
    return false;
  }
}

/** Scan a picked folder handle. Never throws — missing files yield false/null. */
export async function scanDirectoryHandle(
  dir: FileSystemDirectoryHandle,
): Promise<ProjectFacts> {
  const folderName = dir.name || '(unnamed folder)';
  // NOTE: getFileHandle takes a single path component (no "dist/index.html"),
  // so nested markers are detected via a shallow keys() scan below.
  const [packageJsonText, hasIndexHtml, viteTs, viteJs] = await Promise.all([
    tryReadText(dir, 'package.json'),
    exists(dir, 'index.html'),
    exists(dir, 'vite.config.ts'),
    exists(dir, 'vite.config.js'),
  ]);
  const shallow: string[] = [];
  try {
    for await (const key of dir.keys()) {
      shallow.push(key);
      if (shallow.length >= 200) break;
    }
  } catch {
    // keys() unsupported — rely on direct checks above.
  }
  const paths = [
    ...(hasIndexHtml ? ['index.html'] : []),
    ...(shallow.includes('dist') ? ['dist/index.html'] : []),
    ...(shallow.includes('build') ? ['build/index.html'] : []),
    ...(viteTs ? ['vite.config.ts'] : []),
    ...(viteJs ? ['vite.config.js'] : []),
    ...(packageJsonText !== null ? ['package.json'] : []),
  ];
  return analyzeEntries(folderName, paths, packageJsonText);
}

export interface FallbackFile {
  path: string;
  readText: () => Promise<string>;
}

/** Fallback path for browsers without showDirectoryPicker (<input webkitdirectory>). */
export async function scanFallbackFiles(
  folderName: string,
  files: FallbackFile[],
): Promise<ProjectFacts> {
  // webkitdirectory paths look like "<selected-folder>/package.json";
  // strip the first segment so top-level markers match.
  const rel = files.map((f) => {
    const parts = f.path.replace(/\\/g, '/').split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : f.path;
  });
  const idx = rel.indexOf('package.json');
  let text: string | null = null;
  if (idx >= 0 && files[idx]) {
    try {
      text = await files[idx].readText();
    } catch {
      text = null;
    }
  }
  return analyzeEntries(folderName, rel, text);
}

export interface ProbeHit {
  url: string;
  port: number;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Probe common dev-server ports in parallel; return the first hit in
 * preference order. `selfPort` (App A's own port) is always skipped so the
 * tool never "connects" to itself. Resolving — even opaque (no-cors) —
 * counts as listening.
 */
export async function probeDevServers(
  ports: number[] = DEV_PORTS,
  selfPort: string | null = null,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
  timeoutMs = 1200,
): Promise<ProbeHit | null> {
  const candidates = ports.filter((p) => String(p) !== (selfPort ?? ''));
  const settled = await Promise.all(
    candidates.map(async (port) => {
      const url = `http://localhost:${port}`;
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        await fetchFn(`${url}/`, {
          mode: 'no-cors',
          cache: 'no-store',
          signal: ctrl.signal,
        });
        return { url, port, alive: true };
      } catch {
        return { url, port, alive: false };
      } finally {
        window.clearTimeout(timer);
      }
    }),
  );
  const hit = settled.find((r) => r.alive) ?? null;
  return hit ? { url: hit.url, port: hit.port } : null;
}

// ---- Folder memory (IndexedDB with in-memory fallback) ----

interface RememberedFolder {
  handle: FileSystemDirectoryHandle;
  folderName: string;
  savedAt: number;
}

const memFallback = new Map<string, RememberedFolder>();
const FOLDER_KEY = 'target-folder';

function idb(): IDBFactory | undefined {
  try {
    return typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  } catch {
    return undefined;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = idb();
    if (!factory) {
      reject(new Error('no-indexeddb'));
      return;
    }
    const req = factory.open('design-inspector', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) {
        req.result.createObjectStore('kv');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb-open-failed'));
  });
}

export async function rememberFolder(
  handle: FileSystemDirectoryHandle,
  folderName: string,
): Promise<boolean> {
  const entry: RememberedFolder = { handle, folderName, savedAt: Date.now() };
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(entry, FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('idb-put-failed'));
    });
    db.close();
    return true;
  } catch {
    try {
      memFallback.set(FOLDER_KEY, entry);
      return true;
    } catch {
      return false;
    }
  }
}

export async function recallFolder(): Promise<RememberedFolder | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<RememberedFolder | null>((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(FOLDER_KEY);
      req.onsuccess = () => resolve((req.result as RememberedFolder | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('idb-get-failed'));
    });
    db.close();
    return entry;
  } catch {
    return memFallback.get(FOLDER_KEY) ?? null;
  }
}

/** 'granted' means the handle is usable without a user gesture. */
export async function folderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<'granted' | 'prompt' | 'denied'> {
  try {
    if (typeof handle.queryPermission !== 'function') return 'granted';
    const q = await handle.queryPermission({ mode: 'read' });
    if (q === 'granted') return 'granted';
    if (typeof handle.requestPermission !== 'function') return q;
    // NOTE: calling requestPermission without a user gesture may fail or be
    // ignored by the browser; callers should invoke this from a click handler
    // when reconnecting.
    return await handle.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

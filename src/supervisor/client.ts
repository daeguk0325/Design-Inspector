// Supervisor status client (App A → 127.0.0.1 status server).
// Read-only polling for the "Target dev server" panel: state + log tail.
// Absent supervisor (plain `vite` run) → null, panel shows guidance instead.

export type TargetPhase = 'idle' | 'starting' | 'running' | 'error';

export interface TargetStatus {
  state: TargetPhase;
  dir: string | null;
  script: string | null;
  port: number | null;
  pid: number | null;
  error: string | null;
  updatedAt: number;
  logTail: string[];
  targetUrl: string | null;
  proxyUrl: string | null;
  proxyAppOrigin: string | null;
  proxyCompatibilityBridge: boolean | null;
  proxyCompatibilityError: string | null;
}

export const SUPERVISOR_DEFAULT_BASE = 'http://127.0.0.1:5199';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const PHASES: TargetPhase[] = ['idle', 'starting', 'running', 'error'];

export interface TargetProxyRoute {
  targetUrl: string;
  proxyUrl: string;
}

function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'http:' &&
      Boolean(url.port) &&
      !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash &&
      (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host))
    );
  } catch {
    return false;
  }
}

export function validateTargetProxyInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a target URL.';
  if (!isLoopbackHttpUrl(trimmed)) {
    return 'Use an HTTP loopback origin with an explicit port and no path or query.';
  }
  return null;
}

export async function getTargetStatus(
  baseUrl: string = SUPERVISOR_DEFAULT_BASE,
  timeoutMs = 2500,
  fetchFn: FetchLike = fetch,
): Promise<TargetStatus | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/api/target/status`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return null;
    if (!PHASES.includes(data['state'] as TargetPhase)) return null;
    if (!Array.isArray(data['logTail'])) return null;
    return {
      state: data['state'] as TargetPhase,
      dir: typeof data['dir'] === 'string' ? data['dir'] : null,
      script: typeof data['script'] === 'string' ? data['script'] : null,
      port: typeof data['port'] === 'number' ? data['port'] : null,
      pid: typeof data['pid'] === 'number' ? data['pid'] : null,
      error: typeof data['error'] === 'string' ? data['error'] : null,
      updatedAt: typeof data['updatedAt'] === 'number' ? data['updatedAt'] : 0,
      logTail: (data['logTail'] as unknown[]).map((l) => String(l)).slice(-200),
      targetUrl: isLoopbackHttpUrl(data['targetUrl']) ? data['targetUrl'] : null,
       proxyUrl: isLoopbackHttpUrl(data['proxyUrl']) ? data['proxyUrl'] : null,
       proxyAppOrigin: isLoopbackHttpUrl(data['proxyAppOrigin']) ? data['proxyAppOrigin'] : null,
       proxyCompatibilityBridge: typeof data['proxyCompatibilityBridge'] === 'boolean' ? data['proxyCompatibilityBridge'] : null,
       proxyCompatibilityError: typeof data['proxyCompatibilityError'] === 'string' ? data['proxyCompatibilityError'] : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function createTargetProxyRoute(
  targetUrl: string,
  requestId: number,
  authorizationToken?: string,
  baseUrl: string = SUPERVISOR_DEFAULT_BASE,
  timeoutMs = 5000,
  fetchFn: FetchLike = fetch,
  appOrigin: string | null = typeof window === 'undefined' ? null : window.location.origin,
): Promise<TargetProxyRoute> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/api/target/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl,
        requestId,
        ...(authorizationToken ? { authorizationToken } : {}),
      }),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const message = data && typeof data.error === 'string' ? data.error : 'Inspector proxy request failed.';
      throw new Error(message);
    }
    if (!data || !isLoopbackHttpUrl(data.targetUrl) || !isLoopbackHttpUrl(data.proxyUrl)) {
      throw new Error('Supervisor proxy returned an invalid route.');
    }
    if (new URL(data.targetUrl).origin === new URL(data.proxyUrl).origin) {
      throw new Error('Supervisor proxy route must use an isolated origin.');
    }
    if (appOrigin && new URL(data.proxyUrl).origin === new URL(appOrigin).origin) {
      throw new Error('Supervisor proxy route must not share the App origin.');
    }
    return { targetUrl: data.targetUrl, proxyUrl: data.proxyUrl };
  } finally {
    clearTimeout(timer);
  }
}

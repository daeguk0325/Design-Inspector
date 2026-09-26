// Port probing + before/after diff for the supervisor.
// A "new" port that starts answering after `npm run <script>` is treated as
// the target dev server. Pure + injectable fetch for tests.

export const TARGET_PORTS = [
  3000, 3001, 3002, 5174, 8080, 8081, 4173, 9000, 1234, 4200, 3005,
];

export async function probePort(port, fetchFn = fetch, timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchFn(`http://127.0.0.1:${port}/`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe a port list in parallel → Set of answering ports. */
export async function snapshotPorts(ports = TARGET_PORTS, fetchFn = fetch, timeoutMs = 1200) {
  const results = await Promise.all(
    ports.map(async (port) => ({ port, alive: await probePort(port, fetchFn, timeoutMs) })),
  );
  return new Set(results.filter((r) => r.alive).map((r) => r.port));
}

/** Ports present in `after` but not in `before`, in preference order. */
export function diffPorts(before, after, preference = TARGET_PORTS) {
  const fresh = [...after].filter((p) => !before.has(p));
  fresh.sort((a, b) => {
    const ia = preference.indexOf(a);
    const ib = preference.indexOf(b);
    return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
  });
  return fresh;
}

export function extractPortFromLogLine(line) {
  const text = String(line ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const ambientIgnored = /\bport\s*=\s*\d+/i.test(text) && /\bignored\b/i.test(text);
  const hasActualPort = /Local:\s*https?:\/\/[^/:]+:\d{2,5}/i.test(text) ||
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/i.test(text) ||
    /\bpinned\s+to\s+\d{2,5}/i.test(text);
  if (ambientIgnored && !hasActualPort) return null;
  const m =
    text.match(/Local:\s*https?:\/\/[^/:]+:(\d{2,5})/i) ||
    text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i) ||
    text.match(/\bpinned\s+to\s+(\d{2,5})/i) ||
    text.match(/\bport\s*[:=]?\s*(\d{2,5})/i);
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a newly-answering port (compared to `before`).
 * Returns the port or null on timeout.
 */
export async function waitForNewPort(
  before,
  { ports = TARGET_PORTS, fetchFn = fetch, timeoutMs = 60000, intervalMs = 1000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const after = await snapshotPorts(ports, fetchFn, 1200);
    const fresh = diffPorts(before, after, ports);
    if (fresh.length > 0) return fresh[0];
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

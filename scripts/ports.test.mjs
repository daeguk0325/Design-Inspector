import { describe, expect, it, vi } from 'vitest';
import {
  diffPorts,
  extractPortFromLogLine,
  probePort,
  snapshotPorts,
  waitForNewPort,
} from './ports.mjs';

const ok = () => Promise.resolve(new Response(null, { status: 200 }));
const dead = () => Promise.reject(new TypeError('refused'));

describe('diffPorts', () => {
  it('returns fresh ports in preference order', () => {
    expect(diffPorts(new Set([3000]), new Set([3000, 8080, 3001]), [3000, 3001, 8080])).toEqual([
      3001, 8080,
    ]);
  });

  it('puts unknown ports last and returns empty when nothing is new', () => {
    expect(diffPorts(new Set(), new Set([9999, 3000]), [3000])).toEqual([3000, 9999]);
    expect(diffPorts(new Set([3000]), new Set([3000]))).toEqual([]);
  });
});

describe('probePort/snapshotPorts', () => {
  it('resolves true for listeners, false for refused', async () => {
    expect(await probePort(3000, async () => ok(), 300)).toBe(true);
    expect(await probePort(3001, async () => dead(), 300)).toBe(false);
  });

  it('snapshots a set of live ports', async () => {
    const set = await snapshotPorts(
      [3000, 3001],
      async (url) => (url.includes(':3000/') ? ok() : dead()),
      300,
    );
    expect(set).toEqual(new Set([3000]));
  });
});

describe('extractPortFromLogLine', () => {
  it('reads vite-style Local lines', () => {
    expect(extractPortFromLogLine('  ➜  Local:   http://localhost:5174/')).toBe(5174);
    expect(extractPortFromLogLine('Local: http://127.0.0.1:3000/')).toBe(3000);
  });

  it('reads bare host:port and port= forms', () => {
    expect(extractPortFromLogLine('listening on 0.0.0.0:4097')).toBe(4097);
    expect(extractPortFromLogLine('[dev] ambient PORT=4097 ignored — dev server pinned to 3000')).toBe(3000);
    expect(extractPortFromLogLine('[dev] dev server port 3000')).toBe(3000);
    expect(extractPortFromLogLine('server running at http://localhost:8080')).toBe(8080);
  });

  it('returns null for noise and out-of-range ports', () => {
    expect(extractPortFromLogLine('$ npm run dev  (pid 5996)')).toBeNull();
    expect(extractPortFromLogLine('support available soon')).toBeNull();
    expect(extractPortFromLogLine('port 99999')).toBeNull();
    expect(extractPortFromLogLine('\u001b[32mLocal: http://localhost:3000/\u001b[0m')).toBe(3000);
    expect(extractPortFromLogLine('')).toBeNull();
  });
});

describe('waitForNewPort', () => {
  it('returns a port that starts answering mid-wait', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls >= 3) return ok();
      return dead();
    };
    const port = await waitForNewPort(new Set(), {
      ports: [3000],
      fetchFn,
      timeoutMs: 5000,
      intervalMs: 10,
    });
    expect(port).toBe(3000);
  });

  it('returns null on timeout', async () => {
    const fetchFn = vi.fn(async () => dead());
    const port = await waitForNewPort(new Set(), {
      ports: [3000],
      fetchFn,
      timeoutMs: 120,
      intervalMs: 10,
    });
    expect(port).toBeNull();
    expect(fetchFn).toHaveBeenCalled();
  });
});

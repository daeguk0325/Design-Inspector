import { describe, expect, it, vi } from 'vitest';
import {
  appUrlWithTarget,
  killTree,
  mapJobStatus,
  openBrowser,
  readJobPid,
  statusPayload,
  targetUrlFor,
} from './supervisor.mjs';

describe('pure helpers', () => {
  it('builds canonical target and authorized app URLs', () => {
    const token = 'a'.repeat(43);
    expect(targetUrlFor(3000)).toBe('http://127.0.0.1:3000');
    expect(appUrlWithTarget(5173, 'http://127.0.0.1:3000', token)).toBe(
      `http://127.0.0.1:5173/?target=http%3A%2F%2F127.0.0.1%3A3000&inspectorToken=${token}`,
    );
    expect(() => appUrlWithTarget(5173, 'http://127.0.0.1:3000', 'short')).toThrow(/token/);
  });

  it('shapes the status payload from mapped job status', () => {
    const p = statusPayload(
      mapJobStatus({
        dir: 'd',
        script: 'dev',
        updatedAt: 7,
        status: {
          phase: 'running',
          port: 3000,
          pid: 1,
          error: null,
          updatedAt: 8,
          logTail: ['hello'],
        },
      }),
    );
    expect(p).toMatchObject({ state: 'running', port: 3000, logTail: ['hello'] });
  });
});

describe('mapJobStatus', () => {
  it('returns idle for absent or malformed jobs', () => {
    expect(mapJobStatus(null)).toMatchObject({ state: 'idle', port: null });
    expect(mapJobStatus({})).toMatchObject({ state: 'idle' });
    expect(mapJobStatus({ status: { phase: 'flying' } })).toMatchObject({ state: 'idle' });
  });

  it('maps launcher stopped to idle (client contract)', () => {
    expect(mapJobStatus({ status: { phase: 'stopped' } }).state).toBe('idle');
  });

  it('falls back to last.port when status has none', () => {
    expect(
      mapJobStatus({ status: { phase: 'running' }, last: { port: 4000 } }).port,
    ).toBe(4000);
  });

  it('prefers status fields and stringifies log lines', () => {
    const m = mapJobStatus({
      dir: 'd',
      script: 'dev',
      status: { phase: 'error', port: 3000, pid: 9, error: 'boom', logTail: [1, 'x'] },
    });
    expect(m).toMatchObject({
      state: 'error',
      dir: 'd',
      script: 'dev',
      port: 3000,
      pid: 9,
      error: 'boom',
      logTail: ['1', 'x'],
    });
  });
});

describe('readJobPid', () => {
  it('extracts a valid backstop pid only', () => {
    expect(readJobPid({ status: { pid: 1234 } })).toBe(1234);
    expect(readJobPid({ status: { pid: -1 } })).toBeNull();
    expect(readJobPid({ status: {} })).toBeNull();
    expect(readJobPid(null)).toBeNull();
  });
});

describe('killTree', () => {
  it('uses taskkill with the process tree flags on Windows', () => {
    const killer = vi.fn();
    expect(killTree(4321, 'win32', killer)).toBe(true);
    expect(killer).toHaveBeenCalledWith(['/PID', '4321', '/T', '/F']);
  });

  it('reports failure instead of throwing', () => {
    expect(
      killTree(1, 'win32', () => {
        throw new Error('nope');
      }),
    ).toBe(false);
  });
});

describe('openBrowser', () => {
  it('opens via cmd start on Windows without blocking', () => {
    const child = { unref: vi.fn() };
    const spawner = vi.fn(() => child);
    expect(openBrowser('http://localhost:5173/', 'win32', spawner)).toBe(true);
    expect(spawner.mock.calls[0][0]).toBe('cmd');
    expect(child.unref).toHaveBeenCalled();
  });
});

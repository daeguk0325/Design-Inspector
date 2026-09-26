import { describe, expect, it, vi } from 'vitest';
import { createTargetProxyRoute, getTargetStatus, validateTargetProxyInput } from './client.ts';

function res(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

const FULL = {
  state: 'running',
  dir: 'C:\\proj',
  script: 'dev',
  port: 3000,
  pid: 123,
  error: null,
  updatedAt: 9,
  logTail: ['[target] ready'],
  targetUrl: 'http://127.0.0.1:3000',
  proxyUrl: 'http://127.0.0.1:43123',
  proxyAppOrigin: 'http://127.0.0.1:5173',
  proxyCompatibilityBridge: true,
  proxyCompatibilityError: null,
};

describe('getTargetStatus', () => {
  it('parses a well-formed supervisor payload', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => res(FULL));
    const s = await getTargetStatus('http://127.0.0.1:5199', 500, fetchFn);
    expect(s).toMatchObject({ state: 'running', port: 3000, logTail: ['[target] ready'], proxyCompatibilityBridge: true });
    expect(fetchFn.mock.calls[0]?.[0]).toContain('/api/target/status');
  });

  it('returns null when the supervisor is absent', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('refused');
    });
    expect(await getTargetStatus('http://127.0.0.1:5199', 200, fetchFn)).toBeNull();
  });

  it('returns null on HTTP errors and malformed shapes', async () => {
    const bad = vi.fn(async () => res({}, false));
    expect(await getTargetStatus('http://127.0.0.1:5199', 200, bad)).toBeNull();
    const wrongState = vi.fn(async () => res({ ...FULL, state: 'flying' }));
    expect(await getTargetStatus('http://127.0.0.1:5199', 200, wrongState)).toBeNull();
    const noLogs = vi.fn(async () => res({ ...FULL, logTail: 'nope' }));
    expect(await getTargetStatus('http://127.0.0.1:5199', 200, noLogs)).toBeNull();
  });
});

describe('validateTargetProxyInput', () => {
  it('accepts only explicit-port HTTP loopback origins', () => {
    expect(validateTargetProxyInput('http://localhost:3000')).toBeNull();
    expect(validateTargetProxyInput('http://127.23.45.67:3000')).toBeNull();
    expect(validateTargetProxyInput('https://localhost:3000')).toMatch(/HTTP loopback/);
    expect(validateTargetProxyInput('http://192.168.1.2:3000')).toMatch(/HTTP loopback/);
    expect(validateTargetProxyInput('http://localhost:3000/app')).toMatch(/no path/);
  });
});

describe('createTargetProxyRoute', () => {
  it('posts the canonical target and parses the dedicated proxy origin', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => res({
      targetUrl: 'http://127.0.0.1:3000',
      proxyUrl: 'http://127.0.0.1:43123',
    }));
    const token = 'a'.repeat(43);
    const route = await createTargetProxyRoute('http://localhost:3000', 1001, token, 'http://127.0.0.1:5199', 500, fetchFn);
    expect(route).toEqual({
      targetUrl: 'http://127.0.0.1:3000',
      proxyUrl: 'http://127.0.0.1:43123',
    });
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      targetUrl: 'http://localhost:3000',
      requestId: 1001,
      authorizationToken: 'a'.repeat(43),
    });
  });

  it('rejects proxy routes that share the App origin', async () => {
    const fetchFn = vi.fn(async () => res({
      targetUrl: 'http://127.0.0.1:3000',
      proxyUrl: 'http://127.0.0.1:5173',
    }));
    await expect(createTargetProxyRoute(
      'http://127.0.0.1:3000',
      1004,
      undefined,
      'http://127.0.0.1:5199',
      500,
      fetchFn,
      'http://127.0.0.1:5173',
    )).rejects.toThrow(/App origin/);
  });

  it('rejects non-local and error responses', async () => {
    const remote = vi.fn(async () => res({
      targetUrl: 'https://example.com',
      proxyUrl: 'http://127.0.0.1:43123',
    }));
    await expect(createTargetProxyRoute('https://example.com', 1002, undefined, 'http://127.0.0.1:5199', 500, remote)).rejects.toThrow(/invalid route/i);
    const failed = vi.fn(async () => res({ error: 'Target URL must use localhost.' }, false));
    await expect(createTargetProxyRoute('http://localhost:3000', 1003, undefined, 'http://127.0.0.1:5199', 500, failed)).rejects.toThrow(/localhost/);
  });
});

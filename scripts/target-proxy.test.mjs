import { createServer } from 'node:http';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createBridgeSourceLoader,
  createTargetProxy,
  getInspectorBridgeArtifact,
  injectInspectorBridge,
  normalizeAppOrigin,
  normalizeLoopbackTargetUrl,
  rewriteFramePolicy,
  rewriteInspectorPolicy,
  stripCookieDomain,
} from './target-proxy.mjs';

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup();
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function trackServer(server) {
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return server;
}

describe('target URL policy', () => {
  it('normalizes localhost and loopback IPv4 to IPv4 origins', () => {
    expect(normalizeLoopbackTargetUrl('http://localhost:3000')).toBe('http://127.0.0.1:3000');
    expect(normalizeLoopbackTargetUrl('http://127.10.20.30:8080/')).toBe('http://127.10.20.30:8080');
    expect(normalizeAppOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('rejects non-loopback, credentialed, path, and implicit-port targets', () => {
    expect(() => normalizeLoopbackTargetUrl('https://localhost:3000')).toThrow(/HTTP/);
    expect(() => normalizeLoopbackTargetUrl('http://example.com:3000')).toThrow(/loopback/);
    expect(() => normalizeLoopbackTargetUrl('http://192.168.1.2:3000')).toThrow(/loopback/);
    expect(() => normalizeLoopbackTargetUrl('http://user:pass@localhost:3000')).toThrow(/credentials/);
    expect(() => normalizeLoopbackTargetUrl('http://localhost:3000/app')).toThrow(/without a path/);
    expect(() => normalizeLoopbackTargetUrl('http://localhost')).toThrow(/valid port/);
  });
});

describe('proxy header policy', () => {
  it('replaces every frame policy while preserving other CSP directives', () => {
    const rewritten = rewriteFramePolicy(
      "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
      ['http://localhost:5173'],
    );
    expect(rewritten).toBe("default-src 'self'; script-src 'self'; frame-ancestors http://localhost:5173");
  });

  it('creates a frame policy when the target has none', () => {
    expect(rewriteFramePolicy(undefined, ['http://localhost:5173'])).toBe(
      'frame-ancestors http://localhost:5173',
    );
  });

  it('removes cookie domains for the dedicated proxy origin', () => {
    expect(stripCookieDomain('a=1; Domain=localhost; Path=/; HttpOnly')).toBe('a=1; Path=/; HttpOnly');
  });

  it('adds the compatibility hash without widening script sources', () => {
    expect(rewriteInspectorPolicy(
      "default-src 'self'; script-src 'none'; script-src-elem 'self'; sandbox allow-scripts; frame-ancestors 'none'",
      ['http://127.0.0.1:5173'],
      "'sha256-test'",
    )).toBe(
      "default-src 'self'; script-src 'sha256-test'; script-src-elem 'self' 'sha256-test'; frame-ancestors http://127.0.0.1:5173",
    );
  });

  it('injects before head close and rewrites meta CSP', async () => {
    const artifact = await getInspectorBridgeArtifact('http://127.0.0.1:5173');
    const injected = injectInspectorBridge(
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><title>x</title><script>const close = "</head>";</script></head><body><main>x</main></body></html>',
      artifact.scriptText,
      artifact.scriptHash,
      ['http://127.0.0.1:5173'],
    );
    expect(injected.match(/data-design-inspector="compatibility"/g)).toHaveLength(1);
    expect(injected.indexOf('data-design-inspector="compatibility"')).toBeLessThan(injected.lastIndexOf('</head>'));
    expect(injected).toContain(`script-src 'self' ${artifact.scriptHash}`);
  });
});

describe('bridge source reloading', () => {
  it('serves the same artifact when nothing changed', async () => {
    const first = await getInspectorBridgeArtifact('http://127.0.0.1:5173');
    const second = await getInspectorBridgeArtifact('http://127.0.0.1:5173');
    expect(second.scriptHash).toBe(first.scriptHash);
  });

  it('reloads the sources when one of them changes on disk', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'vera-bridge-'));
    const bridge = join(scratch, 'vera-inspector-bridge.ts');
    const compatibility = join(scratch, 'vera-inspector-compatibility.ts');
    const canvas = join(scratch, 'html2canvas.min.js');
    await writeFile(bridge, 'export const marker = "FIRST";\n', 'utf8');
    await writeFile(compatibility, 'export const compat = 1;\n', 'utf8');
    await writeFile(canvas, 'window.html2canvas = {};\n', 'utf8');
    try {
      const load = createBridgeSourceLoader([bridge, compatibility, canvas]);
      const [firstBridge] = await load();
      expect(firstBridge).toContain('FIRST');

      // Unchanged content: the fingerprint has to be stable, or every request
      // would re-transpile the Bridge.
      const [againBridge] = await load();
      expect(againBridge).toBe(firstBridge);

      // A real edit moves the mtime forward.
      await writeFile(bridge, 'export const marker = "SECOND";\n', 'utf8');
      const later = new Date(Date.now() + 4000);
      await utimes(bridge, later, later);
      const [secondBridge] = await load();
      expect(secondBridge).toContain('SECOND');
      expect(secondBridge).not.toBe(firstBridge);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('keeps serving the previous sources when a read fails', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'vera-bridge-'));
    const bridge = join(scratch, 'vera-inspector-bridge.ts');
    const compatibility = join(scratch, 'vera-inspector-compatibility.ts');
    const canvas = join(scratch, 'html2canvas.min.js');
    await writeFile(bridge, 'export const marker = "KEPT";\n', 'utf8');
    await writeFile(compatibility, 'export const compat = 1;\n', 'utf8');
    await writeFile(canvas, 'window.html2canvas = {};\n', 'utf8');
    try {
      const load = createBridgeSourceLoader([bridge, compatibility, canvas]);
      const [first] = await load();
      expect(first).toContain('KEPT');

      await rm(bridge);
      const [afterFailure] = await load();
      expect(afterFailure).toContain('KEPT');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('target proxy integration', () => {
  it('streams HTTP while removing framing denial and rewriting local redirects and cookies', async () => {
    let upstreamOrigin = '';
    let receivedHost = '';
    let receivedOrigin = '';
    let receivedReferer = '';
    let receivedFetchSite = '';
    const upstream = trackServer(createServer(async (req, res) => {
      receivedHost = req.headers.host;
      receivedOrigin = req.headers.origin ?? '';
      receivedReferer = req.headers.referer ?? '';
      receivedFetchSite = req.headers['sec-fetch-site'] ?? '';
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: `${upstreamOrigin}/next?x=1` });
        res.end();
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), query: req.url }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': [
          "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
          "img-src 'self'; frame-ancestors 'self'",
        ],
        'Content-Security-Policy-Report-Only': "frame-ancestors 'none'",
        'Set-Cookie': ['a=1; Domain=localhost; Path=/; HttpOnly', 'b=2; Path=/'],
      });
      res.end('<h1>proxied</h1>');
    }));
    upstreamOrigin = await listen(upstream);
    const proxy = await createTargetProxy({ targetUrl: upstreamOrigin, appOrigin: 'http://localhost:5173' });
    cleanups.push(() => proxy.close());

    const html = await fetch(`${proxy.proxyUrl}/`);
    expect(new URL(proxy.proxyUrl).hostname).not.toBe('127.0.0.1');
    expect(html.status).toBe(200);
    const body = await html.text();
    const artifact = await getInspectorBridgeArtifact('http://localhost:5173');
    expect(body).toContain('<h1>proxied</h1>');
    expect(body).toContain('data-design-inspector="compatibility"');
    expect(body).toContain('"bridgeKind":"compatibility"');
    expect(html.headers.get('x-inspector-compat-bridge')).toBe('injected');
    expect(html.headers.get('x-frame-options')).toBeNull();
    expect(html.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(html.headers.get('content-security-policy')).toContain(artifact.scriptHash);
    expect(html.headers.get('content-security-policy')).toContain('frame-ancestors http://localhost:5173');
    expect(html.headers.get('content-security-policy')).not.toContain("frame-ancestors 'none'");
    expect(html.headers.get('set-cookie')).not.toContain('Domain=');
    expect(receivedHost).toBe(new URL(upstreamOrigin).host);

    const redirect = await fetch(`${proxy.proxyUrl}/redirect`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(`${proxy.proxyUrl}/next?x=1`);

    const post = await fetch(`${proxy.proxyUrl}/echo?a=1&a=2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'http://localhost:5173',
        Referer: `${proxy.proxyUrl}/parent`,
      },
      body: 'request-body',
    });
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({ body: 'request-body', query: '/echo?a=1&a=2' });
    expect(receivedOrigin).toBe(upstreamOrigin);
    expect(receivedReferer).toBe(`${upstreamOrigin}/parent`);
    expect(receivedFetchSite).toBe('same-origin');

    const blocked = await fetch(`${proxy.proxyUrl}/blocked`, {
      headers: {
        Origin: 'https://evil.test',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('x-inspector-proxy-error')).toBe('forbidden-request');
  });

  it('decodes compressed HTML before injecting the compatibility Bridge', async () => {
    const upstream = trackServer(createServer((req, res) => {
      const body = gzipSync('<html><head><title>compressed</title></head><body>ok</body></html>');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': String(body.length),
      });
      res.end(body);
    }));
    const upstreamOrigin = await listen(upstream);
    const proxy = await createTargetProxy({ targetUrl: upstreamOrigin, appOrigin: 'http://localhost:5173' });
    cleanups.push(() => proxy.close());
    const response = await fetch(`${proxy.proxyUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('x-inspector-compat-bridge')).toBe('injected');
    expect(await response.text()).toContain('data-design-inspector="compatibility"');
  });

  it('fails open when a compressed document exceeds the decoded limit', async () => {
    const upstream = trackServer(createServer((req, res) => {
      const body = gzipSync('x'.repeat(10_000));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': String(body.length),
      });
      res.end(body);
    }));
    const upstreamOrigin = await listen(upstream);
    const proxy = await createTargetProxy({
      targetUrl: upstreamOrigin,
      appOrigin: 'http://127.0.0.1:5173',
      maxDocumentBytes: 128,
    });
    cleanups.push(() => proxy.close());
    const response = await fetch(`${proxy.proxyUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-inspector-compat-bridge')).toBeNull();
    expect(await response.text()).not.toContain('data-design-inspector');
  });

  it('can disable compatibility injection without changing the target document', async () => {
    const upstream = trackServer(createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>plain</h1>');
    }));
    const upstreamOrigin = await listen(upstream);
    const proxy = await createTargetProxy({
      targetUrl: upstreamOrigin,
      appOrigin: 'http://localhost:5173',
      compatibilityBridge: false,
    });
    cleanups.push(() => proxy.close());
    const response = await fetch(`${proxy.proxyUrl}/`);
    expect(await response.text()).toBe('<h1>plain</h1>');
    expect(response.headers.get('x-inspector-compat-bridge')).toBeNull();
  });

  it('forwards WebSocket upgrades and bytes in both directions', async () => {
    const wss = new WebSocketServer({ noServer: true });
    let receivedOrigin = '';
    let receivedPath = '';
    wss.on('connection', (socket, request) => {
      receivedOrigin = request.headers.origin;
      receivedPath = request.url;
      socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    const upstream = trackServer(createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('healthy');
    }));
    upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit('connection', client, req);
    }));
    const upstreamOrigin = await listen(upstream);
    const proxy = await createTargetProxy({ targetUrl: upstreamOrigin, appOrigin: 'http://localhost:5173' });
    cleanups.push(() => proxy.close());
    cleanups.push(() => new Promise((resolve) => wss.close(resolve)));

    const client = new WebSocket(
      `${proxy.proxyUrl.replace('http:', 'ws:')}/socket?token=x`,
      [],
      { origin: 'http://localhost:5173' },
    );
    cleanups.push(() => client.terminate());
    const message = new Promise((resolve, reject) => {
      client.once('open', () => client.send(Buffer.from([1, 2, 3])));
      client.once('message', (data, isBinary) => resolve({ data: Buffer.from(data).toString('hex'), isBinary }));
      client.once('error', reject);
    });
    await expect(message).resolves.toEqual({ data: '010203', isBinary: true });
    expect(receivedOrigin).toBe(upstreamOrigin);
    expect(receivedPath).toBe('/socket?token=x');
    client.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await (await fetch(`${proxy.proxyUrl}/health`)).text()).toBe('healthy');
  });

  it('returns 502 when the upstream is unavailable and releases its port on close', async () => {
    const reserve = createServer();
    const unavailableOrigin = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    const proxy = await createTargetProxy({ targetUrl: unavailableOrigin, appOrigin: 'http://localhost:5173' });
    const response = await fetch(`${proxy.proxyUrl}/`);
    expect(response.status).toBe(502);
    expect(response.headers.get('x-inspector-proxy-error')).toBe('upstream-unavailable');
    await proxy.close();
    await expect(fetch(`${proxy.proxyUrl}/`)).rejects.toThrow();
  });
});

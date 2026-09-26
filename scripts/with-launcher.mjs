// with-launcher.mjs — `npm run dev` entry: App A (vite) + Launcher window.
// The LAUNCHER owns the target dev child (spawn + kill on window close).
// This supervisor: boots vite + launcher, opens the browser when the job
// reports a new target port, serves job-derived status on 127.0.0.1, and
// backstop-kills the recorded target pid on its own exit (App A coupling).
// App A + Launcher supervisor (Node 22+).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { defaultJobFilePath, lenientJsonParse, readJobFile } from './jobfile.mjs';
import {
  createTargetProxy,
  normalizeAppOrigin,
  normalizeLoopbackTargetUrl,
} from './target-proxy.mjs';
import {
  targetUrlFor,
  appUrlWithTarget,
  killTree,
  openBrowser,
  mapJobStatus,
  statusPayload,
} from './supervisor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.findIndex(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (i === -1) return fallback;
  const hit = process.argv[i];
  const eq = hit.indexOf('=');
  if (eq !== -1) return hit.slice(eq + 1);
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) return next;
  return true;
}

function flag(name) {
  const v = arg(name, false);
  return v === true || v === 'true' || v === '1';
}

const NO_LAUNCHER = flag('no-launcher');
const NO_BROWSER = flag('no-browser');
const JOB_PATH = resolve(arg('job-file', null) ?? defaultJobFilePath());
const SUPERVISOR_PORT = Number(arg('supervisor-port', process.env.INSPECTOR_SUPERVISOR_PORT ?? 5199));
const APP_PORT_FALLBACK = 5173;

try {
  mkdirSync(dirname(JOB_PATH), { recursive: true });
} catch (err) {
  log('supervisor', `job directory unavailable (${err.message}); launcher may not publish status`);
}

function launcherBinFor(platform = process.platform) {
  const dir = join(ROOT, 'launcher', 'dist', 'design-inspector-launcher');
  if (platform === 'win32') return join(dir, 'design-inspector-launcher-win_x64.exe');
  if (platform === 'darwin') return join(dir, 'design-inspector-launcher-mac_universal');
  return join(dir, 'design-inspector-launcher-linux_x64');
}

function log(prefix, line) {
  process.stdout.write(`[${prefix}] ${line}\n`);
}

function processBelongsToJob(pid, requestedAt, script, platform = process.platform) {
  if (platform !== 'win32') return true;
  if (
    !Number.isFinite(requestedAt) ||
    requestedAt <= 0 ||
    typeof script !== 'string' ||
    !/^[A-Za-z0-9:_-]+$/.test(script)
  ) return false;
  const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($null -ne $p) { [pscustomobject]@{ created = $p.CreationDate.ToUniversalTime().ToString('o'); commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress }`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return false;
  try {
    const process = JSON.parse(result.stdout.trim());
    const startedAt = Date.parse(process.created);
    const commandLine = String(process.commandLine ?? '').toLowerCase();
    return (
      Number.isFinite(startedAt) &&
      startedAt + 2000 >= requestedAt &&
      startedAt <= requestedAt + 30000 &&
      commandLine.includes(`npm run ${script.toLowerCase()}`)
    );
  } catch {
    return false;
  }
}

/** Synchronous job read for exit-path backstop (async handlers may not run). */
function readJobPidSync() {
  try {
    const raw = readFileSync(JOB_PATH, 'utf8');
    const job = lenientJsonParse(raw);
    const pid = job && job.status && job.status.pid;
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return null;
    return processBelongsToJob(pid, job.requestedAt, job.script) ? pid : null;
  } catch {
    return null;
  }
}

let activeProxy = null;
let proxyQueue = Promise.resolve();
let latestProxyRequestId = null;

function currentAppPort() {
  return spawnVite.appPort ?? APP_PORT_FALLBACK;
}

function currentAppOrigin() {
  return `http://127.0.0.1:${currentAppPort()}`;
}

function isCurrentAppOrigin(value) {
  try {
    return normalizeAppOrigin(value) === currentAppOrigin();
  } catch {
    return false;
  }
}

function validHandoffToken(token, targetUrl) {
  if (token === undefined) return true;
  if (
    typeof token !== 'string' ||
    typeof activeProxy?.authorizationToken !== 'string' ||
    activeProxy.authorizationTokenConsumed ||
    activeProxy.targetUrl !== targetUrl
  ) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(activeProxy.authorizationToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function ensureTargetProxy(targetUrl, appOrigin, requestId) {
  const operation = proxyQueue.then(async () => {
    const normalizedTarget = normalizeLoopbackTargetUrl(targetUrl);
    const normalizedApp = normalizeAppOrigin(appOrigin);
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      throw new Error('Proxy requestId must be a positive safe integer.');
    }
    if (requestId > (latestProxyRequestId ?? 0)) latestProxyRequestId = requestId;
    const targetPort = Number(new URL(normalizedTarget).port);
    if (activeProxy?.targetUrl === normalizedTarget) {
      activeProxy.addFrameOrigin(normalizedApp);
      return activeProxy;
    }
    if (requestId < latestProxyRequestId) {
      throw new Error('A newer Inspector target request is already active.');
    }
    if (
      targetPort === SUPERVISOR_PORT ||
      targetPort === currentAppPort() ||
      targetPort === activeProxy?.port
    ) {
      throw new Error('Target port belongs to Design Inspector.');
    }
    const previous = activeProxy;
    activeProxy = null;
    if (previous) await previous.close();
    activeProxy = await createTargetProxy({
      targetUrl: normalizedTarget,
      appOrigin: normalizedApp,
      logger: (message) => log('proxy', message),
    });
    activeProxy.authorizationToken = randomBytes(32).toString('base64url');
    activeProxy.authorizationTokenConsumed = false;
    log('proxy', `${normalizedTarget} → ${activeProxy.proxyUrl}`);
    return activeProxy;
  });
  proxyQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function closeTargetProxy(expectedTargetUrl = null) {
  const operation = proxyQueue.then(async () => {
    if (expectedTargetUrl && activeProxy?.targetUrl !== expectedTargetUrl) return;
    const previous = activeProxy;
    activeProxy = null;
    if (previous) await previous.close();
  });
  proxyQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function readJsonBody(req, limit = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, value, origin = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(value));
}

// ---- tiny status server (loopback only; content sourced from the job file) ----
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', `http://127.0.0.1:${SUPERVISOR_PORT}`).pathname;
  if (req.method === 'GET' && path === '/api/target/status') {
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (requestOrigin && !isCurrentAppOrigin(requestOrigin)) {
      sendJson(res, 403, { error: 'Origin is not the active Inspector app.' });
      return;
    }
    const job = await readJobFile(JOB_PATH);
    const payload = {
      ...statusPayload(mapJobStatus(job)),
      targetUrl: activeProxy?.targetUrl ?? null,
       proxyUrl: activeProxy?.proxyUrl ?? null,
       proxyAppOrigin: activeProxy?.appOrigin ?? null,
       proxyCompatibilityBridge: activeProxy?.compatibilityBridge ?? null,
       proxyCompatibilityError: activeProxy?.compatibilityError ?? null,
    };
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    };
    if (requestOrigin) {
      headers['Access-Control-Allow-Origin'] = requestOrigin;
      headers.Vary = 'Origin';
    }
    res.writeHead(200, headers);
    res.end(body);
    return;
  }

  if (path === '/api/target/proxy') {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (!origin || !isCurrentAppOrigin(origin)) {
      sendJson(res, 403, { error: 'Origin is not the active Inspector app.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      res.end();
      return;
    }
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'Content-Type must be application/json.' }, origin);
        return;
      }
      try {
        const body = await readJsonBody(req);
        if (!body || typeof body.targetUrl !== 'string') {
          sendJson(res, 400, { error: 'targetUrl is required.' }, origin);
          return;
        }
        const normalizedTarget = normalizeLoopbackTargetUrl(body.targetUrl);
        if (!validHandoffToken(body.authorizationToken, normalizedTarget)) {
          throw new Error('Inspector target handoff token is invalid or already consumed.');
        }
        const proxy = await ensureTargetProxy(normalizedTarget, origin, body.requestId);
        if (body.authorizationToken !== undefined) activeProxy.authorizationTokenConsumed = true;
        sendJson(res, 200, {
          targetUrl: proxy.targetUrl,
          proxyUrl: proxy.proxyUrl,
        }, origin);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid proxy request.' }, origin);
      }
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
server.listen(SUPERVISOR_PORT, '127.0.0.1', () => {
  log('supervisor', `status and target proxy control at http://127.0.0.1:${SUPERVISOR_PORT}`);
});
server.on('error', (err) => {
  log('supervisor', `status server unavailable (${err.message}); continuing without it`);
});

// ---- children ----
let viteChild = null;
let launcherChild = null;
let shuttingDown = false;

function spawnVite() {
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  viteChild = spawn(process.execPath, [viteBin, '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  let out = '';
  const sniff = (chunk) => {
    const text = String(chunk);
    out += text;
    process.stdout.write(text);
    // Strip ANSI color codes (vite colorizes the Local: line when permitted).
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    const m = plain.match(/Local:\s+https?:\/\/[^/:]+:(\d+)/);
    if (m && !spawnVite.appPort) {
      spawnVite.appPort = Number(m[1]);
      log('supervisor', `App A detected on port ${spawnVite.appPort}`);
    }
  };
  viteChild.stdout.on('data', sniff);
  viteChild.stderr.on('data', sniff);
  viteChild.on('exit', (code) => {
    if (!shuttingDown) {
      log('supervisor', `vite exited (${code}); shutting down`);
      shutdown(code ?? 0);
    }
  });
}
spawnVite.appPort = null;

async function reconcileLauncherExit() {
  if (shuttingDown) return;
  try {
    const job = await readJobFile(JOB_PATH);
    const status = job && job.status;
    const port = status && typeof status.port === 'number'
      ? status.port
      : job && job.last && job.last.port;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
    const url = targetUrlFor(port);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await targetIsReachable(url)) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (lastOpenedKey !== null) lastOpenedKey = null;
    await closeTargetProxy(url);
    log('proxy', `released ${url} after Launcher exit`);
  } catch (err) {
    log('proxy', `launcher exit reconcile failed (${err instanceof Error ? err.message : err})`);
  }
}

function spawnLauncher() {
  if (NO_LAUNCHER) {
    log('supervisor', 'launcher disabled (--no-launcher); use the in-browser folder flow');
    return;
  }
  const bin = arg('launcher-bin', launcherBinFor());
  if (!existsSync(bin)) {
    log('supervisor', `launcher binary not found at ${bin}; use the in-browser folder flow`);
    return;
  }
  launcherChild = spawn(bin, [], {
    cwd: dirname(bin),
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      INSPECTOR_JOB_FILE: JOB_PATH,
      INSPECTOR_SUPERVISOR_PORT: String(SUPERVISOR_PORT),
    },
  });
  launcherChild.on('error', (err) => {
    log('supervisor', `launcher failed to start (${err.message}); use the in-browser folder flow`);
    launcherChild = null;
  });
  launcherChild.on('exit', () => {
    launcherChild = null;
    void reconcileLauncherExit();
  });
}

// ---- job watch: open the browser once per new target port ----
let lastOpenedKey = null;
let lastMissingTargetKey = null;

async function targetIsReachable(url) {
  try {
    await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(1500),
    });
    return true;
  } catch {
    return false;
  }
}

let pollInFlight = false;
async function pollJob() {
  if (shuttingDown || pollInFlight) return;
  pollInFlight = true;
  try {
    const job = await readJobFile(JOB_PATH);
    const status = job && job.status;
    const port = status && typeof status.port === 'number'
      ? status.port
      : job && job.last && job.last.port;
    if (status && (status.phase === 'stopped' || status.phase === 'error')) {
      if (lastOpenedKey !== null) {
        lastOpenedKey = null;
        const stoppedUrl = typeof port === 'number' ? targetUrlFor(port) : null;
        await closeTargetProxy(stoppedUrl);
      }
      return;
    }
    if (!spawnVite.appPort) return;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
    const url = targetUrlFor(port);
    const runId = job.requestedAt ?? status?.updatedAt ?? port;
    const key = `${url}|${runId}`;
    if (key === lastOpenedKey) return;
    if (!(await targetIsReachable(url))) {
      if (key !== lastMissingTargetKey) {
        lastMissingTargetKey = key;
        log('supervisor', `target is not reachable at ${url}; waiting`);
      }
      return;
    }
    lastMissingTargetKey = null;
    const proxyRequestId = Number.isSafeInteger(Number(runId))
      ? Number(runId) * 1000
      : Date.now() * 1000;
    const proxy = await ensureTargetProxy(url, currentAppOrigin(), proxyRequestId);
    lastOpenedKey = key;
    const appUrl = appUrlWithTarget(
      spawnVite.appPort,
      url,
      proxy.authorizationToken,
    );
    if (!NO_BROWSER) {
      log('supervisor', `target up at ${url} via ${proxy.proxyUrl} → opening ${appUrl}`);
      if (!openBrowser(appUrl)) log('supervisor', 'browser open failed');
    } else {
      log('supervisor', `target up at ${url} via ${proxy.proxyUrl} (app URL ${appUrl})`);
    }
  } catch (err) {
    log('supervisor', `job poll failed (${err?.message ?? err})`);
  } finally {
    pollInFlight = false;
  }
}

// ---- coupled shutdown: backstop-kill the launcher-owned target pid ----
let shutdownPromise = null;
function shutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  const pid = readJobPidSync();
  if (pid !== null) {
    log('supervisor', `stopping recorded target pid ${pid} (supervisor shutdown)`);
    killTree(pid);
  }
  for (const child of [viteChild, launcherChild]) {
    try {
      if (child && !child.killed && child.pid) killTree(child.pid);
    } catch {
      // best effort
    }
  }
  shutdownPromise = closeTargetProxy().finally(() => {
    try {
      server.close();
    } catch {
      // ignore
    }
    process.exit(code);
  });
  return shutdownPromise;
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('exit', () => {
  // Synchronous last resort for abrupt termination.
  try {
    const pid = readJobPidSync();
    if (pid !== null) killTree(pid);
  } catch {
    // ignore
  }
});

spawnVite();
spawnLauncher();
setInterval(pollJob, 1000);
log('supervisor', `watching job file ${JOB_PATH}`);

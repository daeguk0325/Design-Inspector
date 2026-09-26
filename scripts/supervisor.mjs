// Supervisor helpers (dependency-injected for tests).
// The LAUNCHER owns the target dev child (spawn + kill on window close).
// This module: URL builders, tree kill, browser open, and job→status mapping
// served on the loopback status endpoint (App A panel reads it).

import { spawn, spawnSync } from 'node:child_process';

export function targetUrlFor(port) {
  return `http://127.0.0.1:${port}`;
}

export function appUrlWithTarget(appPort, targetUrl, authorizationToken) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(authorizationToken)) {
    throw new Error('A valid Inspector handoff token is required.');
  }
  const target = `target=${encodeURIComponent(targetUrl)}`;
  const token = `inspectorToken=${encodeURIComponent(authorizationToken)}`;
  return `http://127.0.0.1:${appPort}/?${target}&${token}`;
}

export function killTree(pid, platform = process.platform, killer = null) {
  try {
    if (platform === 'win32') {
      const run = killer ?? ((args) => spawnSync('taskkill', args, { stdio: 'ignore' }));
      run(['/PID', String(pid), '/T', '/F']);
    } else {
      const run = killer ?? ((targetPid) => process.kill(-targetPid, 'SIGKILL'));
      run(pid);
    }
    return true;
  } catch {
    return false;
  }
}

export function openBrowser(url, platform = process.platform, spawner = spawn) {
  try {
    if (platform === 'win32') {
      spawner('cmd', ['/d', '/s', '/c', 'start', '""', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (platform === 'darwin') {
      spawner('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawner('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

const PHASES = ['idle', 'starting', 'running', 'error'];

/**
 * Map a job file (launcher-written) to the status payload shape.
 * Unknown/absent status → idle; launcher 'stopped' → idle (the App A client
 * only accepts idle|starting|running|error).
 */
export function mapJobStatus(job) {
  const base = {
    state: 'idle',
    dir: null,
    script: null,
    port: null,
    pid: null,
    error: null,
    updatedAt: 0,
    logTail: [],
  };
  if (!job || typeof job !== 'object') return base;
  if (typeof job.dir === 'string') base.dir = job.dir;
  if (typeof job.script === 'string') base.script = job.script;
  if (typeof job.updatedAt === 'number') base.updatedAt = job.updatedAt;
  const s = job.status;
  if (!s || typeof s !== 'object') return base;
  base.state = s.phase === 'stopped' ? 'idle' : PHASES.includes(s.phase) ? s.phase : 'idle';
  if (typeof s.port === 'number') {
    base.port = s.port;
  } else if (job.last && typeof job.last.port === 'number') {
    base.port = job.last.port;
  }
  if (typeof s.pid === 'number') base.pid = s.pid;
  if (typeof s.error === 'string') base.error = s.error;
  if (typeof s.updatedAt === 'number') base.updatedAt = s.updatedAt;
  if (Array.isArray(s.logTail)) base.logTail = s.logTail.map((l) => String(l)).slice(-200);
  return base;
}

/** Extract the backstop-kill pid from a job (launcher-recorded child pid). */
export function readJobPid(job) {
  const pid = job && job.status && job.status.pid;
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function statusPayload(mapped) {
  return {
    state: mapped.state,
    dir: mapped.dir,
    script: mapped.script,
    port: mapped.port,
    pid: mapped.pid,
    error: mapped.error,
    updatedAt: mapped.updatedAt,
    logTail: mapped.logTail,
  };
}

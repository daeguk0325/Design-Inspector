// Job-file contract between the Launcher window and the supervisor.
// Generic: describes ANY local dev project ("target"), not a specific app.
//
// Shape on disk (pretty JSON):
// {
//   "dir": "C:\\path\\to\\project",
//   "script": "dev",
//   "requestedAt": 1727...,
//   "last": { "dir": "...", "port": 3000 },
//   "updatedAt": 1727...
// }
//
// The launcher writes {dir, script, requestedAt, last:{dir, port:null}}.
// The supervisor validates, spawns `npm run <script>` in dir, then fills
// last.port once the dev server answers (used by smart-skip next launch).
// Lenient parsing: Neutralino's readFile was observed returning JSON-encoded
// text on Windows, so unwrap defensively (mirrors launcher/resources/main.js).

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const JOB_FILENAME = 'target.json';

export function defaultJobFilePath(env = process.env, platform = process.platform) {
  if (env.INSPECTOR_JOB_FILE) return env.INSPECTOR_JOB_FILE;
  if (platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'design-inspector', JOB_FILENAME);
  }
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'design-inspector', JOB_FILENAME);
}

export function lenientJsonParse(text) {
  let value = text;
  let last = null;
  for (let i = 0; i < 3; i++) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === last) break;
    last = trimmed;
    try {
      value = JSON.parse(trimmed);
    } catch {
      break;
    }
  }
  return value;
}

export async function readJobFile(path, fs = { readFile }) {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = lenientJsonParse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeJobFile(path, patch, fs = { readFile, writeFile, mkdir }) {
  const current = (await readJobFile(path, fs)) || {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const SCRIPT_RE = /^[A-Za-z0-9:_-]+$/;

/** Validate a start request. Returns {ok, error?}. Never throws. */
export function validateJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, error: 'empty-job' };
  const { dir, script } = job;
  if (typeof dir !== 'string' || dir.trim() === '') {
    return { ok: false, error: 'missing-dir' };
  }
  if (typeof script !== 'string' || !SCRIPT_RE.test(script)) {
    return { ok: false, error: 'bad-script' };
  }
  if (!existsSync(dir)) return { ok: false, error: 'dir-not-found' };
  if (!existsSync(join(dir, 'package.json'))) {
    return { ok: false, error: 'no-package-json' };
  }
  return { ok: true };
}

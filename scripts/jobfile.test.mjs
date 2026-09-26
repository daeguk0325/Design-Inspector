import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultJobFilePath,
  lenientJsonParse,
  readJobFile,
  validateJob,
  writeJobFile,
} from './jobfile.mjs';

function tempProject(withPkg = true) {
  const dir = mkdtempSync(join(tmpdir(), 'insp-job-'));
  if (withPkg) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'probe-target', scripts: { dev: 'serve' } }),
    );
  }
  return dir;
}

describe('lenientJsonParse', () => {
  it('parses plain JSON', () => {
    expect(lenientJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps JSON-encoded text (launcher readFile quirk)', () => {
    const inner = JSON.stringify({ dir: 'C:\\proj', port: 3000 });
    expect(lenientJsonParse(JSON.stringify(inner))).toEqual({
      dir: 'C:\\proj',
      port: 3000,
    });
  });

  it('returns non-JSON input untouched instead of throwing', () => {
    expect(lenientJsonParse('{bad')).toBe('{bad');
    expect(lenientJsonParse('')).toBe('');
  });
});

describe('validateJob', () => {
  it('accepts a real project dir with an allowlisted script', () => {
    const dir = tempProject();
    expect(validateJob({ dir, script: 'dev' })).toEqual({ ok: true });
  });

  it('rejects command injection in the script name', () => {
    const dir = tempProject();
    for (const bad of ['dev && rm -rf /', 'dev;calc', 'dev|cat', '', 'my script', '../x']) {
      expect(validateJob({ dir, script: bad }).ok).toBe(false);
    }
  });

  it('rejects missing dirs and dirs without package.json', () => {
    expect(validateJob({ dir: 'C:\\definitely\\not\\here-12345', script: 'dev' }).ok).toBe(false);
    expect(validateJob({ dir: tempProject(false), script: 'dev' }).ok).toBe(false);
    expect(validateJob(null).ok).toBe(false);
  });
});

describe('job file roundtrip', () => {
  it('writes, reads back, and merges patches', async () => {
    const dir = tempProject();
    const path = join(dir, 'sub', 'target.json');
    await writeJobFile(path, { dir, script: 'dev', requestedAt: 5 });
    const back = await readJobFile(path);
    expect(back).toMatchObject({ dir, script: 'dev' });
    await writeJobFile(path, { last: { dir, port: 3000 } });
    expect(await readJobFile(path)).toMatchObject({
      dir,
      last: { dir, port: 3000 },
    });
  });

  it('returns null for missing or corrupt files', async () => {
    expect(await readJobFile(join(tempProject(), 'nope.json'))).toBeNull();
  });
});

describe('defaultJobFilePath', () => {
  it('prefers the explicit env override', () => {
    expect(
      defaultJobFilePath({ INSPECTOR_JOB_FILE: 'C:\\x\\job.json' }, 'win32'),
    ).toBe('C:\\x\\job.json');
  });

  it('uses APPDATA on Windows and XDG config elsewhere', () => {
    expect(defaultJobFilePath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toContain(
      'design-inspector',
    );
    expect(defaultJobFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' }, 'linux')).toBe(
      join('/tmp/xdg', 'design-inspector', 'target.json'),
    );
  });
});

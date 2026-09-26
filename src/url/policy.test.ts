// URL policy tests (§14.2): explicit allow-list.
import { describe, expect, it } from 'vitest';
import { isMateriallyDifferentTarget, validateTargetUrl } from './policy.ts';

describe('validateTargetUrl', () => {
  const good = [
    'http://localhost:3000',
    'http://localhost:3000/path?q=1#h',
    'https://127.0.0.1:5173/',
    'http://127.23.45.67:3000/',
    'http://[::1]:3000/',
    'http://0.0.0.0:3000/',
    'http://192.168.1.20:3000/app',
    'http://10.0.0.5:3000/',
    'http://172.20.0.2:3000/',
    'http://vera.local:3000/',
    'http://app.localhost:4000/a/b?x=1#y',
  ];
  for (const u of good) {
    it(`accepts ${u}`, () => {
      expect(validateTargetUrl(u).ok).toBe(true);
    });
  }

  const bad = [
    '',
    'notaurl',
    'ftp://localhost/file',
    'file:///etc/passwd',
    'https://example.com/',
    'http://192.168.1.1.evil.com/',
    'http://10.0.0.3000/',
  ];
  for (const u of bad) {
    it(`rejects ${u || '(empty)'}`, () => {
      expect(validateTargetUrl(u).ok).toBe(false);
    });
  }
});

describe('isMateriallyDifferentTarget', () => {
  it('detects origin and path changes', () => {
    expect(isMateriallyDifferentTarget('http://localhost:3000/a', 'http://localhost:3000/b')).toBe(true);
    expect(isMateriallyDifferentTarget('http://localhost:3000/a', 'http://localhost:3001/a')).toBe(true);
    expect(
      isMateriallyDifferentTarget('http://localhost:3000/a?x=1', 'http://localhost:3000/a?x=2'),
    ).toBe(false);
  });
});

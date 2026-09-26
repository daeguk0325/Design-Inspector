import { describe, expect, it } from 'vitest';
import { parseInspectorTokenFromSearch, parseTargetFromSearch, stripTargetParam } from './fromQuery.ts';

describe('parseTargetFromSearch', () => {
  it('accepts an encoded local target URL', () => {
    expect(
      parseTargetFromSearch('?target=' + encodeURIComponent('http://localhost:3000/')),
    ).toBe('http://localhost:3000/');
  });

  it('rejects remote URLs (allowlist enforced)', () => {
    expect(
      parseTargetFromSearch('?target=' + encodeURIComponent('https://example.com/')),
    ).toBeNull();
  });

  it('returns null when absent, empty, or malformed', () => {
    expect(parseTargetFromSearch('')).toBeNull();
    expect(parseTargetFromSearch('?foo=1')).toBeNull();
    expect(parseTargetFromSearch('?target=')).toBeNull();
    expect(parseTargetFromSearch('?target=notaurl')).toBeNull();
  });

  it('ignores sibling params', () => {
    expect(
      parseTargetFromSearch('?a=1&target=' + encodeURIComponent('http://127.0.0.1:4000/x') + '&b=2'),
    ).toBe('http://127.0.0.1:4000/x');
  });
});

describe('parseInspectorTokenFromSearch', () => {
  it('accepts only a 256-bit base64url handoff token', () => {
    const token = 'a'.repeat(43);
    expect(parseInspectorTokenFromSearch(`?inspectorToken=${token}`)).toBe(token);
    expect(parseInspectorTokenFromSearch('?inspectorToken=short')).toBeNull();
  });
});

describe('stripTargetParam', () => {
  it('removes handoff parameters while keeping the rest', () => {
    expect(
      stripTargetParam(
        'http://127.0.0.1:5173/?target=http%3A%2F%2F127.0.0.1%3A3000&inspectorFrame=http%3A%2F%2F127.0.0.1%3A43123&inspectorToken=' + 'a'.repeat(43) + '&a=1',
      ),
    ).toBe('http://127.0.0.1:5173/?a=1');
  });
});

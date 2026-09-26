import { describe, expect, it } from 'vitest';
import { citationLabel, citationMarker, parseCitationMarkers } from './citationMarker.ts';

describe('citationMarker', () => {
  it('wraps the number in braces and parentheses', () => {
    expect(citationMarker(1)).toBe('({1})');
    expect(citationMarker(12)).toBe('({12})');
  });

  it('labels a tag that has no number yet', () => {
    expect(citationLabel('PrimaryButton')).toBe('({PrimaryButton})');
  });
});

describe('parseCitationMarkers', () => {
  it('returns a single text run when there is no marker', () => {
    expect(parseCitationMarkers('make this roomier')).toEqual([
      { kind: 'text', text: 'make this roomier' },
    ]);
  });

  it('returns nothing for an empty string', () => {
    expect(parseCitationMarkers('')).toEqual([]);
  });

  it('splits a sentence around a marker and keeps the original token', () => {
    expect(parseCitationMarkers('make this roomier ({1}) please')).toEqual([
      { kind: 'text', text: 'make this roomier ' },
      { kind: 'citation', number: 1, raw: '({1})' },
      { kind: 'text', text: ' please' },
    ]);
  });

  it('handles several markers, including adjacent ones', () => {
    expect(parseCitationMarkers('({1}) and ({2})')).toEqual([
      { kind: 'citation', number: 1, raw: '({1})' },
      { kind: 'text', text: ' and ' },
      { kind: 'citation', number: 2, raw: '({2})' },
    ]);
    expect(parseCitationMarkers('({1})({2})')).toEqual([
      { kind: 'citation', number: 1, raw: '({1})' },
      { kind: 'citation', number: 2, raw: '({2})' },
    ]);
  });

  it('keeps a marker at the very start and the very end as its own segment', () => {
    expect(parseCitationMarkers('({1}) go')).toEqual([
      { kind: 'citation', number: 1, raw: '({1})' },
      { kind: 'text', text: ' go' },
    ]);
    expect(parseCitationMarkers('go ({1})')).toEqual([
      { kind: 'text', text: 'go ' },
      { kind: 'citation', number: 1, raw: '({1})' },
    ]);
  });

  it('leaves parenthesised numbering alone, which Korean writing is full of', () => {
    // The braces are part of the token, so an ordinary enumerated list is text.
    expect(parseCitationMarkers('우선순위 (1) 여백, (2) 대비')).toEqual([
      { kind: 'text', text: '우선순위 (1) 여백, (2) 대비' },
    ]);
  });

  it('leaves template and object syntax alone', () => {
    expect(parseCitationMarkers('{{ count }} and {1}')).toEqual([
      { kind: 'text', text: '{{ count }} and {1}' },
    ]);
  });

  it('rejects zero and unbounded numbers', () => {
    expect(parseCitationMarkers('({0})')).toEqual([{ kind: 'text', text: '({0})' }]);
    expect(parseCitationMarkers('({123})')).toEqual([{ kind: 'text', text: '({123})' }]);
  });

  it('is not affected by a previous call, which a shared /g regex would be', () => {
    const first = parseCitationMarkers('({1})');
    const second = parseCitationMarkers('({2})');
    expect(first[0]).toMatchObject({ number: 1 });
    expect(second[0]).toMatchObject({ number: 2 });
  });

  it('round-trips what the marker function produced', () => {
    const text = `make ${citationMarker(1)} and ${citationMarker(2)} more compact`;
    const segments = parseCitationMarkers(text);
    expect(segments.filter((s) => s.kind === 'citation')).toHaveLength(2);
    expect(text).toBe('make ({1}) and ({2}) more compact');
  });
});

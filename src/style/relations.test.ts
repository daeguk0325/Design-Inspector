// Box relations between cited elements (§9e): arithmetic over measured
// geometry, and the wording that keeps it from becoming a stacking guess.

import { describe, expect, it } from 'vitest';
import { findBoxOverlaps, formatBoxOverlaps } from './relations.ts';
import type { CitableBox } from './relations.ts';
import type { StyleFactsGeometry } from '../protocol/types.ts';

function box(x: number, y: number, width: number, height: number): StyleFactsGeometry {
  return { x, y, width, height };
}

function citation(displayNumber: number, geometry: StyleFactsGeometry | undefined): CitableBox {
  return { displayNumber, geometry };
}

describe('findBoxOverlaps', () => {
  it('reports a partial overlap against the smaller box', () => {
    // A 200x100 bar and a 100x100 badge sitting over its right end: the shared
    // rect is 50x100, which is half the badge and a quarter of the bar.
    const overlaps = findBoxOverlaps([citation(1, box(0, 0, 200, 100)), citation(2, box(150, 0, 100, 100))]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.a).toBe(1);
    expect(overlaps[0]?.b).toBe(2);
    expect(overlaps[0]?.intersection).toEqual({ x: 150, y: 0, width: 50, height: 100 });
    expect(overlaps[0]?.ofSmaller).toBe(50);
  });

  it('reads full containment as 100% of the smaller box', () => {
    const overlaps = findBoxOverlaps([citation(1, box(0, 0, 300, 200)), citation(2, box(50, 50, 40, 20))]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.intersection).toEqual({ x: 50, y: 50, width: 40, height: 20 });
    expect(overlaps[0]?.ofSmaller).toBe(100);
  });

  it('does not count boxes that only touch along an edge', () => {
    // A shared edge is not occlusion: the intersection rect would have zero
    // area, and reporting "0% overlap" for every adjacent row on a page would
    // bury the real overlaps.
    const sideBySide = findBoxOverlaps([citation(1, box(0, 0, 100, 40)), citation(2, box(100, 0, 100, 40))]);
    const stacked = findBoxOverlaps([citation(1, box(0, 0, 100, 40)), citation(2, box(0, 40, 100, 40))]);
    expect(sideBySide).toEqual([]);
    expect(stacked).toEqual([]);
  });

  it('finds nothing to compare in a single citation', () => {
    expect(findBoxOverlaps([citation(1, box(0, 0, 100, 40))])).toEqual([]);
    expect(findBoxOverlaps([])).toEqual([]);
  });

  it('skips a box with no area, or none at all, instead of dividing by zero', () => {
    const zeroArea = findBoxOverlaps([citation(1, box(0, 0, 0, 0)), citation(2, box(0, 0, 100, 40))]);
    const zeroWidth = findBoxOverlaps([citation(1, box(0, 0, 0, 40)), citation(2, box(0, 0, 100, 40))]);
    const missing = findBoxOverlaps([citation(1, undefined), citation(2, box(0, 0, 100, 40))]);
    expect(zeroArea).toEqual([]);
    expect(zeroWidth).toEqual([]);
    expect(missing).toEqual([]);
    // A collapsed box is not an excuse to skip the box that is still measurable.
    const others = findBoxOverlaps([
      citation(1, undefined),
      citation(2, box(0, 0, 100, 40)),
      citation(3, box(50, 0, 100, 40)),
    ]);
    expect(others).toHaveLength(1);
    expect(others[0]?.a).toBe(2);
    expect(others[0]?.b).toBe(3);
  });

  it('emits each pair once, in ascending citation order', () => {
    // Citation numbers are display numbers, not array positions, so they are
    // the tie-break the prompt line and the model both see.
    const overlaps = findBoxOverlaps([
      citation(7, box(0, 0, 100, 100)),
      citation(3, box(50, 50, 100, 100)),
      citation(5, box(0, 0, 100, 100)),
    ]);
    expect(overlaps.map((overlap) => [overlap.a, overlap.b])).toEqual([
      [7, 3],
      [7, 5],
      [3, 5],
    ]);
  });

  it('emits at most one entry per pair, so four boxes give at most six', () => {
    // Four identical boxes overlap each other completely: the widest possible
    // answer, which is also the case where a double-count bug would show up.
    const overlaps = findBoxOverlaps([
      citation(1, box(0, 0, 100, 100)),
      citation(2, box(0, 0, 100, 100)),
      citation(3, box(0, 0, 100, 100)),
      citation(4, box(0, 0, 100, 100)),
    ]);
    expect(overlaps).toHaveLength(6);
    const pairs = overlaps.map((overlap) => `${overlap.a}-${overlap.b}`);
    expect(new Set(pairs).size).toBe(6);
    expect(overlaps.every((overlap) => overlap.ofSmaller === 100)).toBe(true);
  });

  it('rounds the share of the smaller box to a whole percent', () => {
    // A 90x100 badge over the right end of a 300x100 bar: 30x100 of a 9000px
    // badge is a third, which the prompt must not quote as a fraction the
    // measurement does not have.
    const overlaps = findBoxOverlaps([citation(1, box(0, 0, 300, 100)), citation(2, box(270, 0, 90, 100))]);
    expect(overlaps[0]?.intersection).toEqual({ x: 270, y: 0, width: 30, height: 100 });
    expect(Number.isInteger(overlaps[0]?.ofSmaller)).toBe(true);
    expect(overlaps[0]?.ofSmaller).toBe(33);
  });
});

describe('formatBoxOverlaps', () => {
  const OVERLAP = findBoxOverlaps([citation(1, box(0, 0, 200, 100)), citation(2, box(150, 0, 100, 100))]);

  it('returns null when there is nothing to say', () => {
    expect(formatBoxOverlaps([])).toBeNull();
    expect(formatBoxOverlaps(findBoxOverlaps([citation(1, box(0, 0, 100, 40))]))).toBeNull();
  });

  it('names both citation markers, the shared rect, and the share', () => {
    const lines = formatBoxOverlaps(OVERLAP);
    expect(lines).not.toBeNull();
    expect(lines?.[0]).toBe('Measured relations (from the boxes above):');
    const line = lines?.[1] ?? '';
    // Both markers in the prompt's own `({n})` form, so the model can resolve
    // "these two" back to the citation list rather than to a bare number.
    expect(line).toContain('({1})');
    expect(line).toContain('({2})');
    expect(line).toContain('intersect at 150,0 50x100');
    expect(line).toContain('50% of the smaller box');
  });

  it('states that paint order was not measured, so the model cannot claim which is in front', () => {
    // This sentence is the module's honesty guarantee. The Bridge omits
    // `z-index` and `position` whenever they equal their computed default and
    // sends no stacking data at all, so "the badge covers the text" is not a
    // measurement. Without this line a box intersection gets reported as
    // occlusion, which is the one answer a designer will act on and cannot be
    // true. If this assertion ever fails, do not delete it: the wording is the
    // contract, and a shorter version is a regression.
    const line = formatBoxOverlaps(OVERLAP)?.[1] ?? '';
    expect(line).toContain('Paint order was not measured');
    expect(line).toContain('which of them is in front is unknown');
  });

  it('emits one indented line per overlap under a single heading', () => {
    const lines = formatBoxOverlaps(
      findBoxOverlaps([
        citation(1, box(0, 0, 100, 100)),
        citation(2, box(50, 50, 100, 100)),
        citation(3, box(0, 0, 100, 100)),
      ]),
    ) ?? [];
    // Three pairs overlap here, so a heading plus one line each.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('Measured relations (from the boxes above):');
    expect(lines[1]?.startsWith('  ')).toBe(true);
    expect(lines[2]?.startsWith('  ')).toBe(true);
    expect(lines[3]?.startsWith('  ')).toBe(true);
    expect(lines[1]).toContain('({1}) and ({2})');
    expect(lines[2]).toContain('({1}) and ({3})');
    expect(lines[3]).toContain('({2}) and ({3})');
  });
});

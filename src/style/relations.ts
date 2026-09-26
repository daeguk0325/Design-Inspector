// Relations between cited elements (§9e).
//
// The Bridge already measures each element's box, and the app already holds
// those boxes for every citation, so the one question a designer actually asks
// across two elements — do these two overlap? — is arithmetic over state we
// have. No new bridge message, no new protocol surface.
//
// What is deliberately NOT here: which element is on top. `z-index` and
// `position` are allow-listed CSS *values*, not stacking data, and the Bridge
// omits both whenever they equal their computed default; no ancestor carries
// geometry, and paint order is not in the payload at all. Answering "the badge
// covers the text" from a rect intersection would be a guess wearing a
// measurement's clothes, so the overlap is reported and the stacking question
// is left explicitly open.

import { citationMarker } from '../citationMarker.ts';
import type { StyleFactsGeometry } from '../protocol/types.ts';

export interface CitableBox {
  /** The canonical citation number, as the prompt shows it. */
  displayNumber: number;
  geometry: StyleFactsGeometry | undefined;
}

export interface BoxOverlap {
  a: number;
  b: number;
  /** The intersecting rectangle, in the same viewport coordinates. */
  intersection: StyleFactsGeometry;
  /** Overlap area divided by the smaller box's area, 0..1. */
  ofSmaller: number;
}

function intersection(a: StyleFactsGeometry, b: StyleFactsGeometry): StyleFactsGeometry | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** A zero-area box cannot occlude anything and would divide by zero. */
function hasArea(box: StyleFactsGeometry): boolean {
  return box.width > 0 && box.height > 0;
}

export function findBoxOverlaps(citations: readonly CitableBox[]): BoxOverlap[] {
  const overlaps: BoxOverlap[] = [];
  for (let i = 0; i < citations.length; i += 1) {
    const first = citations[i];
    if (first?.geometry === undefined || !hasArea(first.geometry)) continue;
    for (let j = i + 1; j < citations.length; j += 1) {
      const second = citations[j];
      if (second?.geometry === undefined || !hasArea(second.geometry)) continue;
      const shared = intersection(first.geometry, second.geometry);
      if (shared === null) continue;
      const area = shared.width * shared.height;
      const smaller = Math.min(
        first.geometry.width * first.geometry.height,
        second.geometry.width * second.geometry.height,
      );
      overlaps.push({
        a: first.displayNumber,
        b: second.displayNumber,
        intersection: shared,
        // Rounded to whole percent: a fraction like 0.3333 invites the model to
        // quote a precision the measurement does not have.
        ofSmaller: Math.round((area / smaller) * 100),
      });
    }
  }
  return overlaps;
}

/**
 * Prompt lines for the overlaps, or null when there are none. The wording names
 * the limit instead of hiding it, so the model reports a box intersection
 * rather than claiming to know what is in front.
 */
export function formatBoxOverlaps(overlaps: readonly BoxOverlap[]): string[] | null {
  if (overlaps.length === 0) return null;
  const lines = overlaps.map(
    (overlap) =>
      `${citationMarker(overlap.a)} and ${citationMarker(overlap.b)} boxes intersect at ` +
      `${overlap.intersection.x},${overlap.intersection.y} ` +
      `${overlap.intersection.width}x${overlap.intersection.height} — ${overlap.ofSmaller}% of the smaller box. ` +
      'Paint order was not measured, so which of them is in front is unknown.',
  );
  return ['Measured relations (from the boxes above):', ...lines.map((line) => `  ${line}`)];
}

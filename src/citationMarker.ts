/**
 * The inline citation marker, in one place.
 *
 * Tags and sentences are interleaved in the composer, so a tag has to reach the
 * model as a reference the model can tie back to a component, and it has to be
 * recognisable again when the sent message is rendered.
 *
 * The shape `({1})` is deliberate:
 *
 * - It belongs to no language or template syntax. `{{1}}` would, because Vue,
 *   Angular, Liquid and Handlebars all own `{{ }}` — and a request about a Vue
 *   template is exactly when that collision would bite.
 * - It reads as a parenthetical, which is what it is: an aside naming the
 *   component the words around it refer to. `make this ({1}) roomier` still
 *   parses as English or Korean prose.
 * - The braces are part of the token, so the pattern never matches ordinary
 *   parenthesised numbering. Korean technical writing is full of `우선순위 (1)
 *   여백, (2) 대비`, and a bare `(\d+)` pattern would swallow those as
 *   citations.
 */

export function citationMarker(number: number): string {
  return `({${number}})`;
}

/** A marker for a tag that has no display number yet. */
export function citationLabel(label: string): string {
  return `({${label}})`;
}

/**
 * The whole token, braces included, and a non-zero one or two digit number.
 *
 * Built per call rather than shared: a module-level `/g` regex carries
 * `lastIndex` between uses, which turns a second `test()` into a silent miss.
 */
function markerPattern(): RegExp {
  return /\(\{([1-9]\d?)\}\)/g;
}

export type MessageSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'citation'; readonly number: number; readonly raw: string };

/**
 * Splits text into plain runs and citation markers.
 *
 * A marker is only meaningful against a set of known citations, so this reports
 * what it found and leaves the decision to the caller: the chat renders a chip
 * when the number matches a citation of that message and falls back to the
 * original text when it does not, so a marker the user typed by hand is never
 * silently swallowed.
 */
export function parseCitationMarkers(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(markerPattern())) {
    const start = match.index;
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) });
    segments.push({ kind: 'citation', number: Number(match[1]), raw: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

export type ComposerSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'attachment'; readonly selectionId: string };

/** Resolves a tag to the citation reference the model will understand, e.g. `[1]`. */
export type ReferenceResolver = (selectionId: string) => string | null;

const WORD = /[0-9A-Za-z\uac00-\ud7a3]/;

/**
 * The text actually sent to the model, with every tag rendered in place as its
 * citation reference.
 *
 * Tags and sentences are interleaved ("make [1] and [2] more compact"), so the
 * reference has to land where the user wrote it — dropping the tag instead
 * left the model guessing which "it" a pronoun referred to. The numbers match
 * the `Inspected UI citations:` block built at transmission, which is what lets
 * the model tie the two together.
 */
export function composePlainText(
  segments: readonly ComposerSegment[],
  reference?: ReferenceResolver,
): string {
  let text = '';
  let afterMarker = false;
  for (const segment of segments) {
    if (segment.type === 'text') {
      if (afterMarker && WORD.test(segment.text[0] ?? '')) text += ' ';
      text += segment.text;
      afterMarker = false;
      continue;
    }
    const marker = reference?.(segment.selectionId) ?? '';
    if (marker.length === 0) continue;
    // "make[1]and" and "[1][2]" both read as one token to the model, so the
    // references are spaced out from the words and from each other.
    if (text.length > 0 && (afterMarker || WORD.test(text[text.length - 1] ?? ''))) text += ' ';
    text += marker;
    afterMarker = true;
  }
  return text;
}

/**
 * Only what the user actually typed, tags excluded.
 *
 * The send gate uses this: a message of nothing but tags carries no request, so
 * it stays unsendable even though the transmitted text is `[1] [2]`.
 */
export function composeTypedText(segments: readonly ComposerSegment[]): string {
  let text = '';
  for (const segment of segments) {
    if (segment.type === 'text') text += segment.text;
  }
  return text;
}

export function hasSendableText(text: string): boolean {
  return text.trim().length > 0;
}

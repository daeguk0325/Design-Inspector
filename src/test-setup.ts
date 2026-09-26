/**
 * jsdom shims for the DOM APIs Lexical touches but jsdom does not implement.
 *
 * When Lexical scrolls the caret into view it measures the current range, which
 * is a `Range` in a text node and a `DOMRect` in every browser. jsdom has
 * `Element.getBoundingClientRect` but not `Range.getBoundingClientRect`, so the
 * measurement throws inside a microtask and is reported as an unhandled error
 * that has nothing to do with the test being run.
 */

const EMPTY_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

const emptyRect = (): DOMRect => ({ ...EMPTY_RECT });

if (typeof Range !== 'undefined') {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (typeof proto['getBoundingClientRect'] !== 'function') {
    proto['getBoundingClientRect'] = emptyRect;
  }
  if (typeof proto['getClientRects'] !== 'function') {
    proto['getClientRects'] = () =>
      Object.assign([], { item: () => null }) as unknown as DOMRectList;
  }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

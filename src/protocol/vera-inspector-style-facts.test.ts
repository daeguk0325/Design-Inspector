// Style facts (§9e), tested at the Bridge boundary.
//
// jsdom's getComputedStyle returns '' for most longhands — font-size,
// line-height, position, border-radius, transform, filter, z-index, gap,
// opacity, letter-spacing among them. Every test here therefore supplies an
// explicit per-property fixture; without one these assertions would pass while
// measuring nothing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanStyleValue, collectStyleFacts, normalizeStyleColor } from '../../bridge/vera-inspector-bridge.ts';
import type { StyleFacts, StyleFactsDerived } from './types.ts';

function stubComputedStyle(values: Record<string, string>): void {
  stubComputedStylePerElement(() => values);
}

/**
 * The backdrop walk calls `getComputedStyle` once per element in the chain, so
 * one flat fixture cannot describe it: "this element is transparent, that
 * ancestor is not" needs a per-element answer keyed on the element itself.
 */
function stubComputedStylePerElement(resolve: (el: Element) => Record<string, string>): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (el) =>
      ({
        getPropertyValue: (property: string) => resolve(el)[property] ?? '',
      }) as unknown as CSSStyleDeclaration,
  );
}

/**
 * jsdom has no layout, so every box reports 0x0 and nothing can overflow.
 * Defining the four numbers is the only way to reach the overflow branch at
 * all — `configurable` so a later define in the same test can replace one.
 */
function setLayout(
  el: Element,
  box: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number },
): void {
  for (const [name, value] of Object.entries(box)) {
    Object.defineProperty(el, name, { value, configurable: true });
  }
}

/** jsdom ships no FontFaceSet, so `document.fonts` has to be installed by hand. */
function stubDocumentFonts(fonts: unknown): void {
  Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
}

/** A FontFaceSet stand-in: iterable, plus the `check` the Bridge asks. */
function fontFaceSet(faces: string[], check: (query: string) => boolean): unknown {
  return Object.assign(
    faces.map((family) => ({ family })),
    { check },
  );
}

function element(tag = 'div', testId = 'subject'): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute('data-testid', testId);
  document.body.appendChild(node);
  return node;
}

/** jsdom reports every rect as empty, so the overlap sampler needs a real box. */
function setRect(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top }) as DOMRect;
}

/**
 * jsdom has no `elementsFromPoint` at all, and the Bridge checks for it before
 * using it. Installed as a configurable own property so the afterEach can take
 * it away again — `vi.stubGlobal` would replace the whole `document`, which every
 * other test in this file needs.
 */
function setElementsFromPoint(hits: () => Element[]): void {
  Object.defineProperty(document, 'elementsFromPoint', {
    value: hits,
    configurable: true,
    writable: true,
  });
}

function propsOf(facts: StyleFacts | undefined): Record<string, string> {
  if (!facts) throw new Error('expected style facts');
  return facts.props;
}

function derivedOf(facts: StyleFacts | undefined): StyleFactsDerived | undefined {
  if (!facts) throw new Error('expected style facts');
  return facts.derived;
}

/**
 * Paints a solid sRGB colour, standing in for a real canvas. The setter
 * deliberately ignores unparseable values, because that is what a real
 * `CanvasRenderingContext2D` does: it keeps the previous colour, which is how
 * the Bridge detects a value it could not parse.
 */
const CANVAS_ACCEPTED = /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\([^)]*\)|hsla?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\))$/i;

function stubCanvas(rgba: [number, number, number, number]): string[] {
  const painted: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let fillStyle = '#000000';
    return {
      clearRect: () => undefined,
      fillRect: () => undefined,
      set fillStyle(value: string) {
        painted.push(value);
        if (CANVAS_ACCEPTED.test(value.trim())) fillStyle = value.trim();
      },
      get fillStyle(): string {
        return fillStyle;
      },
      getImageData: () => ({ data: new Uint8ClampedArray(rgba) }),
    } as unknown as CanvasRenderingContext2D;
  });
  return painted;
}

afterEach(() => {
  vi.restoreAllMocks();
  // Every FontFaceSet in this file is installed by a test, and jsdom has none of
  // its own to fall back on, so leaving one behind would let a `fallback` verdict
  // decide the next test's fontLoad.
  Reflect.deleteProperty(document, 'fonts');
  // Same reasoning: an `elementsFromPoint` left behind would put a caveat on the
  // next test's contrast for a reason that has nothing to do with it.
  Reflect.deleteProperty(document, 'elementsFromPoint');
  document.body.innerHTML = '';
});

describe('cleanStyleValue', () => {
  it('collapses whitespace, strips control characters, and bounds the length', () => {
    expect(cleanStyleValue('  a\u0000b\u001bc  ', 120)).toBe('a b c');
    expect(cleanStyleValue('a\n\tb', 120)).toBe('a b');
    const long = cleanStyleValue('x'.repeat(400), 120);
    expect(long).toHaveLength(120);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('returns null for a value that is only whitespace', () => {
    expect(cleanStyleValue('   ', 120)).toBeNull();
    expect(cleanStyleValue('\u0000', 120)).toBeNull();
  });
});

describe('normalizeStyleColor', () => {
  it('passes hex through in lowercase', () => {
    expect(normalizeStyleColor('#AABBCC')).toBe('#aabbcc');
    expect(normalizeStyleColor('#abc')).toBe('#abc');
  });

  it('passes rgb and rgba through with normalized spacing', () => {
    expect(normalizeStyleColor('rgb(30,  30, 30)')).toBe('rgb(30, 30, 30)');
    expect(normalizeStyleColor('RGBA(1,2,3,0.5)')).toBe('rgba(1,2,3,0.5)');
  });

  it('recognises transparency in both spellings', () => {
    expect(normalizeStyleColor('transparent')).toBe('transparent');
    expect(normalizeStyleColor('rgba(0, 0, 0, 0)')).toBe('transparent');
  });

  it('converts a modern color syntax to sRGB hex through the canvas', () => {
    const painted = stubCanvas([0x38, 0x84, 0xff, 0xff]);
    expect(normalizeStyleColor('oklch(0.7 0.1 200)')).toBe('#3884ff');
    expect(painted).toContain('oklch(0.7 0.1 200)');
  });

  it('converts color(srgb …) the same way', () => {
    stubCanvas([0x11, 0x22, 0x33, 0xff]);
    expect(normalizeStyleColor('color(srgb 0.1 0.2 0.3)')).toBe('#112233');
  });

  it('reports a painted zero alpha as transparent', () => {
    stubCanvas([0, 0, 0, 0]);
    expect(normalizeStyleColor('color(srgb 0 0 0 / 0)')).toBe('transparent');
  });

  it('returns null when there is no canvas, instead of passing the text through', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(normalizeStyleColor('oklch(0.7 0.1 200)')).toBeNull();
  });

  it('refuses a black-on-black readback rather than reporting a fabricated #000000', () => {
    stubCanvas([0, 0, 0, 255]);
    // An unparseable value leaves fillStyle at the black sentinel painted
    // first, so the readback cannot be trusted to describe the input.
    expect(normalizeStyleColor('not-a-color-at-all')).toBeNull();
    // A value that really is black is still reported.
    expect(normalizeStyleColor('black')).toBe('#000000');
  });

  it('rejects an over-long or empty input before touching the canvas', () => {
    const painted = stubCanvas([1, 2, 3, 255]);
    expect(normalizeStyleColor('x'.repeat(500))).toBeNull();
    expect(normalizeStyleColor('   ')).toBeNull();
    expect(painted).toEqual([]);
  });
});

describe('collectStyleFacts', () => {
  it('reports every property family and omits the per-property defaults', () => {
    stubComputedStyle({
      color: 'rgb(30, 30, 30)',
      'background-color': 'rgb(56, 132, 255)',
      'border-top-color': 'rgb(0, 0, 0)',
      'border-bottom-color': 'rgb(0, 0, 0)',
      'font-family': 'Pretendard',
      'font-size': '14px',
      'font-weight': '600',
      'line-height': '21.7px',
      'padding-top': '12px',
      'padding-right': '16px',
      'padding-bottom': '12px',
      'padding-left': '16px',
      'margin-top': '0px',
      'border-top-width': '0px',
      'border-radius': '8px',
      'box-shadow': '0 1px 2px rgba(0, 0, 0, 0.2)',
      display: 'inline-flex',
      'align-items': 'center',
      gap: '8px',
      position: 'relative',
      'z-index': '2',
      'transition-duration': '0.2s',
      transform: 'none',
    });
    expect(propsOf(collectStyleFacts(element()))).toEqual({
      color: 'rgb(30, 30, 30)',
      'background-color': 'rgb(56, 132, 255)',
      'font-family': 'Pretendard',
      'font-size': '14px',
      'font-weight': '600',
      'line-height': '21.7px',
      'padding-top': '12px',
      'padding-right': '16px',
      'padding-bottom': '12px',
      'padding-left': '16px',
      'border-radius': '8px',
      'box-shadow': '0 1px 2px rgba(0, 0, 0, 0.2)',
      display: 'inline-flex',
      'align-items': 'center',
      gap: '8px',
      position: 'relative',
      'z-index': '2',
      'transition-duration': '0.2s',
    });
  });

  it('keeps a non-default display and drops the block default', () => {
    stubComputedStyle({ display: 'block' });
    expect(propsOf(collectStyleFacts(element()))).not.toHaveProperty('display');
    vi.restoreAllMocks();
    stubComputedStyle({ display: 'inline-flex' });
    expect(propsOf(collectStyleFacts(element()))).toMatchObject({ display: 'inline-flex' });
  });

  it('reports a transparent background rather than hiding it', () => {
    // Reversed deliberately. Treating rgba(0,0,0,0) as a default reads well
    // ("every element would claim a transparent background") but a real 9B run
    // over a real page showed the cost: with the background filtered out, the
    // model had to answer "버튼 2 배경색 확인 불가" about a ghost button whose
    // background was plainly knowable. The filter manufactured a gap.
    stubComputedStyle({ 'background-color': 'rgba(0, 0, 0, 0)' });
    expect(propsOf(collectStyleFacts(element()))).toEqual({ 'background-color': 'transparent' });
  });

  it('omits border, outline and caret colours that merely echo the text colour', () => {
    // Their CSS initial value is currentColor, so getComputedStyle resolves
    // them to the element's own text colour — an echo, not an authored choice.
    // Found by capturing a real page: six of these were ~40% of every record.
    stubComputedStyle({
      color: 'rgb(30, 30, 30)',
      'border-top-color': 'rgb(30, 30, 30)',
      'border-right-color': 'rgb(30, 30, 30)',
      'border-bottom-color': 'rgb(30, 30, 30)',
      'border-left-color': 'rgb(30, 30, 30)',
      'outline-color': 'rgb(30, 30, 30)',
      'caret-color': 'rgb(30, 30, 30)',
    });
    expect(propsOf(collectStyleFacts(element()))).toEqual({ color: 'rgb(30, 30, 30)' });
  });

  it('keeps a border colour that differs from the text colour', () => {
    stubComputedStyle({
      color: 'rgb(30, 30, 30)',
      'border-top-color': 'rgb(255, 0, 0)',
    });
    expect(propsOf(collectStyleFacts(element()))).toEqual({
      color: 'rgb(30, 30, 30)',
      'border-top-color': 'rgb(255, 0, 0)',
    });
  });

  it('reports only the first font family, not the whole fallback stack', () => {
    // Measured: the resolved stack cost 95 characters, 14% of one component's
    // evidence block, and the model quoted it back instead of reasoning.
    stubComputedStyle({
      'font-family': 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"',
    });
    expect(propsOf(collectStyleFacts(element()))).toEqual({ 'font-family': 'ui-sans-serif' });
  });

  it('keeps a single authored family intact', () => {
    stubComputedStyle({ 'font-family': 'Pretendard' });
    expect(propsOf(collectStyleFacts(element()))['font-family']).toBe('Pretendard');
    vi.restoreAllMocks();
    stubComputedStyle({ 'font-family': '"Apple SD Gothic Neo", system-ui' });
    expect(propsOf(collectStyleFacts(element()))['font-family']).toBe('"Apple SD Gothic Neo"');
  });

  it('drops a box-shadow whose every layer is fully transparent', () => {
    // Measured: three such layers cost 100 characters, 15% of the block, and
    // drew nothing at all.
    stubComputedStyle({
      'box-shadow': 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px',
    });
    expect(propsOf(collectStyleFacts(element()))).toEqual({});
  });

  it('keeps a box-shadow with one visible layer', () => {
    stubComputedStyle({
      'box-shadow': 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.2) 0px 1px 2px 0px',
    });
    const shadow = propsOf(collectStyleFacts(element()))['box-shadow'];
    expect(shadow).toContain('0.2');
  });

  it('keeps a visible transparent-keyword shadow layer', () => {
    stubComputedStyle({ 'box-shadow': 'transparent 0px 0px 0px 0px, rgb(0, 0, 0) 0px 2px 4px 0px' });
    expect(propsOf(collectStyleFacts(element()))).toHaveProperty('box-shadow');
    vi.restoreAllMocks();
    stubComputedStyle({ 'box-shadow': 'transparent 0px 0px 0px 0px' });
    expect(propsOf(collectStyleFacts(element()))).toEqual({});
  });

  it('uses the real CSS initial values for fill, stroke and transition-duration', () => {
    // fill/stroke initial to black, not none; transition-duration initial to 0s.
    // Getting these wrong put fill: rgb(0,0,0) on every HTML element.
    stubComputedStyle({ fill: 'rgb(0, 0, 0)', stroke: 'rgb(0, 0, 0)', 'transition-duration': '0s' });
    expect(propsOf(collectStyleFacts(element()))).toEqual({});
    vi.restoreAllMocks();
    stubComputedStyle({ fill: 'rgb(255, 0, 0)', 'transition-duration': '0.2s' });
    expect(propsOf(collectStyleFacts(element()))).toEqual({
      fill: 'rgb(255, 0, 0)',
      'transition-duration': '0.2s',
    });
  });

  it('omits zero margins and border widths', () => {
    stubComputedStyle({
      'margin-top': '0px',
      'margin-right': '0em',
      'margin-bottom': '0',
      'margin-left': '0.0px',
      'border-top-width': '0px',
      'border-right-width': '0px',
      'border-bottom-width': '0px',
      'border-left-width': '0px',
    });
    expect(propsOf(collectStyleFacts(element()))).toEqual({});
  });

  it('keeps zero padding, because there it is a measurement worth reporting', () => {
    stubComputedStyle({
      'padding-top': '0px',
      'padding-right': '0px',
      'padding-bottom': '0px',
      'padding-left': '0px',
    });
    expect(propsOf(collectStyleFacts(element()))).toEqual({
      'padding-top': '0px',
      'padding-right': '0px',
      'padding-bottom': '0px',
      'padding-left': '0px',
    });
  });

  it('converts colors inside the record, not only in isolation', () => {
    stubCanvas([0x38, 0x84, 0xff, 0xff]);
    stubComputedStyle({ color: 'oklch(0.7 0.1 200)' });
    expect(propsOf(collectStyleFacts(element()))).toEqual({ color: '#3884ff' });
  });

  it('bounds a value at 120 characters and strips control characters', () => {
    stubComputedStyle({ 'font-family': `Pretendard${'x'.repeat(400)}`, 'box-shadow': 'a\u0000b\u001bc' });
    const props = propsOf(collectStyleFacts(element()));
    expect(props['font-family']).toHaveLength(120);
    expect(props['box-shadow']).toBe('a b c');
  });

  it('reports geometry, aria-label, the ancestor chain, and the tag name', () => {
    stubComputedStyle({ display: 'flex' });
    document.body.innerHTML = '';
    const header = document.createElement('header');
    header.className = 'nav';
    const main = document.createElement('main');
    const button = document.createElement('button');
    button.setAttribute('data-testid', 'checkout');
    button.setAttribute('aria-label', '주문하기');
    main.appendChild(button);
    header.appendChild(main);
    document.body.appendChild(header);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 24.4, y: 180.6, width: 120, height: 40,
      top: 180, left: 24, right: 144, bottom: 220,
      toJSON: () => ({}),
    });
    expect(collectStyleFacts(button)).toMatchObject({
      geometry: { x: 24, y: 181, width: 120, height: 40 },
      label: '주문하기',
      ancestors: ['main', 'header.nav'],
      tagName: 'button',
    });
  });

  it('caps the ancestor chain at three levels', () => {
    stubComputedStyle({ display: 'flex' });
    document.body.innerHTML = '';
    let parent = document.body;
    for (let depth = 0; depth < 6; depth += 1) {
      const node = document.createElement('section');
      parent.appendChild(node);
      parent = node;
    }
    const leaf = document.createElement('span');
    parent.appendChild(leaf);
    expect(collectStyleFacts(leaf)?.ancestors).toHaveLength(3);
  });

  it('falls back to element text and bounds the label at 80 characters', () => {
    stubComputedStyle({ display: 'flex' });
    const target = element('button', 'labelled');
    target.textContent = '결제'.repeat(200);
    const label = collectStyleFacts(target)?.label;
    expect(label).toHaveLength(80);
    expect(label?.endsWith('…')).toBe(true);
  });

  it('returns a minimal record when nothing measurable is available', () => {
    stubComputedStyle({});
    const target = element();
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, left: 0, right: 0, bottom: 0,
      toJSON: () => ({}),
    });
    // No properties, but the geometry and the tag are still worth having.
    expect(collectStyleFacts(target)).toEqual({
      props: {},
      geometry: { x: 0, y: 0, width: 0, height: 0 },
      tagName: 'div',
    });
  });

  it('survives an element whose measured geometry is not finite', () => {
    stubComputedStyle({ display: 'flex' });
    const target = element();
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => {
      throw new Error('detached');
    });
    const facts = collectStyleFacts(target);
    expect(facts).toBeDefined();
    expect(facts).not.toHaveProperty('geometry');
  });

  it('never emits a property outside the allowlist', () => {
    stubComputedStyle({ display: 'flex', 'background-image': 'url(https://evil.test/x.png)' });
    expect(propsOf(collectStyleFacts(element()))).toEqual({ display: 'flex' });
  });
});

// ---- Derived measurements -------------------------------------------------
// The contrast numbers below are the WCAG 2.x reference values, so each one can
// be checked by hand: L is the sRGB relative luminance, and the ratio is
// (L_lighter + 0.05) / (L_darker + 0.05). Nothing here is a model estimate, and
// the reason these are asserted on exact digits is that a ratio which moves
// between runs is not a measurement — the same two colours came back as 4.80:1
// once and 3.2:1 the next.

/** Black on white at 14px: the fixed fixture for the whole contrast block. */
const ON_WHITE = { color: '#000000', 'background-color': '#ffffff', 'font-size': '14px' };

describe('derived contrast', () => {
  it('reports the 21:1 ceiling with the 4.5 minimum for normal text', () => {
    stubComputedStyle({ ...ON_WHITE, 'font-weight': '400' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toEqual({
      ratio: 21,
      min: 4.5,
      pass: true,
      large: false,
      background: '#ffffff',
    });
  });

  it('splits the 4.5 threshold exactly where WCAG does: #767676 passes, #777777 does not', () => {
    // The two neighbouring greys are the whole argument for computing this here
    // rather than asking for it. 4.54 and 4.48 are one channel apart and sit on
    // either side of AA, so a verdict that comes out the same for both is wrong.
    stubComputedStyle({ color: '#767676', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({ ratio: 4.54, pass: true });
    vi.restoreAllMocks();
    stubComputedStyle({ color: '#777777', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({ ratio: 4.48, min: 4.5, pass: false });
  });

  it('reports a ratio of 1 for text painted in its own backdrop colour', () => {
    stubComputedStyle({ color: '#ffffff', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toEqual({
      ratio: 1,
      min: 4.5,
      pass: false,
      large: false,
      background: '#ffffff',
    });
  });

  it('drops the minimum to 3 for large text and keeps 4.5 for normal text', () => {
    // WCAG 1.4.3: 3:1 is the threshold at 18pt (24px), or 14pt bold (18.66px).
    // #777777 is chosen because it clears the large-text minimum and misses the
    // normal one, so the same colours flip the verdict on size alone.
    //
    // The sizes are unitless because the parser that feeds the threshold is a
    // bare number parser. The next test is about what that costs.
    stubComputedStyle({ color: '#777777', 'background-color': '#ffffff', 'font-size': '24', 'font-weight': '400' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({
      ratio: 4.48,
      large: true,
      min: 3,
      pass: true,
    });
    vi.restoreAllMocks();
    stubComputedStyle({ color: '#777777', 'background-color': '#ffffff', 'font-size': '14', 'font-weight': '700' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({
      ratio: 4.48,
      large: false,
      min: 4.5,
      pass: false,
    });
  });

  it('counts 19px bold as large text, because the threshold is 18.66px and not 19', () => {
    stubComputedStyle({ color: '#777777', 'background-color': '#ffffff', 'font-size': '19', 'font-weight': '700' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({ large: true, min: 3 });
  });

  it('reads the px font-size a browser actually sends, so large text counts as large', () => {
    // getComputedStyle answers '24px', not '24'. A bare-number parser reads that
    // as zero, which would silently demote every real heading to normal text and
    // apply the 4.5 minimum to it.
    stubComputedStyle({ color: '#777777', 'background-color': '#ffffff', 'font-size': '24px', 'font-weight': '700' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({
      ratio: 4.48,
      large: true,
      min: 3,
      pass: true,
    });
  });

  it('adds a shadow caveat while keeping the ratio it measured', () => {
    // The ancestor walk looks for a background colour, and a box-shadow is not
    // one, so a shadowed button produced a confident verdict about a backdrop
    // that is not what is behind the glyphs. The number is still the best flat
    // estimate, so it stays and the doubt travels with it.
    stubComputedStyle({
      color: 'rgb(30, 30, 30)',
      'background-color': 'rgb(56, 132, 255)',
      'font-size': '14px',
      'font-weight': '600',
      'box-shadow': '0 2px 8px rgba(0, 0, 0, 0.35)',
    });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toEqual({
      ratio: 4.69,
      min: 4.5,
      pass: true,
      large: false,
      background: '#3884ff',
      caveat: 'shadow',
    });
  });

  it('finds a shadow on an ancestor, not only on the text element', () => {
    const parent = element('section', 'ancestor');
    const child = element('span', 'subject');
    parent.appendChild(child);
    stubComputedStylePerElement((el): Record<string, string> =>
      el === child
        ? { color: '#767676', 'background-color': '#ffffff', 'font-size': '14px', 'box-shadow': 'none' }
        : { 'background-color': 'transparent', 'box-shadow': '0 1px 2px rgb(0, 0, 0)' },
    );
    expect(derivedOf(collectStyleFacts(child))?.contrast).toMatchObject({
      ratio: 4.54,
      pass: true,
      caveat: 'shadow',
    });
  });

  it('treats a fully transparent shadow as no shadow', () => {
    // A transition or a reset leaves `rgba(0,0,0,0)` behind, which paints
    // nothing. Reporting a caveat for it would cry wolf on every element.
    stubComputedStyle({
      color: '#767676',
      'background-color': '#ffffff',
      'font-size': '14px',
      'box-shadow': '0 0 0 1px rgba(0, 0, 0, 0)',
    });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).not.toHaveProperty('caveat');
  });

  it('adds an overlap caveat when another element is painted over the text box', () => {
    // Siblings are invisible to the ancestor walk by construction, so a badge on
    // top of a label used to produce a confident, wrong ratio.
    const label = element('span', 'subject');
    const badge = element('i', 'badge');
    setRect(label, { left: 0, top: 0, width: 120, height: 20 });
    setElementsFromPoint(() => [badge, label]);
    stubComputedStyle({ color: '#767676', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(label))?.contrast).toMatchObject({
      ratio: 4.54,
      pass: true,
      caveat: 'overlap',
    });
  });

  it('reports no overlap when the hit lands on the text element or a descendant', () => {
    const label = element('span', 'subject');
    const inner = document.createElement('em');
    label.appendChild(inner);
    setRect(label, { left: 0, top: 0, width: 120, height: 20 });
    setElementsFromPoint(() => [inner]);
    stubComputedStyle({ color: '#767676', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(label))?.contrast).not.toHaveProperty('caveat');
  });

  it('reports no overlap when the hit is an ancestor of the text', () => {
    // An ancestor holding the text is the normal case, not an intruder.
    const wrapper = element('div', 'wrapper');
    const label = element('span', 'subject');
    wrapper.appendChild(label);
    setRect(label, { left: 0, top: 0, width: 120, height: 20 });
    setElementsFromPoint(() => [wrapper]);
    stubComputedStyle({ color: '#767676', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(label))?.contrast).not.toHaveProperty('caveat');
  });

  it('keeps the verdict when a 0x0 box makes overlap unanswerable', () => {
    // jsdom has no layout, so every rect is empty. The detector must decline
    // rather than invent a caveat from a box it could not measure.
    setElementsFromPoint(() => [element('i', 'badge')]);
    stubComputedStyle({ color: '#767676', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({ ratio: 4.54, pass: true });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).not.toHaveProperty('caveat');
  });

  it('keeps the verdict when the browser has no elementsFromPoint', () => {
    // The API is checked before use, so a runtime without it degrades to no
    // caveat rather than to an exception mid-measurement.
    // @ts-expect-error deleting an optional DOM method for the fallback path
    delete document.elementsFromPoint;
    const label = element('span', 'subject');
    setRect(label, { left: 0, top: 0, width: 120, height: 20 });
    stubComputedStyle({ color: '#767676', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(label))?.contrast).toMatchObject({ ratio: 4.54, pass: true });
  });

  it('names the backdrop it measured against, for the brand blue probe button', () => {
    // #1e1e1e on #3884ff: L = 0.0130 and L = 0.2456, so the ratio is
    // 0.2956 / 0.0630 = 4.69. At 14px/600 this is normal text, so AA's 4.5
    // applies and it passes — the number is reported rather than guessed.
    stubComputedStyle({
      color: 'rgb(30, 30, 30)',
      'background-color': 'rgb(56, 132, 255)',
      'font-size': '14px',
      'font-weight': '600',
    });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toEqual({
      ratio: 4.69,
      min: 4.5,
      pass: true,
      large: false,
      background: '#3884ff',
    });
  });

  it('composites a translucent text colour over the backdrop before measuring', () => {
    // Source-over in sRGB, which is what the compositor actually does: black at
    // 50% over white paints #808080-ish, not black. Reading the alpha off and
    // reporting 21:1 for text that is barely legible would be the worst kind of
    // wrong, so the composite happens first: 0.5 alpha lands on 127.5 grey.
    stubComputedStyle({ color: 'rgba(0, 0, 0, 0.5)', 'background-color': '#ffffff', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({
      ratio: 3.98,
      min: 4.5,
      pass: false,
      background: '#ffffff',
    });
  });

  it('decides pass from the rounded ratio, so the printed number and the verdict cannot disagree', () => {
    // Black at 53.45098% over white composites to 118.70 grey, which scores
    // 4.4972 unrounded — genuinely under the 4.5 minimum. Printed to two
    // decimals that is 4.5, and `pass` is read off the printed number, so the
    // model is never shown a 4.5 next to a `pass: false`.
    stubComputedStyle({
      color: 'rgba(0, 0, 0, 0.5345098)',
      'background-color': '#ffffff',
      'font-size': '14px',
    });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({
      ratio: 4.5,
      min: 4.5,
      pass: true,
    });
  });
});

describe('derived contrast backdrop', () => {
  it('walks past a fully transparent element to the first opaque ancestor', () => {
    // The chain is the answer to "what is behind this text?", and a transparent
    // wrapper is not an answer to it — only the first colour that actually
    // paints is.
    const wrapper = element('section', 'card');
    const label = document.createElement('span');
    wrapper.appendChild(label);
    stubComputedStylePerElement((el): Record<string, string> => {
      if (el === label) return { color: '#000000', 'background-color': 'rgba(0, 0, 0, 0)', 'font-size': '14px' };
      if (el === wrapper) return { 'background-color': '#0000ff' };
      return {};
    });
    // L(#0000ff) = 0.0722, so (0.1222)/(0.05) = 2.44: black on pure blue is a
    // failure, which is the point of naming the backdrop that produced it.
    expect(derivedOf(collectStyleFacts(label))?.contrast).toMatchObject({
      background: '#0000ff',
      ratio: 2.44,
      pass: false,
    });
  });

  it('resolves to the browser canvas, white, when nothing in the chain is opaque', () => {
    // A page that paints no background is white, and that is the browser's own
    // default rather than a guess about the design.
    stubComputedStyle({ color: '#000000', 'font-size': '14px' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({
      ratio: 21,
      background: '#ffffff',
    });
  });

  it('reads background-image: none as no image at all', () => {
    stubComputedStyle({ ...ON_WHITE, 'background-image': 'none' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toMatchObject({ ratio: 21 });
  });

  it('reports unmeasurable when the element paints a background image', () => {
    // A gradient is not a flat colour, so any single backdrop number would be a
    // statement about a colour the text is not drawn on. `unmeasurable` is the
    // real answer, and it is what stops the gap being filled with a number.
    stubComputedStyle({ ...ON_WHITE, 'background-image': 'linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toEqual({ unmeasurable: true });
  });

  it('reports unmeasurable when an ancestor paints a background image', () => {
    // The check covers the whole chain, not just the element: an image behind a
    // transparent card is still the backdrop of the text inside the card. The
    // label therefore has to be transparent for the walk to reach the wrapper.
    const wrapper = element('section', 'card');
    const label = document.createElement('span');
    wrapper.appendChild(label);
    stubComputedStylePerElement((el): Record<string, string> =>
      el === wrapper
        ? { 'background-image': 'url(https://cdn.test/hero.png)' }
        : { color: '#000000', 'background-color': 'rgba(0, 0, 0, 0)', 'font-size': '14px' },
    );
    expect(derivedOf(collectStyleFacts(label))?.contrast).toEqual({ unmeasurable: true });
  });

  it('reports unmeasurable below full opacity, on the element or on an ancestor', () => {
    // Opacity is a blend against whatever is behind it, including a backdrop
    // outside the element, so the flat-colour arithmetic underneath no longer
    // describes what is on screen.
    stubComputedStyle({ ...ON_WHITE, opacity: '0.5' });
    expect(derivedOf(collectStyleFacts(element()))?.contrast).toEqual({ unmeasurable: true });
    vi.restoreAllMocks();
    const wrapper = element('section', 'card');
    const label = document.createElement('span');
    wrapper.appendChild(label);
    stubComputedStylePerElement((el): Record<string, string> =>
      el === wrapper ? { 'background-color': '#ffffff', opacity: '0.6' } : { color: '#000000', 'font-size': '14px' },
    );
    expect(derivedOf(collectStyleFacts(label))?.contrast).toEqual({ unmeasurable: true });
  });

  it('omits the contrast key entirely when the text colour cannot be read', () => {
    // A measurement that could not be taken is not an answer, and it is not
    // `unmeasurable` either — that word is reserved for a backdrop the Bridge
    // looked at and found to be an image. The font key is present so the
    // assertion can see that `derived` itself survived the omission.
    stubDocumentFonts(fontFaceSet(['Pretendard'], () => false));
    stubComputedStyle({ 'font-family': 'Pretendard' });
    expect(derivedOf(collectStyleFacts(element()))).toEqual({ fontLoad: 'fallback' });
  });

  it('omits the contrast key for text painted in a fully transparent colour', () => {
    stubDocumentFonts(fontFaceSet(['Pretendard'], () => false));
    stubComputedStyle({ color: 'rgba(0, 0, 0, 0)', 'font-family': 'Pretendard' });
    expect(derivedOf(collectStyleFacts(element()))).toEqual({ fontLoad: 'fallback' });
  });
});

describe('derived truncation', () => {
  it('reports truncated when the content overflows its box horizontally', () => {
    stubComputedStyle(ON_WHITE);
    const target = element();
    setLayout(target, { clientWidth: 120, clientHeight: 40, scrollWidth: 400, scrollHeight: 40 });
    expect(derivedOf(collectStyleFacts(target))?.truncated).toBe(true);
  });

  it('reports truncated for a vertical overflow too', () => {
    stubComputedStyle(ON_WHITE);
    const target = element();
    setLayout(target, { clientWidth: 120, clientHeight: 40, scrollWidth: 120, scrollHeight: 200 });
    expect(derivedOf(collectStyleFacts(target))?.truncated).toBe(true);
  });

  it('stays silent when the content fits, and ignores a single pixel of rounding', () => {
    // 121 against 120 is a sub-pixel rounding artefact in every engine, not a
    // clipped label, so the tolerance is one pixel. `false` is the unremarkable
    // state and is never sent — the key's absence is the answer.
    stubComputedStyle(ON_WHITE);
    const target = element();
    setLayout(target, { clientWidth: 120, clientHeight: 40, scrollWidth: 121, scrollHeight: 41 });
    expect(derivedOf(collectStyleFacts(target))).toEqual({
      contrast: { ratio: 21, min: 4.5, pass: true, large: false, background: '#ffffff' },
    });
  });

  it('stays silent when there is no layout to overflow', () => {
    // jsdom reports a zero client box for everything it lays out. Claiming
    // `truncated: true` from a 400px scroll width against a 0px client width
    // would be inventing a measurement, not reporting one.
    stubComputedStyle(ON_WHITE);
    const target = element();
    setLayout(target, { clientWidth: 0, clientHeight: 0, scrollWidth: 400, scrollHeight: 400 });
    expect(derivedOf(collectStyleFacts(target))).not.toHaveProperty('truncated');
  });
});

describe('derived font load', () => {
  it('reports a fallback when the document declares the family but the face never loaded', () => {
    const check = vi.fn(() => false);
    stubDocumentFonts(fontFaceSet(['Pretendard'], check));
    stubComputedStyle({ 'font-family': 'Pretendard', 'font-weight': '600' });
    expect(derivedOf(collectStyleFacts(element()))).toEqual({ fontLoad: 'fallback' });
    // The question asked is the one the CSS asks — this weight, at a size.
    expect(check).toHaveBeenCalledWith('600 16px Pretendard');
  });

  it('stays silent when the declared family did load', () => {
    stubDocumentFonts(fontFaceSet(['Pretendard'], () => true));
    stubComputedStyle({ ...ON_WHITE, 'font-family': 'Pretendard' });
    expect(derivedOf(collectStyleFacts(element()))?.fontLoad).toBeUndefined();
  });

  it('says nothing about a family the document never declares', () => {
    // A local or system font has no load event that could have failed, so a
    // false `check` on it is not a failed webfont and must not be reported as
    // one. This is the difference between "fell back" and "was never ours".
    const check = vi.fn(() => false);
    stubDocumentFonts(fontFaceSet(['Pretendard'], check));
    stubComputedStyle({ ...ON_WHITE, 'font-family': 'Arial' });
    expect(derivedOf(collectStyleFacts(element()))?.fontLoad).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('asks about the 400 weight when the document states none', () => {
    const check = vi.fn(() => false);
    stubDocumentFonts(fontFaceSet(['Pretendard'], check));
    stubComputedStyle({ 'font-family': 'Pretendard' });
    expect(derivedOf(collectStyleFacts(element()))?.fontLoad).toBe('fallback');
    expect(check).toHaveBeenCalledWith('400 16px Pretendard');
  });

  it('reports unknown when the document has no font set at all', () => {
    // jsdom ships no FontFaceSet, so this is the default path here, and it is
    // also what a hardened embedding sees. Unknown is honest; `fallback` is not.
    Reflect.deleteProperty(document, 'fonts');
    stubComputedStyle({ 'font-family': 'Pretendard' });
    expect(derivedOf(collectStyleFacts(element()))?.fontLoad).toBe('unknown');
  });

  it('reports unknown when the font set cannot be walked or asked', () => {
    stubDocumentFonts({
      [Symbol.iterator]: () => {
        throw new Error('denied');
      },
    });
    stubComputedStyle({ 'font-family': 'Pretendard' });
    expect(derivedOf(collectStyleFacts(element()))?.fontLoad).toBe('unknown');
    vi.restoreAllMocks();
    stubDocumentFonts(
      fontFaceSet(['Pretendard'], () => {
        throw new Error('denied');
      }),
    );
    stubComputedStyle({ 'font-family': 'Pretendard' });
    expect(derivedOf(collectStyleFacts(element()))?.fontLoad).toBe('unknown');
  });
});

describe('derived on the record', () => {
  it('keeps a record whose only content is a derived measurement', () => {
    // The liveness gate drops a record with no props, no geometry, no label and
    // no ancestors. `truncated` is the one derived key that can carry a record
    // alone — a contrast verdict needs a `color`, and a colour is a property, so
    // it is never the only thing there is. Without `derived` in that gate this
    // record would be dropped and a clipped label never reported at all.
    stubComputedStyle({});
    const target = element();
    // `tagName` is the one thing a real record always carries, so it is taken
    // away here to make the gate's other clauses genuinely false: an element
    // that cannot name itself, cannot be measured, and says nothing else.
    Object.defineProperty(target, 'tagName', {
      configurable: true,
      get() {
        throw new Error('detached');
      },
    });
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => {
      throw new Error('detached');
    });
    setLayout(target, { clientWidth: 120, clientHeight: 40, scrollWidth: 400, scrollHeight: 40 });
    expect(collectStyleFacts(target)).toEqual({ props: {}, derived: { truncated: true } });
  });
});

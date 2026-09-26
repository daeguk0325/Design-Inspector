import { describe, expect, it } from 'vitest';
import {
  MAX_CSS_DECLARATIONS,
  MAX_CSS_VALUE_CHARS,
  VISUAL_ONLY_CSS_PROPERTIES,
  validateCssDeclaration,
  validateDeclarations,
} from './cssPolicy.ts';

const ok = (property: string, value: string) => validateCssDeclaration(property, value).ok;
const reason = (property: string, value: string) => {
  const check = validateCssDeclaration(property, value);
  return check.ok ? 'ok' : check.reason;
};

const VALID_SAMPLES: Record<string, string> = {
  'aspect-ratio': '16 / 9',
  'background-color': 'hsl(210, 40%, 96%)',
  'border-bottom-left-radius': '4px',
  'border-bottom-right-radius': '6px',
  'border-bottom-color': '#ccc',
  'border-bottom-style': 'dotted',
  'border-bottom-width': '1px',
  'border-left-color': 'transparent',
  'border-left-style': 'solid',
  'border-left-width': '2px',
  'border-radius': '2px 4px 8px 12px',
  'border-right-color': 'currentColor',
  'border-right-style': 'dashed',
  'border-right-width': '0',
  'border-style': 'solid solid dashed none',
  'border-top-color': 'rgb(0 0 0 / 40%)',
  'border-top-left-radius': '0',
  'border-top-right-radius': '0px',
  'border-top-style': 'none',
  'border-top-width': '1px',
  'border-width': '1px 2px 3px 4px',
  'box-shadow': '0 1px 2px rgba(16, 24, 40, 0.08)',
  color: 'steelblue',
  'font-family': '"Pretendard", "Noto Sans KR", system-ui, sans-serif',
  'font-size': 'larger',
  'font-style': 'italic',
  'font-weight': 'bold',
  gap: '12px',
  height: '48px',
  'letter-spacing': '0.02em',
  'line-height': 'normal',
  margin: '0',
  'margin-bottom': '-4px',
  'margin-left': '12px',
  'margin-right': '12px',
  'margin-top': '8px',
  'max-height': '200px',
  'max-width': '100%',
  'min-height': '32px',
  'min-width': '120px',
  opacity: '1',
  overflow: 'hidden',
  padding: '0',
  'padding-bottom': '4px',
  'padding-left': '4px',
  'padding-right': '4px',
  'padding-top': '4px',
  'row-gap': '8px',
  'column-gap': '16px',
  'text-align': 'center',
  'text-decoration-line': 'underline line-through',
  'text-overflow': 'ellipsis',
  'text-transform': 'uppercase',
  'vertical-align': 'middle',
  'white-space': 'pre-wrap',
  width: '100%',
};

describe('visual-only CSS allowlist', () => {
  it('exposes a sorted, frozen, lower-case property allowlist', () => {
    expect(VISUAL_ONLY_CSS_PROPERTIES.length).toBeGreaterThan(20);
    expect([...VISUAL_ONLY_CSS_PROPERTIES]).toEqual([...VISUAL_ONLY_CSS_PROPERTIES].sort());
    for (const property of VISUAL_ONLY_CSS_PROPERTIES) {
      expect(property).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    expect(Object.isFrozen(VISUAL_ONLY_CSS_PROPERTIES)).toBe(true);
  });

  it('never allowlists layout, stacking, animation, content or custom properties', () => {
    for (const property of VISUAL_ONLY_CSS_PROPERTIES) {
      expect(property.startsWith('--')).toBe(false);
      // gap/row-gap/column-gap are deliberately absent from this list: they are
      // pure spacing and were allowlisted so a spacing request stops getting its
      // whole proposal rejected.
      expect(property).not.toMatch(
        /^(position|top|right|bottom|left|inset|z-index|display|float|clear|content|transform|filter|background|background-image|transition|animation|grid|grid-template|grid-template-columns|grid-template-rows|grid-auto-flow|grid-column|grid-row|flex|flex-basis|flex-direction|flex-flow|flex-grow|flex-shrink|flex-wrap|order|align-content|align-items|align-self|justify-content|justify-items|justify-self|place-content|place-items|place-self|cursor|pointer-events|user-select|will-change|contain|content-visibility|writing-mode|direction|box-sizing|visibility|list-style|transition-[a-z-]+|animation-[a-z-]+)$/,
      );
    }
  });

  it('accepts spacing between items', () => {
    const check = validateDeclarations({ gap: '12px', 'row-gap': '8px', 'column-gap': '16px' });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.declarations).toEqual({ gap: '12px', 'row-gap': '8px', 'column-gap': '16px' });
  });

  it('still refuses the flex and grid properties that sit next to gap', () => {
    for (const declarations of [
      { 'flex-direction': 'column' },
      { 'grid-template-columns': '1fr 1fr' },
      { 'justify-content': 'center' },
      { 'align-items': 'center' },
    ]) {
      const check = validateDeclarations(declarations);
      expect(check.ok).toBe(false);
      if (check.ok) continue;
      expect(check.reason).toBe('forbidden-property');
    }
  });

  it('accepts the documented visual declarations and normalizes values', () => {
    const check = validateDeclarations({
      'border-radius': ' 10px ',
      'background-color': '#F0F3F7',
      color: 'rgb(20, 24, 32)',
      'font-size': '14px',
      'font-weight': '600',
      'line-height': '1.5',
      'padding': '8px 12px 8px 12px',
      opacity: '0.9',
      'box-shadow': 'inset 0 0 0 1px rgba(16, 24, 40, 0.08)',
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.declarations).toEqual({
      'border-radius': '10px',
      'background-color': '#F0F3F7',
      color: 'rgb(20, 24, 32)',
      'font-size': '14px',
      'font-weight': '600',
      'line-height': '1.5',
      padding: '8px 12px 8px 12px',
      opacity: '0.9',
      'box-shadow': 'inset 0 0 0 1px rgba(16, 24, 40, 0.08)',
    });
    expect(Object.isFrozen(check.declarations)).toBe(true);
  });

  it('accepts every allowlisted property with a valid value', () => {
    expect([...VISUAL_ONLY_CSS_PROPERTIES].sort()).toEqual(Object.keys(VALID_SAMPLES).sort());
    for (const [property, value] of Object.entries(VALID_SAMPLES)) {
      expect({ property, ok: ok(property, value) }).toEqual({ property, ok: true });
    }
  });

  it('rejects non-object declaration maps', () => {
    for (const input of [null, undefined, [], 'color:red', 7, true, new Map(), new Date()]) {
      expect(validateDeclarations(input)).toEqual({ ok: false, reason: 'not-an-object' });
    }
    const nullPrototype = Object.create(null) as Record<string, string>;
    nullPrototype['color'] = 'red';
    expect(validateDeclarations(nullPrototype).ok).toBe(true);
  });

  it('bounds the number of declarations', () => {
    const properties = Object.keys(VALID_SAMPLES);
    const build = (count: number): Record<string, string> => {
      const map: Record<string, string> = {};
      for (const property of properties.slice(0, count)) {
        map[property] = VALID_SAMPLES[property] ?? '';
      }
      return map;
    };
    expect(validateDeclarations(build(MAX_CSS_DECLARATIONS)).ok).toBe(true);
    expect(validateDeclarations(build(MAX_CSS_DECLARATIONS + 1))).toEqual({
      ok: false,
      reason: 'too-many-declarations',
    });
  });

  it('rejects raw selectors and at-rules in property position', () => {
    expect(reason('#app .card', 'color: red')).toBe('invalid-property-name');
    expect(reason('.card', 'color: red')).toBe('invalid-property-name');
    expect(reason('*', 'color: red')).toBe('invalid-property-name');
    expect(reason('color;color', 'red')).toBe('invalid-property-name');
    expect(reason('', 'red')).toBe('empty-property');
    expect(reason('COLOR', 'red')).toBe('invalid-property-name');
    expect(reason(' color', 'red')).toBe('invalid-property-name');
    expect(reason('color', '.card { color: red; }')).toBe('forbidden-token');
    expect(reason('color', '@media (min-width: 100px)')).toBe('forbidden-token');
  });

  it('rejects denied layout, stacking, animation and content properties', () => {
    for (const property of [
      'position',
      'z-index',
      'display',
      'flex',
      'flex-direction',
      'grid-template-columns',
      'animation-name',
      'transition-duration',
      'content',
      'transform',
      'filter',
      'background-image',
      'pointer-events',
    ]) {
      expect({ property, reason: reason(property, 'none') }).toEqual({
        property,
        reason: 'forbidden-property',
      });
    }
  });

  it('rejects custom properties and vendor properties', () => {
    expect(reason('--accent', '#fff')).toBe('invalid-property-name');
    expect(reason('-webkit-transform', 'none')).toBe('invalid-property-name');
    expect(reason('-ms-filter', 'none')).toBe('invalid-property-name');
    expect(reason('behavior', 'url(x.htc)')).toBe('unknown-property');
  });

  it('rejects !important, comments, escapes and statement injection', () => {
    expect(reason('color', 'red !important')).toBe('forbidden-token');
    expect(reason('color', 'red ! important')).toBe('forbidden-token');
    expect(reason('color', 'red!important')).toBe('forbidden-token');
    expect(reason('background-color', 'red /* note */')).toBe('forbidden-token');
    expect(reason('background-color', '*/**/')).toBe('forbidden-token');
    expect(reason('color', '\\72 ed')).toBe('forbidden-token');
    expect(reason('color', 'red; background: url(https://x.test)')).toBe('forbidden-token');
    expect(reason('color', 'red}')).toBe('forbidden-token');
    expect(reason('color', 'expression(alert(1))')).toBe('forbidden-token');
  });

  it('rejects url, var, calc, env and other function calls', () => {
    expect(reason('background-color', 'url(https://example.test/a.png)')).toBe('forbidden-token');
    expect(reason('background-color', 'URL(https://example.test/a.png)')).toBe('forbidden-token');
    expect(reason('color', 'var(--accent)')).toBe('forbidden-token');
    expect(reason('width', 'calc(100% - 8px)')).toBe('forbidden-token');
    expect(reason('width', 'min(10px, 2em)')).toBe('forbidden-token');
    expect(reason('background-color', 'image-set("a.png" 1x)')).toBe('forbidden-token');
    expect(reason('color', 'attr(data-x)')).toBe('forbidden-token');
    expect(reason('width', 'env(safe-area-inset-top)')).toBe('forbidden-token');
  });

  it('rejects data and javascript payloads', () => {
    expect(reason('background-color', 'data:text/html,<script>alert(1)</script>')).toBe(
      'forbidden-token',
    );
    expect(reason('color', 'javascript:alert(1)')).toBe('forbidden-token');
    expect(reason('font-family', '<img src=x onerror=alert(1)>')).toBe('forbidden-token');
  });

  it('bounds value length and type', () => {
    expect(reason('color', `r${'e'.repeat(MAX_CSS_VALUE_CHARS)}d`)).toBe('value-too-long');
    expect(validateCssDeclaration('color', 12 as unknown as string)).toEqual({
      ok: false,
      reason: 'value-not-string',
      property: 'color',
    });
    expect(reason('color', '   ')).toBe('value-empty');
  });

  it('bounds length values', () => {
    expect(ok('width', '0')).toBe(true);
    expect(ok('width', '0px')).toBe(true);
    expect(ok('width', '.5rem')).toBe(true);
    expect(ok('margin-top', '-4px')).toBe(true);
    expect(ok('width', '100%')).toBe(true);
    expect(ok('height', '100vh')).toBe(true);
    expect(reason('width', '4000px')).toBe('ok');
    expect(reason('width', '4001px')).toBe('invalid-value');
    expect(reason('width', '401%')).toBe('invalid-value');
    expect(reason('width', '1')).toBe('invalid-value');
    expect(reason('width', '10')).toBe('invalid-value');
    expect(reason('width', '10px 20px')).toBe('invalid-value');
    expect(reason('width', '10fr')).toBe('invalid-value');
    expect(reason('width', '1e3px')).toBe('invalid-value');
    expect(reason('width', '10 px')).toBe('invalid-value');
    expect(reason('padding', '1px 2px 3px 4px 5px')).toBe('invalid-value');
    expect(ok('padding', '1px 2px 3px 4px')).toBe(true);
    expect(ok('margin', '0 0 8px')).toBe(true);
  });

  it('bounds colors', () => {
    expect(ok('color', '#abc')).toBe(true);
    expect(ok('color', '#abcd')).toBe(true);
    expect(ok('color', '#a1b2c3')).toBe(true);
    expect(ok('color', '#a1b2c3d4')).toBe(true);
    expect(ok('color', 'rgb(0, 128, 255)')).toBe(true);
    expect(ok('color', 'rgba(0, 128, 255, 0.5)')).toBe(true);
    expect(ok('color', 'rgb(0 0 0 / 40%)')).toBe(true);
    expect(ok('color', 'hsl(210, 40%, 96%)')).toBe(true);
    expect(ok('color', 'hsla(210deg, 40%, 96%, 0.4)')).toBe(true);
    expect(ok('color', 'transparent')).toBe(true);
    expect(ok('color', 'currentColor')).toBe(true);
    expect(reason('color', '#abcde')).toBe('invalid-value');
    expect(reason('color', 'rgb(256, 0, 0)')).toBe('invalid-value');
    expect(reason('color', 'rgb(0, 0)')).toBe('invalid-value');
    expect(reason('color', 'rgba(0, 0, 0, 2)')).toBe('invalid-value');
    expect(reason('color', 'rgb(0, 0, 0, 0.5)')).toBe('ok');
    expect(reason('color', 'rgb(0, 0, 0, 0.5, 1)')).toBe('invalid-value');
    expect(reason('color', 'rgba(0, 0, 0)')).toBe('invalid-value');
    expect(reason('color', 'rgb(0, 0, 0 / 0.5)')).toBe('invalid-value');
    expect(ok('color', 'rgb(0 0 0 / 0.5)')).toBe(true);
    expect(reason('color', 'hsl(400, 40%, 50%)')).toBe('invalid-value');
    expect(reason('color', 'hsl(10, 140%, 50%)')).toBe('invalid-value');
    expect(reason('color', 'rgb(0, 0, 0')).toBe('invalid-value');
    expect(reason('color', 'chartreuse-ish')).toBe('invalid-value');
  });

  it('bounds font families, numerics and keyword sets', () => {
    expect(ok('font-family', 'system-ui')).toBe(true);
    expect(ok('font-family', '"Pretendard", sans-serif')).toBe(true);
    expect(ok('font-family', "'Noto Sans KR', 'Malgun Gothic', sans-serif")).toBe(true);
    expect(reason('font-family', 'a, b, c, d, e')).toBe('invalid-value');
    expect(reason('font-family', '"unterminated, sans-serif')).toBe('invalid-value');
    expect(reason('font-family', '')).toBe('value-empty');
    expect(reason('opacity', '1.1')).toBe('invalid-value');
    expect(ok('opacity', '0.35')).toBe(true);
    expect(ok('opacity', '35%')).toBe(true);
    expect(reason('opacity', '-0.1')).toBe('invalid-value');
    expect(ok('font-weight', '500')).toBe(true);
    expect(ok('font-weight', '1')).toBe(true);
    expect(reason('font-weight', '1001')).toBe('invalid-value');
    expect(reason('font-weight', '0')).toBe('invalid-value');
    expect(reason('font-weight', 'heavy')).toBe('invalid-value');
    expect(reason('font-weight', '700.5')).toBe('invalid-value');
    expect(reason('font-weight', '950')).toBe('ok');
    expect(ok('font-weight', '900')).toBe(true);
    expect(reason('line-height', '5')).toBe('invalid-value');
    expect(ok('line-height', '4')).toBe(true);
    expect(reason('font-size', '17')).toBe('invalid-value');
    expect(ok('font-size', '1.05rem')).toBe(true);
    expect(reason('text-align', 'middle')).toBe('invalid-value');
    expect(reason('overflow', 'clip auto')).toBe('invalid-value');
    expect(reason('text-decoration-line', 'none underline')).toBe('invalid-value');
    expect(ok('text-decoration-line', 'underline')).toBe(true);
    expect(reason('vertical-align', 'flex-start')).toBe('invalid-value');
    expect(ok('aspect-ratio', 'auto')).toBe(true);
    expect(ok('aspect-ratio', '1.7778')).toBe(true);
    expect(reason('aspect-ratio', '16/9/2')).toBe('invalid-value');
    expect(reason('aspect-ratio', '16 / 0px')).toBe('invalid-value');
    expect(reason('border-top-style', 'solid dashed')).toBe('invalid-value');
    expect(reason('border-style', 'solid solid solid solid solid')).toBe('invalid-value');
  });

  it('bounds box-shadow layers and members', () => {
    expect(ok('box-shadow', '0 1px 2px rgba(16, 24, 40, 0.08)')).toBe(true);
    expect(ok('box-shadow', 'inset 0 0 0 1px #e5e7eb, 0 8px 24px #00000022')).toBe(true);
    expect(ok('box-shadow', '0 0')).toBe(true);
    expect(reason('box-shadow', '0')).toBe('invalid-value');
    expect(reason('box-shadow', '0 0 0 0 0')).toBe('invalid-value');
    expect(reason('box-shadow', 'a b')).toBe('invalid-value');
    expect(reason('box-shadow', '0 1px 2px, 0 1px 2px, 0 1px 2px, 0 1px 2px, 0 1px 2px')).toBe(
      'invalid-value',
    );
    expect(reason('box-shadow', '0 1px 2px url(https://example.test/a.png)')).toBe(
      'forbidden-token',
    );
  });

  it('reports the offending property on a rejected map', () => {
    expect(validateDeclarations({ color: 'red', display: 'none' })).toEqual({
      ok: false,
      reason: 'forbidden-property',
      property: 'display',
    });
    expect(validateDeclarations({ color: 'red', width: 'calc(1px)' })).toEqual({
      ok: false,
      reason: 'forbidden-token',
      property: 'width',
    });
  });
});

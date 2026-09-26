// Style facts: the app-side half of the §9e contract.
//
// The Bridge extracts `styleFacts` from the live DOM (bridge/vera-inspector-bridge.ts)
// and owns the authoritative allowlist. This module is a deliberately stricter
// second gate: the target page controls the payload, so anything not named here
// is dropped rather than rendered or sent to the model. The duplication between
// the two lists IS the trust boundary.

export const STYLE_FACT_GROUPS = ['color', 'typography', 'box', 'layout', 'motion'] as const;

export type StyleFactGroup = (typeof STYLE_FACT_GROUPS)[number];

export const STYLE_FACT_GROUP_LABEL: Readonly<Record<StyleFactGroup, string>> = Object.freeze({
  color: 'Color',
  typography: 'Typography',
  box: 'Box',
  layout: 'Layout',
  motion: 'Motion',
});

/** Drop order when the per-record budget is exceeded: least useful goes first. */
export const STYLE_FACT_GROUP_DROP_ORDER: readonly StyleFactGroup[] = ['motion', 'layout', 'box', 'typography', 'color'];

/** Longhand only — a shorthand would hide a single differing side. */
const COLOR_PROPS = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'caret-color',
  'fill',
  'stroke',
] as const;

const TYPOGRAPHY_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'text-indent',
] as const;

const BOX_PROPS = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-radius',
  'box-sizing',
  'box-shadow',
] as const;

const LAYOUT_PROPS = [
  'display',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'justify-content',
  'gap',
  'grid-template-columns',
  'position',
  'z-index',
  'overflow',
  'visibility',
  'opacity',
] as const;

const MOTION_PROPS = ['transition-duration', 'animation-name', 'transform', 'filter'] as const;

export const STYLE_FACT_PROPS: Readonly<Record<StyleFactGroup, readonly string[]>> = Object.freeze({
  color: COLOR_PROPS,
  typography: TYPOGRAPHY_PROPS,
  box: BOX_PROPS,
  layout: LAYOUT_PROPS,
  motion: MOTION_PROPS,
});

export const STYLE_FACT_ALLOWED_PROPS: ReadonlySet<string> = new Set(
  STYLE_FACT_GROUPS.flatMap((group) => STYLE_FACT_PROPS[group]),
);

export const STYLE_FACT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'props',
  'geometry',
  'label',
  'ancestors',
  'tagName',
]);

const PROP_GROUP: ReadonlyMap<string, StyleFactGroup> = new Map(
  STYLE_FACT_GROUPS.flatMap((group) => STYLE_FACT_PROPS[group].map((property) => [property, group] as const)),
);

/** `background-color` → `Background color`, matching the details panel's house style. */
export function styleFactLabel(property: string): string {
  const words = property.split('-');
  const head = words.shift() ?? property;
  const label = [head, ...words].join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function styleFactGroup(property: string): StyleFactGroup | null {
  return PROP_GROUP.get(property) ?? null;
}

/** Properties whose value is a literal color and can back a swatch. */
const COLOR_VALUE_PROPS: ReadonlySet<string> = new Set(COLOR_PROPS);

export function isColorProperty(property: string): boolean {
  return COLOR_VALUE_PROPS.has(property);
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function swatchColor(value: string): string | null {
  return HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : null;
}

// Style facts: sanitize at the state boundary, then format for the model.
//
// Sanitizing here (not only in the Bridge) is deliberate: this is the point
// where untrusted target-controlled strings become persisted app state
// (CitationSnapshot is stored on both user and assistant messages), so the
// same rules `src/protocol/validate.ts` enforces on the wire are applied again
// before anything is kept.

import {
  STYLE_FACT_ALLOWED_KEYS,
  STYLE_FACT_ALLOWED_PROPS,
  STYLE_FACT_GROUPS,
  STYLE_FACT_GROUP_DROP_ORDER,
  styleFactGroup,
} from './properties.ts';
import type { StyleFactGroup } from './properties.ts';
import type { StyleFacts } from '../protocol/types.ts';

export const STYLE_FACT_VALUE_CHARS = 120;
export const STYLE_FACT_LABEL_CHARS = 80;
export const STYLE_FACT_ANCESTOR_DEPTH = 3;
export const STYLE_FACT_SEGMENT_CHARS = 80;
/** Per-record prompt budget. Exceeding it drops whole groups, not characters. */
export const STYLE_FACT_RECORD_CHARS = 1_200;

// Stripping control characters is the point: these values reach the model
// prompt, and a newline or an escape in a style value is an injection seam.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f]/g;
const WHITESPACE = /\s+/g;
const TAG_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ANCESTOR_SEGMENT = /^[a-z][a-z0-9-]{0,31}(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})?$/;
const ZERO_LENGTH = /^0(?:\.0+)?(?:px|em|rem|%|pt|ch|vh|vw|vmin|vmax)?$/;
const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const GEOMETRY_KEYS = ['x', 'y', 'width', 'height'] as const;

function clean(value: string, max: number): string | null {
  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(WHITESPACE, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeProps(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > STYLE_FACT_ALLOWED_PROPS.size) return {};
  const props: Record<string, string> = {};
  for (const [property, raw] of entries) {
    // An unknown key means the payload is not what it claims to be. Refuse the
    // whole map instead of picking pieces out of it.
    if (!STYLE_FACT_ALLOWED_PROPS.has(property)) return {};
    if (typeof raw !== 'string') return {};
    const cleaned = clean(raw, STYLE_FACT_VALUE_CHARS);
    if (cleaned === null) return {};
    props[property] = cleaned;
  }
  return props;
}

function sanitizeGeometry(value: unknown): StyleFacts['geometry'] {
  if (!isRecord(value)) return undefined;
  // Refuse, not trim: this runs on data that already passed the wire
  // validator, so an unexpected key means the payload is not what it claims.
  if (Object.keys(value).length !== GEOMETRY_KEYS.length) return undefined;
  for (const key of Object.keys(value)) {
    if (!GEOMETRY_KEYS.includes(key as (typeof GEOMETRY_KEYS)[number])) return undefined;
  }
  const out = { x: 0, y: 0, width: 0, height: 0 };
  for (const key of GEOMETRY_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    out[key] = Math.round(raw);
  }
  if (out.width < 0 || out.height < 0) return undefined;
  return out;
}

function sanitizeAncestors(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > STYLE_FACT_ANCESTOR_DEPTH) return undefined;
  const chain: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return undefined;
    const cleaned = clean(raw, STYLE_FACT_SEGMENT_CHARS);
    if (cleaned === null || !ANCESTOR_SEGMENT.test(cleaned)) return undefined;
    chain.push(cleaned);
  }
  return chain;
}

function groupProps(
  facts: StyleFacts,
): Array<{ group: StyleFactGroup; property: string; value: string }> {
  const rows: Array<{ group: StyleFactGroup; property: string; value: string }> = [];
  for (const group of STYLE_FACT_GROUPS) {
    for (const [property, value] of Object.entries(facts.props)) {
      if (styleFactGroup(property) === group) rows.push({ group, property, value });
    }
  }
  return rows;
}

function dropGroups(facts: StyleFacts, groups: readonly StyleFactGroup[]): StyleFacts {
  const props: Record<string, string> = {};
  for (const row of groupProps(facts)) {
    if (groups.includes(row.group)) continue;
    props[row.property] = row.value;
  }
  return { ...facts, props };
}

function storedSize(facts: StyleFacts): number {
  try {
    return JSON.stringify(facts).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * CitationSnapshot is persisted on every user and assistant message, so an
 * unbounded record multiplies across a session. Whole groups are dropped
 * before individual values are truncated: a missing `filter` is honest, a
 * half-written one is not.
 */
function fitStorageBudget(facts: StyleFacts): StyleFacts {
  if (storedSize(facts) <= STYLE_FACT_RECORD_CHARS) return facts;
  let dropped: StyleFactGroup[] = [];
  for (const group of STYLE_FACT_GROUP_DROP_ORDER) {
    dropped = [...dropped, group];
    const candidate = dropGroups(facts, dropped);
    if (storedSize(candidate) <= STYLE_FACT_RECORD_CHARS) return candidate;
  }
  return { props: {}, ...(facts.geometry === undefined ? {} : { geometry: facts.geometry }) };
}

export function sanitizeStyleFacts(value: unknown): StyleFacts | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!STYLE_FACT_ALLOWED_KEYS.has(key)) return undefined;
  }
  const props = sanitizeProps(value['props']);
  const geometry = sanitizeGeometry(value['geometry']);
  const ancestors = sanitizeAncestors(value['ancestors']);
  let label: string | undefined;
  if (value['label'] !== undefined) {
    if (typeof value['label'] !== 'string') return undefined;
    label = clean(value['label'], STYLE_FACT_LABEL_CHARS) ?? undefined;
  }
  let tagName: string | undefined;
  if (value['tagName'] !== undefined) {
    if (typeof value['tagName'] !== 'string' || !TAG_NAME.test(value['tagName'])) return undefined;
    tagName = value['tagName'];
  }
  const empty =
    Object.keys(props).length === 0 &&
    geometry === undefined &&
    label === undefined &&
    ancestors === undefined &&
    tagName === undefined;
  if (empty) return undefined;
  return fitStorageBudget({
    props,
    ...(geometry === undefined ? {} : { geometry }),
    ...(label === undefined ? {} : { label }),
    ...(ancestors === undefined ? {} : { ancestors }),
    ...(tagName === undefined ? {} : { tagName }),
  });
}

function sides(props: Record<string, string>, prefix: string): string[] | null {
  const values: string[] = [];
  for (const side of SIDES) {
    const value = props[`${prefix}-${side}`];
    if (value === undefined) return null;
    if (ZERO_LENGTH.test(value)) continue;
    values.push(value);
  }
  if (values.length === 0) return null;
  const [first, second, third, fourth] = values;
  if (first === undefined) return null;
  if (first === second && first === third && first === fourth) return [first];
  if (first === third && second === fourth) return [first, second];
  return values;
}

/** The font longhands, each under its own name so nothing needs decoding. */
function fontLonghands(props: Record<string, string>): string | null {
  const parts: string[] = [];
  for (const property of ['font-weight', 'font-size', 'line-height', 'font-family'] as const) {
    const value = props[property];
    if (value === undefined) continue;
    parts.push(`${property}:${value}`);
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/** Properties already given a dedicated segment in the rendered line. */
const CURATED_PROPS: ReadonlySet<string> = new Set([
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-radius', 'color', 'background-color',
  'font-weight', 'font-size', 'line-height', 'font-family',
]);

/**
 * The facts head/tail use real CSS property names, not a compact shorthand.
 *
 * The shorthand (`box=`, `radius=`, `font=`) was a token saving, and it has
 * cost twice. First the model emitted `box` as a preview-block declaration key,
 * which the validator rejects. Then, with that fixed, a real 9B run showed it
 * quoting the shorthand straight back in its visible answer — `box=12px 16px`,
 * `radius=8px` — which is unreadable to the person the answer is for and is
 * exactly the copy-paste-text complaint the prompt rewrite was meant to end.
 * Real names make the facts and the declaration keys the same vocabulary, so
 * the mapping rule in the system prompt disappears with them.
 */
function factsLines(facts: StyleFacts): string[] {
  const { props } = facts;
  const head: string[] = [];
  const tail: string[] = [];
  const padding = sides(props, 'padding');
  if (padding !== null) head.push(`padding:${padding.join(' ')}`);
  const radius = props['border-radius'];
  if (radius !== undefined && !ZERO_LENGTH.test(radius)) head.push(`border-radius:${radius}`);
  const color = props['color'];
  if (color !== undefined) head.push(`color:${color}`);
  const background = props['background-color'];
  if (background !== undefined) head.push(`background-color:${background}`);
  const font = fontLonghands(props);
  if (font !== null) tail.push(font);
  if (facts.label !== undefined) tail.push(`label="${facts.label}"`);
  if (facts.geometry !== undefined) {
    const { x, y, width, height } = facts.geometry;
    tail.push(`at ${x},${y} ${width}x${height}`);
  }
  if (facts.ancestors !== undefined && facts.ancestors.length > 0) {
    tail.push(`inside ${facts.ancestors.join(' > ')}`);
  }
  // Everything the collector measured but the curated segments did not use —
  // layout and motion, mostly. Dropping it would mean collecting the layout
  // group for nothing.
  const rest = groupProps(facts)
    .filter((row) => !CURATED_PROPS.has(row.property))
    .map((row) => `${row.property}:${row.value}`);
  const lines = [head.join('  '), tail.join('  ')].filter((line) => line.length > 0);
  if (rest.length > 0) lines.push(`style=${rest.join(', ')}`);
  return lines;
}

function blockLines(facts: StyleFacts, marker: string, header: string): string[] {
  return factsLines(facts).map((line, index) =>
    index === 0 ? `${marker} ${header}  ${line}` : `     ${line}`,
  );
}

export interface StyleFactsBlock {
  /** Lines for this record. The caller supplies the marker, so line 0 starts
   *  with the same `({1})` numbering the rest of the prompt uses. */
  lines: string[];
  /** True when whole groups were dropped to stay inside the budget. */
  truncated: boolean;
}

export function formatStyleFacts(
  facts: StyleFacts,
  marker: string,
  fallbackTagName?: string,
): StyleFactsBlock {
  const header = fallbackTagName ?? facts.tagName ?? 'element';
  const emitted = blockLines(facts, marker, header);
  if (emitted.join('\n').length <= STYLE_FACT_RECORD_CHARS) {
    return { lines: emitted, truncated: false };
  }
  let dropped: StyleFactGroup[] = [];
  for (const group of STYLE_FACT_GROUP_DROP_ORDER) {
    dropped = [...dropped, group];
    const candidate = blockLines(dropGroups(facts, dropped), marker, header);
    if (candidate.join('\n').length <= STYLE_FACT_RECORD_CHARS) {
      return { lines: candidate, truncated: true };
    }
  }
  const minimal: StyleFacts = {
    props: {},
    ...(facts.geometry === undefined ? {} : { geometry: facts.geometry }),
  };
  return { lines: blockLines(minimal, marker, header), truncated: true };
}

/** Only used by the details panel: groups in display order, values as-is. */
export { groupProps as groupStyleFacts };

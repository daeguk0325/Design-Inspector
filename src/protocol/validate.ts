// Protocol validation + trust boundary (§7).
// - exact target origin (no "*") when known
// - event.source must equal iframe contentWindow
// - schema validation before any state mutation
// - stale connectionId / documentGeneration / sequence rejection

import {
  APP_TO_BRIDGE_TYPES,
  BRIDGE_TO_APP_TYPES,
  PROTOCOL_VERSION,
} from './types.ts';
import type { AppMessage, BridgeMessage } from './types.ts';

const KNOWN_TYPES = new Set<string>(BRIDGE_TO_APP_TYPES);
const KNOWN_APP_TYPES = new Set<string>(APP_TO_BRIDGE_TYPES);

export const PROTOCOL_LIMITS = Object.freeze({
  idChars: 200,
  veraUrlChars: 2_048,
  selectionIdChars: 200,
  elementKeyChars: 512,
  componentChars: 200,
  fileChars: 400,
  routeKeyChars: 512,
  tagNameChars: 64,
  anchorIdChars: 256,
  testIdChars: 256,
  anchorPathChars: 1_024,
  extraJsonChars: 16_384,
  selections: 100,
  activeOrder: 100,
  order: 1_000_000_000,
  line: 10_000_000,
  routeEpoch: Number.MAX_SAFE_INTEGER,
  previewBindingIdChars: 200,
  previewTransactionIdChars: 256,
  previewTransactionIds: 64,
  previewChanges: 12,
  previewPropertiesPerChange: 12,
  previewPropertyChars: 64,
  previewValueChars: 120,
  previewReplaceTextChars: 200,
  previewAnchorResults: 12,
  previewMatchCount: 1_000,
  capabilityMaxSelectionImages: 16,
  capabilityMaxImageBytes: 5_000_000,
  capabilityMaxImageDimension: 8_192,
  capabilityMaxImagePixels: 40_000_000,
  capabilityPreviewChanges: 12,
  capabilityPreviewProperties: 12,
  capabilityPreviewValueChars: 120,
  captureBase64Chars: 700_000,
  captureByteLength: 524_288,
  captureDimension: 1_600,
  capturePixels: 2_000_000,
  errorMessageChars: 500,
  styleFactProps: 56,
  styleFactValueChars: 120,
  styleFactLabelChars: 80,
  styleFactAncestorChars: 80,
  styleFactAncestors: 3,
  styleFactTagNameChars: 32,
  styleFactCoordinate: 100_000,
});

const L = PROTOCOL_LIMITS;

const ANCHOR_KEYS: ReadonlySet<string> = new Set([
  'elementKey',
  'routeKey',
  'mode',
  'tagName',
  'id',
  'testId',
  'path',
]);
/**
 * §9f operations. `anchor` and `declarations` are always on the wire — the
 * controller sends an empty declarations map for a change that carries only a
 * text or element operation — so those two are required and the three operations
 * are optional. The operation vocabularies and the text bound are re-declared
 * here instead of imported from preview/contract.ts: this module is the trust
 * boundary and already re-implements CSS validation independently, and a shared
 * import would be the one change that could not be checked on its own.
 */
const PREVIEW_CHANGE_REQUIRED_KEYS: ReadonlySet<string> = new Set(['anchor', 'declarations']);
const PREVIEW_CHANGE_KEYS: ReadonlySet<string> = new Set([
  'anchor',
  'declarations',
  'text',
  'replaceText',
  'element',
]);
const PREVIEW_TEXT_OPS: ReadonlySet<string> = new Set(['clear']);
const PREVIEW_ELEMENT_OPS: ReadonlySet<string> = new Set(['hide', 'remove']);
const PREVIEW_ANCHOR_RESULT_KEYS: ReadonlySet<string> = new Set([
  'elementKey',
  'status',
  'matchCount',
]);
const RESERVED_DECLARATION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * §9e style facts. The allowlist is a subset, not an exact set: the Bridge
 * omits every property whose computed value equals its default, so a record
 * carries a handful of these at most. `hasExactKeys` cannot be used here.
 */
const STYLE_FACT_KEYS: ReadonlySet<string> = new Set([
  'props',
  'geometry',
  'label',
  'ancestors',
  'tagName',
  'derived',
]);
const STYLE_FACT_GEOMETRY_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'width', 'height']);
const STYLE_FACT_DERIVED_KEYS: ReadonlySet<string> = new Set(['contrast', 'truncated', 'fontLoad']);
const STYLE_FACT_CONTRAST_KEYS: ReadonlySet<string> = new Set([
  'ratio',
  'min',
  'pass',
  'large',
  'background',
]);
/** The one optional key on a contrast verdict; see src/protocol/types.ts. */
const STYLE_FACT_CONTRAST_CAVEATS: ReadonlySet<string> = new Set(['shadow', 'overlap']);
const STYLE_FACT_UNMEASURABLE_KEYS: ReadonlySet<string> = new Set(['unmeasurable']);
const STYLE_FACT_FONT_LOAD_VALUES: ReadonlySet<string> = new Set(['fallback', 'unknown']);
const STYLE_FACT_HEX_COLOR = /^#[0-9a-f]{6}$/i;
const STYLE_FACT_ALLOWED_PROPS: ReadonlySet<string> = new Set([
  'color', 'background-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'caret-color', 'fill', 'stroke',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
  'text-decoration-line', 'text-indent',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-radius', 'box-sizing', 'box-shadow',
  'display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content',
  'gap', 'grid-template-columns', 'position', 'z-index', 'overflow',
  'visibility', 'opacity',
  'transition-duration', 'animation-name', 'transform', 'filter',
]);
/** `tag.class` in the ancestor chain, e.g. `header.nav`. */
const STYLE_FACT_ANCESTOR_SEGMENT = /^[a-z][a-z0-9-]{0,31}(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})?$/;
const ALLOWED_CSS_FUNCTIONS: ReadonlySet<string> = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'calc',
  'min',
  'max',
  'clamp',
  'var',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'cubic-bezier',
  'steps',
  'translate',
  'translatex',
  'translatey',
  'scale',
  'rotate',
]);
const CSS_PROPERTY_RE = /^[a-z][a-z0-9-]*$/;
const CSS_VALUE_RE = /^[A-Za-z0-9 \t#%.,()/_'"-]+$/;
const CSS_TAG_NAME_RE = /^[a-z][a-z0-9-]*$/;
const CSS_FUNCTION_RE = /([A-Za-z][A-Za-z0-9]*)\(/g;

export interface ValidationContext {
  expectedConnectionId: string | null;
  expectedDocumentGeneration: string | null;
  lastSequence: number;
  expectedRouteEpoch?: number | null;
}

export interface AppValidationContext {
  expectedConnectionId: string | null;
  lastSequence: number;
}

export type RejectReason =
  | 'unknown-type'
  | 'bad-envelope'
  | 'bad-protocol-version'
  | 'stale-connection'
  | 'stale-generation'
  | 'stale-sequence'
  | 'stale-route-epoch'
  | 'missing-selection-id';

function imageDimensionsFromBase64(base64: string, mimeType: unknown): { width: number; height: number } | null {
  const maxBytes = mimeType === 'image/jpeg' ? 65_536 : 64;
  const prefix = base64.slice(0, Math.ceil(maxBytes / 3) * 4);
  let binary: string;
  try {
    binary = atob(prefix);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (mimeType === 'image/png') {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType !== 'image/jpeg' || bytes.length < 4) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset + 1 >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 7 >= bytes.length) return null;
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2) return null;
    offset += length;
  }
  return null;
}

export interface ValidationResult {
  ok: boolean;
  reason?: RejectReason;
  msg?: BridgeMessage;
}

export interface AppValidationResult {
  ok: boolean;
  reason?: RejectReason;
  msg?: AppMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= max
  );
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isBoundedNumber(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function isOptionalBoundedString(value: unknown, max: number, allowEmpty = false): boolean {
  return value === undefined || isBoundedString(value, max, allowEmpty);
}

function isInspectorMode(value: unknown): value is string {
  return value === 'html' || value === '3d' || value === 'konva';
}

function isBridgeKind(value: unknown): value is string {
  return value === 'native' || value === 'compatibility';
}

function isPreviewOperation(value: unknown): value is string {
  return value === 'apply' || value === 'undo' || value === 'reset';
}

function isPreviewResultStatus(value: unknown): value is string {
  return (
    value === 'applied' ||
    value === 'unbound' ||
    value === 'ambiguous' ||
    value === 'rejected' ||
    value === 'undone' ||
    value === 'reset' ||
    value === 'no-op'
  );
}

function isPreviewAnchorStatus(value: unknown): value is string {
  return value === 'applied' || value === 'unbound' || value === 'ambiguous' || value === 'rejected';
}

function isOptionalUniqueIdList(value: unknown, maxItems: number, maxChars: number): boolean {
  return value === undefined || isUniqueBoundedIdList(value, maxItems, maxChars);
}

function isOptionalNonNegativeInt(value: unknown, max: number): boolean {
  return value === undefined || isBoundedInt(value, 0, max);
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== allowed.size) return false;
  for (const key of keys) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/** Every required key present, extras unjudged here. See `hasOnlyKeys`. */
function hasRequiredKeys(value: Record<string, unknown>, required: ReadonlySet<string>): boolean {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

function isRouteKey(value: unknown): value is string {
  return isBoundedString(value, L.routeKeyChars, true);
}

function isRouteEpoch(value: unknown): value is number {
  return isBoundedInt(value, 0, L.routeEpoch);
}

function isUniqueBoundedIdList(
  value: unknown,
  maxItems: number,
  maxChars: number,
): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isBoundedString(item, maxChars)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function countChar(value: string, char: string): number {
  let total = 0;
  for (const character of value) {
    if (character === char) total += 1;
  }
  return total;
}

function isCapabilitiesValid(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (typeof value['selectionCrop'] !== 'boolean') return false;
  if (!isBoundedInt(value['maxSelectionImages'], 0, L.capabilityMaxSelectionImages)) return false;
  if (!isBoundedInt(value['maxImageBytes'], 0, L.capabilityMaxImageBytes)) return false;
  if (!isBoundedInt(value['maxImageDimension'], 0, L.capabilityMaxImageDimension)) return false;
  if (!isBoundedInt(value['maxImagePixels'], 0, L.capabilityMaxImagePixels)) return false;
  const cssPreview = value['cssPreview'];
  if (cssPreview !== undefined && typeof cssPreview !== 'boolean') return false;
  if (
    value['maxPreviewChanges'] !== undefined &&
    !isBoundedInt(value['maxPreviewChanges'], 0, L.capabilityPreviewChanges)
  ) {
    return false;
  }
  if (
    value['maxPreviewPropertiesPerChange'] !== undefined &&
    !isBoundedInt(
      value['maxPreviewPropertiesPerChange'],
      0,
      L.capabilityPreviewProperties,
    )
  ) {
    return false;
  }
  if (
    value['maxPreviewValueLength'] !== undefined &&
    !isBoundedInt(value['maxPreviewValueLength'], 0, L.capabilityPreviewValueChars)
  ) {
    return false;
  }
  return true;
}

function isAnchorValid(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ANCHOR_KEYS)) return false;
  if (value['mode'] !== 'html') return false;
  if (!isBoundedString(value['elementKey'], L.elementKeyChars)) return false;
  if (!isBoundedString(value['routeKey'], L.routeKeyChars)) return false;
  if (
    !isBoundedString(value['tagName'], L.tagNameChars) ||
    !CSS_TAG_NAME_RE.test(value['tagName'] as string)
  ) {
    return false;
  }
  return (
    isBoundedString(value['id'], L.anchorIdChars, true) &&
    isBoundedString(value['testId'], L.testIdChars, true) &&
    isBoundedString(value['path'], L.anchorPathChars, true)
  );
}

function isCssValueValid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length === 0 || text.length > L.previewValueChars) return false;
  if (!CSS_VALUE_RE.test(text)) return false;
  if (countChar(text, '(') !== countChar(text, ')')) return false;
  CSS_FUNCTION_RE.lastIndex = 0;
  let match = CSS_FUNCTION_RE.exec(text);
  while (match !== null) {
    if (!ALLOWED_CSS_FUNCTIONS.has((match[1] ?? '').toLowerCase())) return false;
    match = CSS_FUNCTION_RE.exec(text);
  }
  return true;
}

function isDeclarationsValid(value: unknown, allowEmpty: boolean): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > L.previewPropertiesPerChange) return false;
  // Empty only when another operation is doing the work; see
  // isPreviewChangeValid.
  if (entries.length < 1 && !allowEmpty) return false;
  for (const [property, declaration] of entries) {
    if (property.length === 0 || property.length > L.previewPropertyChars) return false;
    if (RESERVED_DECLARATION_KEYS.has(property)) return false;
    if (!CSS_PROPERTY_RE.test(property)) return false;
    if (!isCssValueValid(declaration)) return false;
  }
  return true;
}

/**
 * The §9f operation keys, checked with the same rules the block contract uses.
 *
 * A change carrying only a text or element operation is legal and was being
 * refused: the required key set was `anchor` + `declarations` with nothing
 * optional and a non-empty declarations map, so every `text: "clear"` the model
 * emitted was rejected by the app's own outbound check and the page was never
 * touched. That is the app→bridge trust boundary second-guessing a change the
 * Bridge has already implemented.
 */
function isPreviewChangeValid(item: Record<string, unknown>): boolean {
  if (!hasRequiredKeys(item, PREVIEW_CHANGE_REQUIRED_KEYS)) return false;
  const text = item['text'];
  if (text !== undefined && !PREVIEW_TEXT_OPS.has(text as string)) return false;
  const element = item['element'];
  if (element !== undefined && !PREVIEW_ELEMENT_OPS.has(element as string)) return false;
  const replaceText = item['replaceText'];
  if (replaceText !== undefined) {
    // Clearing and replacing are two ways to do one job, so a change that asks
    // for both has no single meaning for the Bridge to apply.
    if (text !== undefined) return false;
    if (typeof replaceText !== 'string' || replaceText.length > L.previewReplaceTextChars) {
      return false;
    }
  }
  if (!isDeclarationsValid(item['declarations'], true)) return false;
  // A change with no operation at all would be forwarded as an empty restyle.
  const declarations = item['declarations'] as Record<string, string>;
  return (
    Object.keys(declarations).length > 0 ||
    text !== undefined ||
    replaceText !== undefined ||
    element !== undefined
  );
}

function isPreviewChangesValid(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length < 1 || value.length > L.previewChanges) return false;
  const seen = new Set<string>();
  let routeKey: string | null = null;
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, PREVIEW_CHANGE_KEYS)) return false;
    if (!isPreviewChangeValid(item)) return false;
    const anchor = item['anchor'];
    if (!isAnchorValid(anchor)) return false;
    const elementKey = anchor['elementKey'] as string;
    if (seen.has(elementKey)) return false;
    seen.add(elementKey);
    const changeRouteKey = anchor['routeKey'] as string;
    if (routeKey === null) routeKey = changeRouteKey;
    else if (routeKey !== changeRouteKey) return false;
  }
  return true;
}

function isPreviewAnchorResultsValid(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > L.previewAnchorResults) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, PREVIEW_ANCHOR_RESULT_KEYS)) return false;
    const elementKey = item['elementKey'];
    if (!isBoundedString(elementKey, L.elementKeyChars)) return false;
    if (seen.has(elementKey)) return false;
    seen.add(elementKey);
    const status = item['status'];
    if (!isPreviewAnchorStatus(status)) return false;
    if (!isBoundedInt(item['matchCount'], 0, L.previewMatchCount)) return false;
    const matchCount = item['matchCount'] as number;
    if (matchCount === 0 && status !== 'unbound' && status !== 'rejected') return false;
    if (matchCount > 0 && status === 'unbound') return false;
  }
  return true;
}

function isExtraValid(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    return (JSON.stringify(value) as string).length <= L.extraJsonChars;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isStyleFactPropsValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > L.styleFactProps) return false;
  for (const [property, declaration] of entries) {
    if (!STYLE_FACT_ALLOWED_PROPS.has(property)) return false;
    if (typeof declaration !== 'string') return false;
    // An empty value is a measurement gap, not a fact: the Bridge already
    // omits properties it could not read.
    if (!isBoundedString(declaration.trim(), L.styleFactValueChars)) return false;
  }
  return true;
}

function isStyleFactGeometryValid(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, STYLE_FACT_GEOMETRY_KEYS)) return false;
  if (Object.keys(value).length !== STYLE_FACT_GEOMETRY_KEYS.size) return false;
  const limit = L.styleFactCoordinate;
  return (
    isBoundedInt(value['x'], -limit, limit) &&
    isBoundedInt(value['y'], -limit, limit) &&
    isBoundedInt(value['width'], 0, limit) &&
    isBoundedInt(value['height'], 0, limit)
  );
}

function isStyleFactContrastValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['unmeasurable'] !== undefined) {
    // Exactly the unmeasurable marker, nothing else riding along with it.
    return value['unmeasurable'] === true && hasOnlyKeys(value, STYLE_FACT_UNMEASURABLE_KEYS);
  }
  const keys = Object.keys(value);
  const allowed = new Set(STYLE_FACT_CONTRAST_KEYS);
  allowed.add('caveat');
  if (!hasOnlyKeys(value, allowed)) return false;
  // Every key required, plus the caveat, plus nothing else.
  if (keys.length !== STYLE_FACT_CONTRAST_KEYS.size && keys.length !== STYLE_FACT_CONTRAST_KEYS.size + 1) {
    return false;
  }
  const caveat = value['caveat'];
  if (caveat !== undefined && !STYLE_FACT_CONTRAST_CAVEATS.has(caveat as string)) return false;
  const background = value['background'];
  return (
    // A ratio is the one non-integer number in the protocol, so it gets an
    // explicit range instead of the integer helper.
    isBoundedNumber(value['ratio'], 1, 21) &&
    isBoundedNumber(value['min'], 1, 21) &&
    typeof value['pass'] === 'boolean' &&
    typeof value['large'] === 'boolean' &&
    isBoundedString(background, 7) &&
    STYLE_FACT_HEX_COLOR.test(background)
  );
}

function isStyleFactsDerivedValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, STYLE_FACT_DERIVED_KEYS)) return false;
  if (Object.keys(value).length === 0) return false;
  const contrast = value['contrast'];
  if (contrast !== undefined && !isStyleFactContrastValid(contrast)) return false;
  const truncated = value['truncated'];
  // `true` only: a `false` here would be the unremarkable state, which the
  // Bridge omits rather than sends.
  if (truncated !== undefined && truncated !== true) return false;
  const fontLoad = value['fontLoad'];
  if (fontLoad !== undefined && (typeof fontLoad !== 'string' || !STYLE_FACT_FONT_LOAD_VALUES.has(fontLoad))) {
    return false;
  }
  return true;
}

function isStyleFactsValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, STYLE_FACT_KEYS)) return false;
  if (!isStyleFactPropsValid(value['props'])) return false;
  const geometry = value['geometry'];
  if (geometry !== undefined && !isStyleFactGeometryValid(geometry)) return false;
  const label = value['label'];
  if (label !== undefined && !isBoundedString(label, L.styleFactLabelChars, true)) return false;
  const tagName = value['tagName'];
  if (tagName !== undefined) {
    if (!isBoundedString(tagName, L.styleFactTagNameChars) || !CSS_TAG_NAME_RE.test(tagName)) return false;
  }
  const derived = value['derived'];
  if (derived !== undefined && !isStyleFactsDerivedValid(derived)) return false;
  const ancestors = value['ancestors'];
  if (ancestors === undefined) return true;
  if (!Array.isArray(ancestors) || ancestors.length > L.styleFactAncestors) return false;
  for (const segment of ancestors) {
    if (!isBoundedString(segment, L.styleFactAncestorChars) || !STYLE_FACT_ANCESTOR_SEGMENT.test(segment)) {
      return false;
    }
  }
  return true;
}

function isSelectionRecordValid(value: unknown, activeOnly: boolean): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value['selectionId'], L.selectionIdChars)) return false;
  if (!isBoundedString(value['elementKey'], L.elementKeyChars)) return false;
  if (!isBoundedString(value['mode'], 8) || !isInspectorMode(value['mode'])) return false;
  const state = value['state'];
  if (activeOnly) {
    if (state !== 'active') return false;
  } else if (state !== 'active' && state !== 'inactive') {
    return false;
  }
  if (!isBoundedInt(value['order'], 0, L.order)) return false;
  if (!(value['component'] === null || isBoundedString(value['component'], L.componentChars, true))) {
    return false;
  }
  if (!(value['file'] === null || isBoundedString(value['file'], L.fileChars, true))) return false;
  if (!(value['line'] === null || isBoundedInt(value['line'], 0, L.line))) return false;
  if (!isExtraValid(value['extra'])) return false;
  const styleFacts = value['styleFacts'];
  if (styleFacts !== undefined && !isStyleFactsValid(styleFacts)) return false;
  const anchor = value['anchor'];
  if (anchor === undefined) return true;
  if (!isAnchorValid(anchor)) return false;
  return anchor['elementKey'] === value['elementKey'];
}

function hasSnapshotIntegrity(selections: unknown[], activeOrder: string[]): boolean {
  const selectionIds = new Set<string>();
  const elementKeys = new Set<string>();
  for (const item of selections) {
    const record = item as Record<string, unknown>;
    const selectionId = record['selectionId'] as string;
    const elementKey = record['elementKey'] as string;
    if (selectionIds.has(selectionId) || elementKeys.has(elementKey)) return false;
    selectionIds.add(selectionId);
    elementKeys.add(elementKey);
  }
  if (selectionIds.size !== activeOrder.length) return false;
  for (const id of activeOrder) {
    if (!selectionIds.has(id)) return false;
  }
  return true;
}

function readEnvelope(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['protocolVersion'] !== 'number' || typeof raw['type'] !== 'string') return null;
  if (!isBoundedString(raw['connectionId'], L.idChars)) return null;
  if (!isBoundedString(raw['documentGeneration'], L.idChars)) return null;
  if (!isBoundedString(raw['requestId'], L.idChars)) return null;
  if (!isBoundedInt(raw['sequence'], 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!('payload' in raw)) return null;
  return raw;
}

function captureResultRejectReason(payload: Record<string, unknown>): RejectReason | null {
  const base64 = typeof payload['base64'] === 'string' ? payload['base64'] : '';
  if (base64.length > L.captureBase64Chars) return 'bad-envelope';
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedLength = Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
  const signatureMatches =
    (payload['mimeType'] === 'image/png' && base64.startsWith('iVBORw0KGgo')) ||
    (payload['mimeType'] === 'image/jpeg' && base64.startsWith('/9j/'));
  const width = typeof payload['width'] === 'number' ? payload['width'] : 0;
  const height = typeof payload['height'] === 'number' ? payload['height'] : 0;
  const dimensions = imageDimensionsFromBase64(base64, payload['mimeType']);
  const byteLength = typeof payload['byteLength'] === 'number' ? payload['byteLength'] : 0;
  if (
    typeof payload['selectionId'] !== 'string' ||
    payload['selectionId'] === '' ||
    payload['selectionId'].length > L.selectionIdChars ||
    (payload['mimeType'] !== 'image/png' && payload['mimeType'] !== 'image/jpeg') ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    base64.length > L.captureBase64Chars ||
    !signatureMatches ||
    dimensions === null ||
    dimensions.width !== width ||
    dimensions.height !== height ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > L.captureDimension ||
    height > L.captureDimension ||
    width * height > L.capturePixels ||
    !Number.isInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > L.captureByteLength ||
    decodedLength !== byteLength
  ) {
    return 'bad-envelope';
  }
  return null;
}

function isStaleRouteEpoch(payload: Record<string, unknown>, ctx: ValidationContext): boolean {
  const expected = ctx.expectedRouteEpoch;
  if (expected === undefined || expected === null) return false;
  if (!isBoundedInt(expected, 0, L.routeEpoch)) return false;
  return (payload['routeEpoch'] as number) < expected;
}

function bridgePayloadRejectReason(
  type: string,
  payload: Record<string, unknown>,
  envelope: Record<string, unknown>,
  ctx: ValidationContext,
): RejectReason | null {
  switch (type) {
    case 'VERA_INSPECTOR_HELLO_ACK': {
      if (
        typeof payload['bridgeConnectionId'] !== 'string' ||
        payload['bridgeConnectionId'] !== envelope['connectionId'] ||
        typeof payload['documentGeneration'] !== 'string' ||
        payload['documentGeneration'] !== envelope['documentGeneration'] ||
        !isBoundedString(payload['veraUrl'], L.veraUrlChars) ||
        !isCapabilitiesValid(payload['capabilities']) ||
        !isOptionalBoundedString(payload['routeKey'], L.routeKeyChars, true) ||
        !isOptionalNonNegativeInt(payload['routeEpoch'], L.routeEpoch)
      ) {
        return 'bad-envelope';
      }
      return null;
    }
    case 'VERA_INSPECTOR_FREEZE_ACK':
    case 'VERA_INSPECTOR_PONG': {
      if (
        typeof payload['inspectorFrozen'] !== 'boolean' ||
        !isInspectorMode(payload['mode'])
      ) {
        return 'bad-envelope';
      }
      return null;
    }
    case 'VERA_INSPECTOR_CAPTURE_RESULT':
      return captureResultRejectReason(payload);
    case 'VERA_INSPECTOR_SELECTION': {
      const record = (payload['record'] ?? null) as unknown;
      if (
        !isRecord(record) ||
        typeof record['selectionId'] !== 'string' ||
        record['selectionId'] === ''
      ) {
        return 'missing-selection-id';
      }
      if (!isSelectionRecordValid(record, false)) return 'bad-envelope';
      const activeOrder = payload['activeOrder'];
      if (!isUniqueBoundedIdList(activeOrder, L.activeOrder, L.selectionIdChars)) {
        return 'bad-envelope';
      }
      const listed = (activeOrder as string[]).includes(record['selectionId'] as string);
      if (record['state'] === 'active' && !listed) return 'bad-envelope';
      if (record['state'] === 'inactive' && listed) return 'bad-envelope';
      return null;
    }
    case 'VERA_INSPECTOR_SNAPSHOT': {
      const selections = payload['selections'];
      const activeOrder = payload['activeOrder'];
      if (
        !isBoundedString(payload['connectionId'], L.idChars) ||
        !isBoundedString(payload['documentGeneration'], L.idChars) ||
        typeof payload['inspectorFrozen'] !== 'boolean' ||
        !isInspectorMode(payload['mode']) ||
        !isCapabilitiesValid(payload['capabilities']) ||
        !isOptionalBoundedString(payload['routeKey'], L.routeKeyChars, true) ||
        !isOptionalNonNegativeInt(payload['routeEpoch'], L.routeEpoch) ||
        !Array.isArray(selections) ||
        selections.length > L.selections ||
        !selections.every((item) => isSelectionRecordValid(item, true)) ||
        !isUniqueBoundedIdList(activeOrder, L.activeOrder, L.selectionIdChars) ||
        !hasSnapshotIntegrity(selections, activeOrder as string[])
      ) {
        return 'bad-envelope';
      }
      return null;
    }
    case 'VERA_INSPECTOR_ERROR': {
      if (
        !isBoundedString(payload['code'], L.idChars) ||
        !isBoundedString(payload['message'], L.errorMessageChars, true)
      ) {
        return 'bad-envelope';
      }
      return null;
    }
    case 'VERA_INSPECTOR_SESSION_RESET_ACK':
    case 'VERA_INSPECTOR_ROUTE_CHANGED': {
      if (!isRouteKey(payload['routeKey']) || !isRouteEpoch(payload['routeEpoch'])) {
        return 'bad-envelope';
      }
      return isStaleRouteEpoch(payload, ctx) ? 'stale-route-epoch' : null;
    }
    case 'VERA_INSPECTOR_PREVIEW_RESULT': {
      if (
        !isBoundedString(payload['bindingId'], L.previewBindingIdChars) ||
        !isBoundedString(payload['transactionId'], L.previewTransactionIdChars) ||
        !isPreviewOperation(payload['operation']) ||
        !isPreviewResultStatus(payload['status']) ||
        !isPreviewAnchorResultsValid(payload['anchors']) ||
        !isRouteKey(payload['routeKey']) ||
        !isRouteEpoch(payload['routeEpoch'])
      ) {
        return 'bad-envelope';
      }
      return isStaleRouteEpoch(payload, ctx) ? 'stale-route-epoch' : null;
    }
    case 'VERA_INSPECTOR_BRIDGE_PRESENT': {
      if (
        !isBoundedString(payload['bridgeConnectionId'], L.idChars) ||
        payload['bridgeConnectionId'] !== envelope['connectionId'] ||
        !isBoundedString(payload['documentGeneration'], L.idChars) ||
        payload['documentGeneration'] !== envelope['documentGeneration']
      ) {
        return 'bad-envelope';
      }
      return null;
    }
    default:
      return null;
  }
}

function appPayloadRejectReason(type: string, payload: Record<string, unknown>): RejectReason | null {
  switch (type) {
    case 'VERA_INSPECTOR_HELLO': {
      const appOrigin = payload['appOrigin'];
      if (!isBoundedString(appOrigin, L.veraUrlChars) || targetOriginFor(appOrigin) === null) {
        return 'bad-envelope';
      }
      return null;
    }
    case 'VERA_INSPECTOR_FREEZE': {
      if (typeof payload['active'] !== 'boolean') return 'bad-envelope';
      return null;
    }
    case 'VERA_INSPECTOR_SET_MODE': {
      if (!isInspectorMode(payload['mode'])) return 'bad-envelope';
      return null;
    }
    case 'VERA_INSPECTOR_CLEAR_SELECTION':
    case 'VERA_INSPECTOR_RESELECT_SELECTION':
    case 'VERA_INSPECTOR_CAPTURE_SELECTION': {
      if (!isBoundedString(payload['selectionId'], L.selectionIdChars)) return 'bad-envelope';
      return null;
    }
    case 'VERA_INSPECTOR_PREVIEW_APPLY': {
      if (
        !isBoundedString(payload['bindingId'], L.previewBindingIdChars) ||
        !isBoundedString(payload['transactionId'], L.previewTransactionIdChars) ||
        !isPreviewChangesValid(payload['changes'])
      ) {
        return 'bad-envelope';
      }
      return null;
    }
    case 'VERA_INSPECTOR_PREVIEW_UNDO':
    case 'VERA_INSPECTOR_PREVIEW_RESET': {
      if (
        !isBoundedString(payload['bindingId'], L.previewBindingIdChars) ||
        !isOptionalBoundedString(payload['transactionId'], L.previewTransactionIdChars) ||
        !isOptionalUniqueIdList(
          payload['transactionIds'],
          L.previewTransactionIds,
          L.previewTransactionIdChars,
        )
      ) {
        return 'bad-envelope';
      }
      return null;
    }
    default:
      return null;
  }
}

/** Parse + schema-validate an unknown postMessage payload. Never throws. */
export function validateBridgeMessage(
  raw: unknown,
  ctx: ValidationContext,
): ValidationResult {
  const m = readEnvelope(raw);
  if (m === null) {
    return { ok: false, reason: 'bad-envelope' };
  }
  if (m['protocolVersion'] !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'bad-protocol-version' };
  }
  if (!KNOWN_TYPES.has(m['type'] as string)) {
    return { ok: false, reason: 'unknown-type' };
  }
  const payload = m['payload'];
  if (!isRecord(payload)) {
    return { ok: false, reason: 'bad-envelope' };
  }
  const bridgeKind = payload['bridgeKind'];
  if (bridgeKind !== undefined && !isBridgeKind(bridgeKind)) {
    return { ok: false, reason: 'bad-envelope' };
  }
  const msg = m as unknown as BridgeMessage;
  if (
    ctx.expectedConnectionId === null &&
    msg.type !== 'VERA_INSPECTOR_HELLO_ACK'
  ) {
    return { ok: false, reason: 'stale-connection' };
  }
  // Stale connection: a new Bridge instance must not be treated as the old one (§7.5).
  if (
    ctx.expectedConnectionId !== null &&
    msg.connectionId !== ctx.expectedConnectionId &&
    msg.type !== 'VERA_INSPECTOR_HELLO_ACK'
  ) {
    return { ok: false, reason: 'stale-connection' };
  }
  // Stale document generation: late events from older iframe generations rejected (§7.6).
  if (
    ctx.expectedDocumentGeneration !== null &&
    msg.documentGeneration !== ctx.expectedDocumentGeneration &&
    msg.type !== 'VERA_INSPECTOR_HELLO_ACK'
  ) {
    return { ok: false, reason: 'stale-generation' };
  }
  if (msg.sequence <= ctx.lastSequence && ctx.lastSequence > 0) {
    const newInstanceAck =
      msg.type === 'VERA_INSPECTOR_HELLO_ACK' &&
      ctx.expectedConnectionId !== null &&
      msg.connectionId !== ctx.expectedConnectionId;
    if (!newInstanceAck) {
      return { ok: false, reason: 'stale-sequence' };
    }
  }
  const reason = bridgePayloadRejectReason(
    msg.type,
    payload,
    m,
    ctx,
  );
  if (reason !== null) {
    return { ok: false, reason };
  }
  return { ok: true, msg };
}

/** Parse + schema-validate an outbound App A command. Never throws. */
export function validateAppMessage(
  raw: unknown,
  ctx: AppValidationContext,
): AppValidationResult {
  const m = readEnvelope(raw);
  if (m === null) {
    return { ok: false, reason: 'bad-envelope' };
  }
  if (m['protocolVersion'] !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'bad-protocol-version' };
  }
  if (!KNOWN_APP_TYPES.has(m['type'] as string)) {
    return { ok: false, reason: 'unknown-type' };
  }
  const payload = m['payload'];
  if (!isRecord(payload)) {
    return { ok: false, reason: 'bad-envelope' };
  }
  const msg = m as unknown as AppMessage;
  if (
    ctx.expectedConnectionId !== null &&
    msg.connectionId !== ctx.expectedConnectionId
  ) {
    return { ok: false, reason: 'stale-connection' };
  }
  if (ctx.lastSequence > 0 && msg.sequence <= ctx.lastSequence) {
    return { ok: false, reason: 'stale-sequence' };
  }
  const reason = appPayloadRejectReason(msg.type, payload);
  if (reason !== null) {
    return { ok: false, reason };
  }
  return { ok: true, msg };
}

/** Derive exact target origin from the loaded iframe URL (§7.2). */
export function targetOriginFor(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Check event.source is the currently loaded iframe window (§7.3). */
export function isExpectedSource(
  eventSource: unknown,
  iframeWindow: unknown,
): boolean {
  return eventSource !== null && eventSource === iframeWindow;
}

export function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

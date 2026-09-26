/**
 * Vera Inspector Bridge (App B) — native or proxy-injected compatibility runtime.
 *
 * Self-contained: no npm dependencies. The proxy compiles this source into an
 * isolated target route; a target may also import and initialize it natively.
 *
 * Spec: BUILD_PROMPT v4.3 §§ 5,7,8,9,10,11,12.
 * - Bridge is authoritative for live runtime state (freeze, mode, selections).
 * - Every selectionId is Bridge-issued; elementKey→selectionId mapping is stable
 *   within a document generation and never recycled by App A.
 * - Overlays use Shadow DOM for CSS isolation; positions recomputed on
 *   scroll/resize/rAF while frozen.
 * - HTML hover: dashed outline. Selection: solid outline + numbered label.
 * - Freeze is a real inert state, not a click block. A pointer shield inside
 *   the shadow host (pointer-events:auto, toggled on freeze) stops the page
 *   from receiving pointer events at all, so :hover CSS, hover handlers,
 *   clicks, drags and context menus all stop. Window-capture blockers stop
 *   keyboard, focus, editing, paste and drop. A document-level stylesheet
 *   pauses CSS animations/transitions and hides the caret. Scrolling stays
 *   allowed (it changes no app state and is needed to reach off-screen
 *   components). JS timers, rAF loops, sockets and video playback keep
 *   running — stopping those would require global patching, which is out of
 *   scope and can outlive the freeze. The Freeze shortcut
 *   (Ctrl/Cmd+Shift+F primary, Alt+Shift+F legacy) and Escape remain live.
 *
 * R3F / Konva: Vera must register runtime refs (see Manual Integration
 * Checklist). Without registration, 3D/Konva modes report explicit
 * "metadata unavailable" fallbacks — never fabricated locations.
 */

export type BridgeMode = 'html' | '3d' | 'konva';
export type BridgeKind = 'native' | 'compatibility';

export interface CaptureAsset {
  mimeType: 'image/png' | 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  byteLength: number;
}

export interface BridgeOptions {
  /** Exact expected App A origin, e.g. "http://localhost:5173". */
  appOrigin: string;
  initialMode?: BridgeMode;
  bridgeKind?: BridgeKind;
  captureElement?: (element: Element) => Promise<CaptureAsset>;
  /** Optional: return React fiber source metadata for an element. */
  resolveSource?: (el: Element) => { component: string | null; file: string | null; line: number | null };
  styleNonce?: string;
}

interface Rec {
  selectionId: string;
  elementKey: string;
  component: string | null;
  file: string | null;
  line: number | null;
  mode: BridgeMode;
  extra?: unknown;
  state: 'active' | 'inactive';
  order: number;
  revision: number;
  target: Element | null;
}

const PROTOCOL_VERSION = 1;
const CAPTURE_OPERATION_TIMEOUT_MS = 18_000;

const SAFE_CAPTURE_MESSAGES: Record<string, string> = {
  'capture-selection-unavailable': 'The selected element is no longer available.',
  'capture-unsupported': 'This Bridge does not support visual component capture.',
  'capture-busy': 'Too many component captures are queued.',
  'capture-limits': 'The component image exceeds the capture limits.',
  'capture-failed': 'The selected component could not be captured.',
  'capture-renderer-unavailable': 'The component renderer is unavailable.',
  'capture-invalid-bounds': 'The selected component has no visible bounds.',
  'capture-invalid-dimensions': 'The component image dimensions are invalid.',
  'capture-timeout': 'The component capture timed out.',
  'capture-encoding': 'The component image could not be encoded.',
};

const SAFE_CAPTURE_MESSAGE_OVERRIDES: Record<string, string> = {
  'selection-changed': 'The selected element changed during capture.',
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function normalizeExpectedOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError('Bridge app origin is invalid.');
  }
  return url.origin;
}

export type PreviewOperation = 'apply' | 'undo' | 'reset';

export type PreviewStatus =
  | 'applied'
  | 'unbound'
  | 'ambiguous'
  | 'rejected'
  | 'undone'
  | 'reset'
  | 'no-op';

export type PreviewAnchorStatus = 'applied' | 'unbound' | 'ambiguous' | 'rejected';

export interface InspectorAnchor {
  elementKey: string;
  routeKey: string;
  mode: 'html';
  tagName: string;
  id: string;
  testId: string;
  path: string;
}

export interface PreviewAnchorResult {
  elementKey: string;
  status: PreviewStatus;
  matchCount: number;
}

// ---- Style facts (§9e) ------------------------------------------------------
// Self-contained by necessity: the proxy transpiles this file on its own
// (scripts/target-proxy.mjs transpileModule, no module resolution), so the
// Bridge cannot import from src/. App A keeps its own stricter copy of the
// allowlist in src/style/properties.ts and drops anything it does not know —
// the duplication is the trust boundary, not an oversight.

/** Longhand only. A shorthand would hide a single differing side. */
const STYLE_FACT_PROPS: readonly string[] = [
  // color (10)
  'color', 'background-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'caret-color', 'fill', 'stroke',
  // typography (11)
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
  'text-decoration-line', 'text-indent',
  // box (19)
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-radius', 'box-sizing', 'box-shadow',
  // layout (12)
  'display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content',
  'gap', 'grid-template-columns', 'position', 'z-index', 'overflow',
  'visibility', 'opacity',
  // motion (4)
  'transition-duration', 'animation-name', 'transform', 'filter',
];

/**
 * Per-property defaults, NOT one global list: `0px` is unremarkable on margin
 * but meaningful on padding, and `block` is noise on a div while `flex` is the
 * whole point. Omitting defaults is what leaves only the surprising values.
 */
const STYLE_FACT_DEFAULTS: Readonly<Record<string, string>> = {
  // background-color is deliberately ABSENT. A transparent background is not
  // noise: it is why a ghost button reads as a ghost button, and it is the
  // answer to "what is behind this text?". Filtering rgba(0,0,0,0) as a
  // default was tried and reverted — a real 9B run over a real page then had to
  // answer "버튼 2 배경색 확인 불가" for a button whose background was plainly
  // knowable, i.e. the filter manufactured a gap in the evidence.
  'border-top-color': 'rgb(0, 0, 0)',
  'border-right-color': 'rgb(0, 0, 0)',
  'border-bottom-color': 'rgb(0, 0, 0)',
  'border-left-color': 'rgb(0, 0, 0)',
  'outline-color': 'rgb(0, 0, 0)',
  'caret-color': 'auto',
  'color': 'rgb(0, 0, 0)',
  // The CSS initial value for fill/stroke is `black`, not `none`. Getting this
  // wrong put a meaningless `fill: rgb(0, 0, 0)` on every HTML element.
  fill: 'rgb(0, 0, 0)',
  stroke: 'rgb(0, 0, 0)',
  'font-style': 'normal',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'start',
  'text-transform': 'none',
  'text-decoration-line': 'none',
  'text-indent': '0px',
  'border-top-style': 'none',
  'border-right-style': 'none',
  'border-bottom-style': 'none',
  'border-left-style': 'none',
  'border-radius': '0px',
  'box-sizing': 'content-box',
  'box-shadow': 'none',
  // The computed default for an ordinary block box, which is what nearly every
  // selected element is. `inline` would be the spec's initial value, but it is
  // not what a div reports and so it would not filter anything.
  display: 'block',
  'flex-direction': 'row',
  'flex-wrap': 'nowrap',
  'align-items': 'normal',
  'justify-content': 'normal',
  gap: 'normal',
  'grid-template-columns': 'none',
  position: 'static',
  'z-index': 'auto',
  overflow: 'visible',
  visibility: 'visible',
  opacity: '1',
  'animation-name': 'none',
  'transition-duration': '0s',
  transform: 'none',
  filter: 'none',
};

/**
 * `0px` is only unremarkable where zero length is the initial value. Padding is
 * deliberately absent: "this component has no padding" is a finding.
 * `word-spacing` is here too: its initial value is `normal`, but every engine
 * reports `0px` in practice and the two are indistinguishable to a reader.
 */
const STYLE_FACT_ZERO_DEFAULT_PROPS: ReadonlySet<string> = new Set([
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'word-spacing',
]);

/**
 * These have `currentColor` as their CSS initial value, so getComputedStyle
 * resolves them to the element's own text colour. A computed value equal to
 * `color` therefore means "not authored", and it is already implied by the
 * colour we do report. Found by capturing a real page: four of these plus
 * outline and caret were ~40% of every record's noise.
 */
const STYLE_FACT_CURRENT_COLOR_PROPS: readonly string[] = [
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'caret-color',
];

/** A unit is optional: `0`, `0px`, `0.0em` and `0%` are all zero lengths. */
const STYLE_FACT_ZERO_LENGTH = /^0(?:\.0+)?(?:px|em|rem|%|pt|ch|vh|vw|vmin|vmax)?$/;

const STYLE_FACT_VALUE_CHARS = 120;
const STYLE_FACT_LABEL_CHARS = 80;
const STYLE_FACT_ANCESTOR_DEPTH = 3;
// Stripping control characters is the point: these values reach the model
// prompt, and a newline or an escape in a style value is an injection seam.
// oxlint-disable-next-line no-control-regex
const STYLE_FACT_CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f]/g;
const STYLE_FACT_WHITESPACE = /\s+/g;
const STYLE_FACT_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const STYLE_FACT_RGB = /^rgba?\(\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*[,/]\s*\d{1,3}\s*(?:[,/]\s*[\d.%]+\s*)?\)$/i;
const STYLE_FACT_TRANSPARENT = /^(?:transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i;
const STYLE_FACT_TAG_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const STYLE_FACT_CLASS = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface StyleFactsGeometry {
  /** Viewport coordinates, as getBoundingClientRect reports them. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StyleFactsContrast {
  /** WCAG 2.x ratio, two decimals, 1..21. */
  ratio: number;
  /** The threshold that applied: 4.5, or 3 for large text. */
  min: number;
  pass: boolean;
  large: boolean;
  /** The resolved backdrop the text is drawn on, as #rrggbb. */
  background: string;
}

export interface StyleFactsDerived {
  /**
   * Either a verdict, or `{ unmeasurable: true }` when the backdrop is an
   * image, a gradient, a blend, or otherwise not a flat colour. The
   * unmeasurable form is a real answer: it is what stops the model filling the
   * gap with a number of its own.
   */
  contrast?: StyleFactsContrast | { unmeasurable: true };
  /** Present only when the content overflows its box. */
  truncated?: true;
  /** `loaded` is the expected state and is omitted. */
  fontLoad?: 'fallback' | 'unknown';
}

export interface StyleFacts {
  /** CSS longhand name → computed value. Defaults already omitted. */
  props: Record<string, string>;
  geometry?: StyleFactsGeometry;
  label?: string;
  ancestors?: string[];
  tagName?: string;
  /** Computed here rather than asked of the model. */
  derived?: StyleFactsDerived;
}

export function cleanStyleValue(value: string, max: number): string | null {
  const cleaned = value.replace(STYLE_FACT_CONTROL_CHARS, ' ').replace(STYLE_FACT_WHITESPACE, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1).trimEnd() + '…';
}

function sameStyleValue(left: string, right: string): boolean {
  return left.toLowerCase().replace(STYLE_FACT_WHITESPACE, ' ') ===
    right.toLowerCase().replace(STYLE_FACT_WHITESPACE, ' ');
}

/**
 * `getComputedStyle` returns the whole resolved fallback stack. Reporting it
 * verbatim is noise: a measured run showed
 * `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", …` costing 95
 * characters — 14% of one component's whole evidence block — and the model
 * quoting it back instead of reasoning about it. The first entry is what the
 * author asked for, which is the part a design review is about.
 */
function meaningfulFontFamily(value: string): string {
  const first = value.split(',')[0]?.trim() ?? '';
  return first.length > 0 && first.length <= 64 ? first : value;
}

/**
 * A shadow whose every layer is fully transparent draws nothing. A real
 * component carried three such layers — 100 characters, 15% of its evidence
 * block, all of it invisible.
 */
function isInvisibleShadow(value: string): boolean {
  // Split on the separators between layers only, never on a comma inside a
  // function's argument list.
  const layers = value.split(/,(?![^(]*\))/);
  if (layers.length === 0) return false;
  const functional = /^rgba?\([^)]*\)|^hsla?\([^)]*\)|^color\([^)]*\)/i;
  return layers.every((rawLayer) => {
    const layer = rawLayer.trim();
    if (layer.length === 0) return false;
    // A layer with no explicit colour uses currentColor, which is opaque for
    // our purposes — it draws something.
    const colour = layer.match(functional);
    if (colour !== null) {
      const text = colour[0];
      if (/^transparent$/i.test(text)) return true;
      if (/^color\(/i.test(text)) return false;
      const parts = text.slice(text.indexOf('(') + 1, -1).split(/[,/]/);
      // rgb()/hsl() without an alpha component is fully opaque.
      if (parts.length < 4) return false;
      const alpha = (parts[3] ?? '').trim();
      if (alpha === '') return false;
      const numeric = alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha);
      return Number.isFinite(numeric) && numeric === 0;
    }
    if (/(?:^|[\s(,])transparent(?=[\s,)]|$)/i.test(layer)) return true;
    if (/^#[0-9a-f]{3,8}$/i.test(layer)) return false;
    return false;
  });
}

/** A 1x1 canvas is the only reliable way to get sRGB bytes out of oklch(). */
function canvasColorToHex(value: string): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const resolved = context.fillStyle;
    // An unparseable value leaves fillStyle untouched: black-on-black would
    // masquerade as a real answer, so refuse instead of reporting #000000.
    if (sameStyleValue(resolved, '#000000') && !STYLE_FACT_HEX.test(value)) {
      if (!/^(?:#000000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value)) return null;
    }
    const data = context.getImageData(0, 0, 1, 1).data;
    if (data[3] === 0) return 'transparent';
    const hex = (channel: number): string => channel.toString(16).padStart(2, '0');
    return `#${hex(data[0] ?? 0)}${hex(data[1] ?? 0)}${hex(data[2] ?? 0)}`;
  } catch {
    return null;
  }
}

/**
 * getComputedStyle preserves the authored color space (oklch(), color(srgb …)),
 * which a 9B model cannot read. Everything becomes #rrggbb or `transparent`.
 * An unconvertible value is dropped rather than passed through: style values
 * reach the model prompt, and raw passthrough is the injection path.
 */
export function normalizeStyleColor(value: string): string | null {
  const text = value.trim();
  if (text.length === 0 || text.length > 200) return null;
  if (STYLE_FACT_TRANSPARENT.test(text)) return 'transparent';
  if (STYLE_FACT_HEX.test(text)) return text.toLowerCase();
  if (STYLE_FACT_RGB.test(text)) return text.toLowerCase().replace(STYLE_FACT_WHITESPACE, ' ');
  return canvasColorToHex(text);
}

const STYLE_FACT_COLOR_PROPS: ReadonlySet<string> = new Set([
  'color', 'background-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'caret-color', 'fill', 'stroke',
]);

/** Reported as the first family only — see meaningfulFontFamily. */
const STYLE_FACT_FAMILY_PROPS: ReadonlySet<string> = new Set(['font-family']);

function styleTagName(el: Element): string | null {
  let tag = '';
  try {
    tag = el.tagName.toLowerCase();
  } catch {
    return null;
  }
  return STYLE_FACT_TAG_NAME.test(tag) ? tag : null;
}

function styleSegment(el: Element): string | null {
  const tag = styleTagName(el);
  if (tag === null) return null;
  let className = '';
  try {
    className = (el.getAttribute('class') ?? '').split(' ')[0] ?? '';
  } catch {
    className = '';
  }
  return STYLE_FACT_CLASS.test(className) ? `${tag}.${className}` : tag;
}

/** Nearest-first ancestor chain, e.g. ["header.nav", "main"]. Stops at body. */
function collectAncestors(el: Element): string[] {
  const chain: string[] = [];
  let current = el.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < STYLE_FACT_ANCESTOR_DEPTH) {
    const segment = styleSegment(current);
    if (segment !== null) chain.push(segment);
    current = current.parentElement;
    depth += 1;
  }
  return chain;
}

function collectLabel(el: Element): string | null {
  let label: string | null = null;
  try {
    label = el.getAttribute('aria-label');
    if (label === null || label.trim().length === 0) label = el.textContent;
  } catch {
    return null;
  }
  if (label === null) return null;
  return cleanStyleValue(label, STYLE_FACT_LABEL_CHARS);
}

function collectGeometry(el: Element): StyleFactsGeometry | null {
  try {
    const rect = el.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  } catch {
    return null;
  }
}

// ---- Derived measurements (§9e) ---------------------------------------------
// Everything here is arithmetic a model would otherwise be asked to do. The
// observed failure was concrete: the same two colours came back as 4.80:1 in
// one run and 3.2:1 in the next. A number that moves between runs is not a
// measurement, so the arithmetic happens once, here, where there is only one
// way to get it right — and where a value that cannot be measured is reported
// as unmeasurable instead of estimated.

interface StyleFactRgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const DERIVED_HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const DERIVED_HEX4 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const DERIVED_HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const DERIVED_HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const DERIVED_RGB_FN =
  /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[,/]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+)\s*%?\s*)?\)$/i;
const DERIVED_NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Channels out of an already-normalized value: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(). */
function parseStyleColorChannels(value: string): StyleFactRgba | null {
  const text = value.trim();
  if (STYLE_FACT_TRANSPARENT.test(text)) return { r: 0, g: 0, b: 0, a: 0 };
  const short3 = DERIVED_HEX3.exec(text);
  if (short3) {
    return {
      r: parseInt(short3[1] + short3[1], 16),
      g: parseInt(short3[2] + short3[2], 16),
      b: parseInt(short3[3] + short3[3], 16),
      a: 1,
    };
  }
  const short4 = DERIVED_HEX4.exec(text);
  if (short4) {
    return {
      r: parseInt(short4[1] + short4[1], 16),
      g: parseInt(short4[2] + short4[2], 16),
      b: parseInt(short4[3] + short4[3], 16),
      a: parseInt(short4[4] + short4[4], 16) / 255,
    };
  }
  const long6 = DERIVED_HEX6.exec(text);
  if (long6) {
    return { r: parseInt(long6[1], 16), g: parseInt(long6[2], 16), b: parseInt(long6[3], 16), a: 1 };
  }
  const long8 = DERIVED_HEX8.exec(text);
  if (long8) {
    return {
      r: parseInt(long8[1], 16),
      g: parseInt(long8[2], 16),
      b: parseInt(long8[3], 16),
      a: parseInt(long8[4], 16) / 255,
    };
  }
  const fn = DERIVED_RGB_FN.exec(text);
  if (!fn) return null;
  const channel = (raw: string | undefined): number => {
    if (raw === undefined) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0;
  };
  const alpha = fn[4] === undefined ? 1 : Number(fn[4]);
  return {
    r: channel(fn[1]),
    g: channel(fn[2]),
    b: channel(fn[3]),
    a: Number.isFinite(alpha) ? Math.min(1, Math.max(0, fn[4]?.endsWith('%') ? alpha / 100 : alpha)) : 1,
  };
}

function channelHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

/** The backdrop colour the text is actually drawn on, or null if unknowable. */
function effectiveBackdrop(el: Element): StyleFactRgba | null {
  let current: Element | null = el;
  // The walk needs its own getComputedStyle calls; the ancestor chain in
  // `ancestors` is a string chain and never touched a style.
  while (current) {
    let computed: CSSStyleDeclaration;
    try {
      computed = window.getComputedStyle(current);
    } catch {
      return null;
    }
    if (!computed) return null;
    // A gradient or image anywhere in the chain means the flat colour under
    // the text is not the colour the text sits on.
    let image: string;
    let color: string;
    let opacity: string;
    try {
      image = computed.getPropertyValue('background-image');
      color = computed.getPropertyValue('background-color');
      opacity = computed.getPropertyValue('opacity');
    } catch {
      return null;
    }
    if (image.trim() !== '' && image.trim().toLowerCase() !== 'none') return null;
    if (opacity.trim() !== '' && Number(opacity) < 1) return null;
    const channels = parseStyleColorChannels(normalizeStyleColor(color) ?? '');
    if (channels && channels.a > 0) return channels;
    const parent: Element | null = current.parentElement;
    // The canvas is opaque by definition, and a page that paints no background
    // is white — that is the one assumption made here, and it is the browser's
    // own default rather than a guess about the design.
    if (!parent || parent === document.documentElement.parentElement) {
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    current = parent;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

/** WCAG 2.x relative luminance, in sRGB. */
function relativeLuminance(color: StyleFactRgba): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(foreground: StyleFactRgba, background: StyleFactRgba): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseStyleNumber(value: string): number | null {
  const text = value.trim();
  if (!DERIVED_NUMERIC.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * A length in px. getComputedStyle resolves font-size to `24px`, not `24`, so
 * a bare-number parser would read every real font size as zero and the
 * large-text threshold could never fire in a browser.
 */
function parseStylePixels(value: string): number | null {
  const text = value.trim();
  if (text.endsWith('px')) return parseStyleNumber(text.slice(0, -2));
  return parseStyleNumber(text);
}

/** WCAG 1.4.3: 4.5:1 normally, 3:1 at 18pt, or 14pt bold. */
function contrastMinimum(fontSize: number, fontWeight: number): { min: number; large: boolean } {
  const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
  return { min: large ? 3 : 4.5, large };
}

/**
 * Three outcomes, not two. A verdict, `unmeasurable` when the styles were read
 * and the backdrop genuinely is not a flat colour, and null when the inputs
 * could not be read at all — an element with no text has no contrast, and
 * calling that "unmeasurable" would fill every prompt with a caveat about
 * something nobody asked.
 */
function collectContrast(
  el: Element,
  computed: CSSStyleDeclaration,
): StyleFactsContrast | { unmeasurable: true } | null {
  const text = parseStyleColorChannels(normalizeStyleColor(computed.getPropertyValue('color')) ?? '');
  if (!text || text.a === 0) return null;
  const backdrop = effectiveBackdrop(el);
  if (!backdrop) return { unmeasurable: true };
  let opacity: string;
  try {
    opacity = computed.getPropertyValue('opacity');
  } catch {
    return null;
  }
  const alpha = parseStyleNumber(opacity);
  if (alpha !== null && alpha < 1) return { unmeasurable: true };
  // Source-over in sRGB, which is what the compositor does.
  const composedText: StyleFactRgba =
    text.a >= 1
      ? { r: text.r, g: text.g, b: text.b, a: 1 }
      : {
          r: text.r * text.a + backdrop.r * (1 - text.a),
          g: text.g * text.a + backdrop.g * (1 - text.a),
          b: text.b * text.a + backdrop.b * (1 - text.a),
          a: 1,
        };
  const size = parseStylePixels(computed.getPropertyValue('font-size')) ?? 0;
  const weight = parseStyleNumber(computed.getPropertyValue('font-weight')) ?? 400;
  const { min, large } = contrastMinimum(size, weight);
  const ratio = Math.round(contrastRatio(composedText, backdrop) * 100) / 100;
  return {
    ratio,
    min,
    pass: ratio >= min,
    large,
    background: `#${channelHex(backdrop.r)}${channelHex(backdrop.g)}${channelHex(backdrop.b)}`,
  };
}

/**
 * Content-box overflow. `false` is the expected state and is not reported: the
 * absence of this field means "not truncated", the same way an omitted
 * default-valued property means "nothing surprising here".
 */
function collectTruncated(el: Element): boolean | null {
  try {
    const clientWidth = el.clientWidth;
    const clientHeight = el.clientHeight;
    // A zero client box means there is no layout to overflow, which is a
    // measurement failure rather than a measurement of "fits".
    if (!Number.isFinite(clientWidth) || clientWidth <= 0) return null;
    const horizontal = el.scrollWidth > clientWidth + 1;
    const vertical = Number.isFinite(clientHeight) && clientHeight > 0 && el.scrollHeight > clientHeight + 1;
    return horizontal || vertical ? true : null;
  } catch {
    return null;
  }
}

/** Only a font the document actually declares can fail to load. */
function collectFontLoad(computed: CSSStyleDeclaration): 'fallback' | 'unknown' | null {
  const stack = computed.getPropertyValue('font-family').trim();
  if (stack.length === 0) return null;
  const family = stack.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
  if (family.length === 0 || family === 'inherit' || family === 'initial') return null;
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts || typeof fonts.check !== 'function') return 'unknown';
  let declared = false;
  try {
    for (const face of fonts) {
      const name = face.family.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (name === family.toLowerCase()) {
        declared = true;
        break;
      }
    }
  } catch {
    return 'unknown';
  }
  // A family the document never declared is a local or system font; there is
  // no load event that could have failed, so there is nothing to report.
  if (!declared) return null;
  const weight = computed.getPropertyValue('font-weight').trim();
  try {
    return fonts.check(`${weight || '400'} 16px ${family}`) ? null : 'fallback';
  } catch {
    return 'unknown';
  }
}

function collectDerived(el: Element, computed: CSSStyleDeclaration): StyleFactsDerived | null {
  const derived: StyleFactsDerived = {};
  let present = false;
  try {
    const contrast = collectContrast(el, computed);
    if (contrast !== null) {
      derived.contrast = contrast;
      present = true;
    }
  } catch {
    // A measurement that throws is not a measurement.
  }
  const truncated = collectTruncated(el);
  if (truncated === true) {
    derived.truncated = true;
    present = true;
  }
  const fontLoad = collectFontLoad(computed);
  if (fontLoad !== null) {
    derived.fontLoad = fontLoad;
    present = true;
  }
  return present ? derived : null;
}

/**
 * One live read per record, uncached: the record's target is null after a route
 * change, and emitSnapshot only fires on discrete events, so reading on demand is
 * both always-correct and cheap enough. The derived measurements add more reads
 * of their own — the backdrop walk reads up the ancestor chain, and only when
 * the element's own background is transparent.
 */
export function collectStyleFacts(el: Element): StyleFacts | undefined {
  let computed: CSSStyleDeclaration;
  try {
    computed = window.getComputedStyle(el);
  } catch {
    return undefined;
  }
  if (!computed) return undefined;
  const props: Record<string, string> = {};
  let count = 0;
  for (const property of STYLE_FACT_PROPS) {
    let raw: string;
    try {
      raw = computed.getPropertyValue(property);
    } catch {
      continue;
    }
    const cleaned = cleanStyleValue(raw, STYLE_FACT_VALUE_CHARS);
    if (cleaned === null) continue;
    // Default check comes before color normalization so that a transparent
    // background is recognized as the default it is, not as "transparent".
    const fallback = STYLE_FACT_DEFAULTS[property];
    if (fallback !== undefined && sameStyleValue(cleaned, fallback)) continue;
    if (STYLE_FACT_ZERO_DEFAULT_PROPS.has(property) && STYLE_FACT_ZERO_LENGTH.test(cleaned)) continue;
    if (property === 'box-shadow' && isInvisibleShadow(cleaned)) continue;
    const value = STYLE_FACT_COLOR_PROPS.has(property)
      ? normalizeStyleColor(cleaned)
      : STYLE_FACT_FAMILY_PROPS.has(property)
        ? meaningfulFontFamily(cleaned)
        : cleaned;
    if (value === null) continue;
    if (Object.hasOwn(props, property)) continue;
    props[property] = value;
    count += 1;
  }
  const geometry = collectGeometry(el);
  const label = collectLabel(el);
  const ancestors = collectAncestors(el);
  const tagName = styleTagName(el);
  const derived = collectDerived(el, computed);

  // Drop the currentColor echoes now that `color` has been resolved. `color` is
  // the first property in the list, so it is already decided by this point; if
  // it was itself a default then these were too.
  const textColor = props['color'];
  if (textColor !== undefined) {
    for (const property of STYLE_FACT_CURRENT_COLOR_PROPS) {
      const value = props[property];
      if (value === undefined || !sameStyleValue(value, textColor)) continue;
      delete props[property];
      count -= 1;
    }
  }

  if (
    count === 0 &&
    geometry === null &&
    label === null &&
    ancestors.length === 0 &&
    tagName === null &&
    derived === null
  ) {
    return undefined;
  }
  return {
    props,
    ...(geometry === null ? {} : { geometry }),
    ...(label === null ? {} : { label }),
    ...(ancestors.length === 0 ? {} : { ancestors }),
    ...(tagName === null ? {} : { tagName }),
    ...(derived === null ? {} : { derived }),
  };
}

export interface PreviewResultPayload {
  bindingId: string;
  transactionId: string;
  operation: PreviewOperation;
  status: PreviewStatus;
  anchors: PreviewAnchorResult[];
  routeKey: string;
  routeEpoch: number;
}

const PREVIEW_MAX_BINDING_ID_CHARS = 200;
const PREVIEW_MAX_TRANSACTION_ID_CHARS = 256;
const PREVIEW_MAX_TRANSACTION_IDS = 64;
const PREVIEW_MAX_ELEMENT_KEY_CHARS = 512;
const PREVIEW_MAX_ROUTE_KEY_CHARS = 512;
const PREVIEW_MAX_TAG_CHARS = 64;
const PREVIEW_MAX_ANCHOR_ID_CHARS = 256;
const PREVIEW_MAX_TEST_ID_CHARS = 256;
const PREVIEW_MAX_PATH_CHARS = 1_024;
const PREVIEW_MAX_CHANGES = 12;
const PREVIEW_MAX_DECLARATIONS = 12;
const PREVIEW_MAX_VALUE_CHARS = 120;
const PREVIEW_MAX_MATCH_COUNT = 1_000;
const PREVIEW_MAX_LENGTH = 4_000;
const PREVIEW_MAX_PERCENT = 400;
const PREVIEW_MAX_COLOR_CHANNELS = 4;
const PREVIEW_MAX_FONT_FAMILIES = 4;
const PREVIEW_MAX_SHADOW_LAYERS = 4;
const PREVIEW_MAX_LAYERS = 128;
const PREVIEW_MAX_LAYERS_PER_BINDING = 16;
const PREVIEW_BASE_SPECIFICITY = 3;
const PREVIEW_MAX_SPECIFICITY = 12;
const PREVIEW_ATTRIBUTE_PREFIX = 'data-vera-inspector-pv-';
const PREVIEW_LAYER_MARKER = 'preview-layer';
const PREVIEW_NO_TRANSACTION = '*';
const PREVIEW_CHANGE_KEYS: ReadonlySet<string> = new Set(['anchor', 'declarations']);
const PREVIEW_ANCHOR_KEYS: ReadonlySet<string> = new Set([
  'elementKey',
  'routeKey',
  'mode',
  'tagName',
  'id',
  'testId',
  'path',
]);
const PREVIEW_TAG_NAME_RE = /^[a-z][a-z0-9-]*$/;

const PREVIEW_PROPERTY_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PREVIEW_VALUE_CHARSET_RE = /^[A-Za-z0-9 \t#%.,()/_'"-]+$/;
const PREVIEW_FUNCTION_NAME_RE = /([A-Za-z-]+)\(/g;
const PREVIEW_NUMBER_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const PREVIEW_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PREVIEW_COLOR_FUNCTION_RE = /^(rgba?|hsla?)\(([^()]*)\)$/;
const PREVIEW_FONT_FAMILY_RE = /^(?:"[^"]{1,64}"|'[^']{1,64}'|[A-Za-z0-9][A-Za-z0-9 _.-]{0,63})$/;
const PREVIEW_ASPECT_PART_RE = /^(?:\d{1,5}(?:\.\d{1,6})?|\.\d{1,6})$/;
const PREVIEW_OVERFLOW_RE = /^(visible|hidden|clip|scroll|auto)$/;
const PREVIEW_FONT_STYLE_RE = /^(normal|italic|oblique)$/;
const PREVIEW_FONT_SIZE_RE = /^(xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/;
const PREVIEW_FONT_WEIGHT_RE = /^(normal|bold)$/;
const PREVIEW_TEXT_ALIGN_RE = /^(left|right|center|justify|start|end)$/;
const PREVIEW_TEXT_TRANSFORM_RE = /^(none|capitalize|uppercase|lowercase)$/;
const PREVIEW_TEXT_OVERFLOW_RE = /^(clip|ellipsis)$/;
const PREVIEW_WHITE_SPACE_RE = /^(normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/;
const PREVIEW_VERTICAL_ALIGN_RE = /^(baseline|middle|super|sub|text-top|text-bottom|top|bottom)$/;
const PREVIEW_FORBIDDEN_SUBSTRINGS = ['!', '*', '\\', ';', ':', '{', '}', '@', '<', '>', '$', '`', '|', '&'];

const PREVIEW_ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

const PREVIEW_LENGTH_UNITS: ReadonlySet<string> = new Set([
  'px', 'rem', 'em', 'ch', 'pt', 'vh', 'vw', 'vmin', 'vmax',
]);

const PREVIEW_BORDER_STYLE_KEYWORDS: ReadonlySet<string> = new Set([
  'none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset',
]);

const PREVIEW_TEXT_DECORATION_TOKENS: ReadonlySet<string> = new Set([
  'none', 'underline', 'line-through', 'overline',
]);

const PREVIEW_COLOR_KEYWORDS: ReadonlySet<string> = new Set([
  'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'black', 'white', 'red', 'green',
  'blue', 'yellow', 'orange', 'purple', 'pink', 'brown', 'gray', 'grey', 'silver', 'gold', 'beige',
  'ivory', 'coral', 'salmon', 'crimson', 'indigo', 'violet', 'teal', 'olive', 'maroon', 'navy',
  'aqua', 'cyan', 'fuchsia', 'magenta', 'lime', 'tan', 'khaki', 'plum', 'orchid', 'tomato', 'wheat',
  'azure', 'lavender', 'linen', 'snow', 'seashell', 'sienna', 'peru', 'chocolate', 'firebrick',
  'darkgray', 'darkgrey', 'lightgray', 'lightgrey', 'dimgray', 'slategray', 'slategrey',
  'darkslategray', 'steelblue', 'skyblue', 'royalblue', 'midnightblue', 'darkslategrey',
  'dodgerblue', 'seagreen', 'forestgreen', 'darkgreen', 'olivedrab', 'slateblue',
]);

const PREVIEW_LENGTH_PROPERTIES: readonly string[] = [
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius',
  'border-bottom-left-radius', 'letter-spacing',
  // Spacing between items. Pure spacing, no layout side effect beyond the gap.
  'gap', 'row-gap', 'column-gap',
];

const PREVIEW_LENGTH_LIST_PROPERTIES: readonly string[] = [
  'margin', 'padding', 'border-width', 'border-radius',
];

const PREVIEW_BORDER_STYLE_PROPERTIES: readonly string[] = [
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
];

const PREVIEW_COLOR_PROPERTIES: readonly string[] = [
  'color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-left-color',
];

const PREVIEW_ALLOWED_PROPERTIES: ReadonlySet<string> = new Set<string>([
  ...PREVIEW_LENGTH_PROPERTIES,
  ...PREVIEW_LENGTH_LIST_PROPERTIES,
  ...PREVIEW_COLOR_PROPERTIES,
  ...PREVIEW_BORDER_STYLE_PROPERTIES,
  'border-style',
  'opacity',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'line-height',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'text-overflow',
  'white-space',
  'overflow',
  'aspect-ratio',
  'box-shadow',
  'vertical-align',
]);

type PreviewDeclarationsCheck =
  | { ok: true; declarations: Record<string, string> }
  | { ok: false; reason: string; property?: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function previewCountChar(value: string, char: string): number {
  let total = 0;
  for (const c of value) {
    if (c === char) total += 1;
  }
  return total;
}

function previewSplitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of value) {
    if (c === '(') depth += 1;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

function previewTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of value.trim()) {
    if (c === '(') depth += 1;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(c)) {
      if (current !== '') tokens.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

function previewIsNumber(value: string): boolean {
  return PREVIEW_NUMBER_RE.test(value);
}

function previewIsPercentage(value: string): boolean {
  return value.endsWith('%') && previewIsNumber(value.slice(0, -1));
}

function previewIsLength(value: string): boolean {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/.exec(value.toLowerCase());
  if (match === null) return false;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return false;
  const unit = match[2] ?? '';
  if (unit === '') return parsed === 0;
  if (unit === '%') return parsed >= -PREVIEW_MAX_PERCENT && parsed <= PREVIEW_MAX_PERCENT;
  if (!PREVIEW_LENGTH_UNITS.has(unit)) return false;
  return parsed >= -PREVIEW_MAX_LENGTH && parsed <= PREVIEW_MAX_LENGTH;
}

function previewIsLengthList(value: string): boolean {
  const tokens = previewTokens(value);
  if (tokens.length < 1 || tokens.length > 4) return false;
  return tokens.every(previewIsLength);
}

function previewIsColorAlpha(raw: string): boolean {
  if (raw === '') return false;
  if (previewIsPercentage(raw)) {
    const value = Number(raw.slice(0, -1));
    return value >= 0 && value <= 100;
  }
  if (!previewIsNumber(raw)) return false;
  const value = Number(raw);
  return value >= 0 && value <= 1;
}

function previewColorArguments(
  name: string,
  args: string,
): { channels: string[]; alpha: string | null } | null {
  const commaParts = previewSplitTopLevel(args, ',');
  if (commaParts.length > 1) {
    if (commaParts.length < 3 || commaParts.length > PREVIEW_MAX_COLOR_CHANNELS) return null;
    const channels = commaParts.slice(0, 3).map((part) => part.trim());
    if (channels.some((part) => part === '')) return null;
    const alpha = commaParts.length === 4 ? commaParts[3].trim() : null;
    if (alpha !== null && alpha === '') return null;
    return { channels, alpha };
  }
  const slashParts = args.split('/');
  if (slashParts.length > 2) return null;
  const channels = previewTokens(slashParts[0] ?? '');
  if (channels.length !== 3) return null;
  const alpha = slashParts.length === 2 ? (slashParts[1] ?? '').trim() : null;
  if (alpha !== null && alpha === '') return null;
  if (alpha === null && name === 'rgba') return null;
  return { channels, alpha };
}

function previewIsColor(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (text === '') return false;
  if (PREVIEW_COLOR_KEYWORDS.has(text)) return true;
  if (PREVIEW_HEX_COLOR_RE.test(text)) return true;
  const match = PREVIEW_COLOR_FUNCTION_RE.exec(text);
  if (match === null) return false;
  const name = match[1] ?? '';
  const parsed = previewColorArguments(name, match[2] ?? '');
  if (parsed === null) return false;
  const channels = parsed.channels;
  if (name === 'rgb' || name === 'rgba') {
    const allNumbers = channels.every(previewIsNumber);
    const allPercent = channels.every(previewIsPercentage);
    if (!allNumbers && !allPercent) return false;
    for (const part of channels) {
      if (allNumbers) {
        const channel = Number(part);
        if (channel < 0 || channel > 255) return false;
      } else {
        const channel = Number(part.slice(0, -1));
        if (channel < 0 || channel > 100) return false;
      }
    }
    if (parsed.alpha !== null) return previewIsColorAlpha(parsed.alpha);
    return name === 'rgb';
  }
  const hue = channels[0] ?? '';
  const hueValue = hue.endsWith('deg') ? hue.slice(0, -3) : hue;
  if (!previewIsNumber(hueValue)) return false;
  const degrees = Number(hueValue);
  if (degrees < 0 || degrees > 360) return false;
  const saturation = channels[1] ?? '';
  const lightness = channels[2] ?? '';
  if (!previewIsPercentage(saturation) || !previewIsPercentage(lightness)) return false;
  if (Number(saturation.slice(0, -1)) > 100) return false;
  if (Number(lightness.slice(0, -1)) > 100) return false;
  if (parsed.alpha !== null) return previewIsColorAlpha(parsed.alpha);
  return name === 'hsl';
}

function previewIsOpacity(value: string): boolean {
  const text = value.toLowerCase();
  if (previewIsPercentage(text)) {
    const parsed = Number(text.slice(0, -1));
    return parsed >= 0 && parsed <= 100;
  }
  if (!previewIsNumber(text)) return false;
  const parsed = Number(text);
  return parsed >= 0 && parsed <= 1;
}

function previewIsFontSize(value: string): boolean {
  const text = value.toLowerCase();
  if (PREVIEW_FONT_SIZE_RE.test(text)) return true;
  return previewIsLength(text);
}

function previewIsFontWeight(value: string): boolean {
  const text = value.toLowerCase();
  if (PREVIEW_FONT_WEIGHT_RE.test(text)) return true;
  if (!previewIsNumber(text)) return false;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000;
}

function previewIsLineHeight(value: string): boolean {
  const text = value.toLowerCase();
  if (text === 'normal') return true;
  if (previewIsNumber(text)) {
    const parsed = Number(text);
    return parsed >= 0 && parsed <= 4;
  }
  return previewIsLength(text);
}

function previewIsVerticalAlign(value: string): boolean {
  const text = value.toLowerCase();
  if (PREVIEW_VERTICAL_ALIGN_RE.test(text)) return true;
  return previewIsLength(text);
}

function previewIsTextDecorationLine(value: string): boolean {
  const tokens = previewTokens(value.toLowerCase());
  if (tokens.length < 1 || tokens.length > 3) return false;
  if (!tokens.some((token) => PREVIEW_TEXT_DECORATION_TOKENS.has(token))) return false;
  if (tokens.includes('none') && tokens.length > 1) return false;
  return tokens.every((token) => PREVIEW_TEXT_DECORATION_TOKENS.has(token));
}

function previewIsFontFamily(value: string): boolean {
  const families = previewSplitTopLevel(value, ',');
  if (families.length < 1 || families.length > PREVIEW_MAX_FONT_FAMILIES) return false;
  return families.every((family) => PREVIEW_FONT_FAMILY_RE.test(family.trim()));
}

function previewIsAspectRatio(value: string): boolean {
  const text = value.toLowerCase().replace(/\s+/g, '');
  if (text === 'auto') return true;
  if (text === '') return false;
  const parts = text.split('/');
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((part) => {
    if (!PREVIEW_ASPECT_PART_RE.test(part)) return false;
    const parsed = Number(part);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= PREVIEW_MAX_LENGTH;
  });
}

function previewIsBoxShadow(value: string): boolean {
  const layers = previewSplitTopLevel(value, ',');
  if (layers.length < 1 || layers.length > PREVIEW_MAX_SHADOW_LAYERS) return false;
  return layers.every((layer) => {
    let tokens = previewTokens(layer.toLowerCase());
    if (tokens.length > 0 && tokens[0] === 'inset') tokens = tokens.slice(1);
    if (tokens.length > 0 && previewIsColor(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
    if (tokens.length > 0 && previewIsColor(tokens[0])) tokens = tokens.slice(1);
    if (tokens.length < 2 || tokens.length > 4) return false;
    return tokens.every(previewIsLength);
  });
}

function previewIsEnum(pattern: RegExp): (value: string) => boolean {
  return (value: string): boolean => pattern.test(value.toLowerCase());
}

function previewIsKeywordList(
  allowed: ReadonlySet<string>,
  maxTokens: number,
): (value: string) => boolean {
  return (value: string): boolean => {
    const tokens = previewTokens(value.toLowerCase());
    if (tokens.length < 1 || tokens.length > maxTokens) return false;
    return tokens.every((token) => allowed.has(token));
  };
}

const PREVIEW_VALUE_CHECKS: ReadonlyMap<string, (value: string) => boolean> = new Map<
  string,
  (value: string) => boolean
>([
  ...PREVIEW_LENGTH_PROPERTIES.map((property) => [property, previewIsLength] as const),
  ...PREVIEW_LENGTH_LIST_PROPERTIES.map((property) => [property, previewIsLengthList] as const),
  ...PREVIEW_COLOR_PROPERTIES.map((property) => [property, previewIsColor] as const),
  ...PREVIEW_BORDER_STYLE_PROPERTIES.map(
    (property) => [property, previewIsKeywordList(PREVIEW_BORDER_STYLE_KEYWORDS, 1)] as const,
  ),
  ['border-style', previewIsKeywordList(PREVIEW_BORDER_STYLE_KEYWORDS, 4)],
  ['opacity', previewIsOpacity],
  ['font-family', previewIsFontFamily],
  ['font-size', previewIsFontSize],
  ['font-style', previewIsEnum(PREVIEW_FONT_STYLE_RE)],
  ['font-weight', previewIsFontWeight],
  ['line-height', previewIsLineHeight],
  ['text-align', previewIsEnum(PREVIEW_TEXT_ALIGN_RE)],
  ['text-transform', previewIsEnum(PREVIEW_TEXT_TRANSFORM_RE)],
  ['text-decoration-line', previewIsTextDecorationLine],
  ['text-overflow', previewIsEnum(PREVIEW_TEXT_OVERFLOW_RE)],
  ['white-space', previewIsEnum(PREVIEW_WHITE_SPACE_RE)],
  ['overflow', previewIsEnum(PREVIEW_OVERFLOW_RE)],
  ['aspect-ratio', previewIsAspectRatio],
  ['box-shadow', previewIsBoxShadow],
  ['vertical-align', previewIsVerticalAlign],
]);

function previewForbiddenTokenReason(value: string): string | null {
  for (const token of PREVIEW_FORBIDDEN_SUBSTRINGS) {
    if (value.includes(token)) return 'forbidden-token';
  }
  if (!PREVIEW_VALUE_CHARSET_RE.test(value)) return 'forbidden-token';
  PREVIEW_FUNCTION_NAME_RE.lastIndex = 0;
  let match = PREVIEW_FUNCTION_NAME_RE.exec(value);
  while (match !== null) {
    if (!PREVIEW_ALLOWED_FUNCTIONS.has((match[1] ?? '').toLowerCase())) return 'forbidden-token';
    match = PREVIEW_FUNCTION_NAME_RE.exec(value);
  }
  if (previewCountChar(value, '(') !== previewCountChar(value, ')')) return 'invalid-value';
  return null;
}

function previewValidateDeclaration(property: string, value: unknown): PreviewDeclarationsCheck {
  if (property.length === 0) return { ok: false, reason: 'empty-property' };
  if (property.length > 64) return { ok: false, reason: 'invalid-property-name', property };
  if (!PREVIEW_PROPERTY_NAME_RE.test(property)) {
    return { ok: false, reason: 'invalid-property-name', property };
  }
  if (!PREVIEW_ALLOWED_PROPERTIES.has(property)) {
    return { ok: false, reason: 'unknown-property', property };
  }
  if (typeof value !== 'string') return { ok: false, reason: 'value-not-string', property };
  const text = value.trim();
  if (text === '') return { ok: false, reason: 'value-empty', property };
  if (text.length > PREVIEW_MAX_VALUE_CHARS) return { ok: false, reason: 'value-too-long', property };
  const tokenReason = previewForbiddenTokenReason(text);
  if (tokenReason !== null) return { ok: false, reason: tokenReason, property };
  const check = PREVIEW_VALUE_CHECKS.get(property);
  if (check === undefined) return { ok: false, reason: 'unknown-property', property };
  if (!check(text)) return { ok: false, reason: 'invalid-value', property };
  return { ok: true, declarations: { [property]: text } };
}

function validatePreviewDeclarations(input: unknown): PreviewDeclarationsCheck {
  if (!isPlainRecord(input)) return { ok: false, reason: 'not-an-object' };
  const entries = Object.entries(input);
  if (entries.length > PREVIEW_MAX_DECLARATIONS) {
    return { ok: false, reason: 'too-many-declarations' };
  }
  if (entries.length < 1) return { ok: false, reason: 'empty-property' };
  const accepted: Record<string, string> = {};
  for (const [property, value] of entries) {
    const check = previewValidateDeclaration(property, value);
    if (!check.ok) return { ok: false, reason: check.reason, property: check.property ?? property };
    Object.assign(accepted, check.declarations);
  }
  return { ok: true, declarations: accepted };
}

function parseBoundedId(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  if (!allowEmpty && value.length === 0) return null;
  if (value.length > max) return null;
  return value;
}



function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.size) return false;
  for (const key of keys) {
    if (!expected.has(key)) return false;
  }
  return true;
}

function parseInspectorAnchor(raw: unknown): InspectorAnchor | null {
  if (!isPlainRecord(raw)) return null;
  if (!hasExactKeys(raw, PREVIEW_ANCHOR_KEYS)) return null;
  if (raw['mode'] !== 'html') return null;
  const elementKey = parseBoundedId(raw['elementKey'], PREVIEW_MAX_ELEMENT_KEY_CHARS);
  if (elementKey === null) return null;
  const routeKey = parseBoundedId(raw['routeKey'], PREVIEW_MAX_ROUTE_KEY_CHARS);
  if (routeKey === null) return null;
  const tagName = parseBoundedId(raw['tagName'], PREVIEW_MAX_TAG_CHARS);
  if (tagName === null || !PREVIEW_TAG_NAME_RE.test(tagName)) return null;
  const id = parseBoundedId(raw['id'], PREVIEW_MAX_ANCHOR_ID_CHARS, true);
  if (id === null) return null;
  const testId = parseBoundedId(raw['testId'], PREVIEW_MAX_TEST_ID_CHARS, true);
  if (testId === null) return null;
  const path = parseBoundedId(raw['path'], PREVIEW_MAX_PATH_CHARS, true);
  if (path === null) return null;
  return { elementKey, routeKey, mode: 'html', tagName, id, testId, path };
}

export interface R3FRegistration {
  canvas: HTMLCanvasElement;
  getHits?: (clientX: number, clientY: number) => Array<{ elementKey: string; component: string | null; file: string | null; line: number | null; extra?: unknown }>;
}

export interface KonvaRegistration {
  stage: { container: () => HTMLElement };
  getHits?: (clientX: number, clientY: number) => Array<{ elementKey: string; component: string | null; file: string | null; line: number | null; extra?: unknown }>;
}

export function initVeraInspectorBridge(options: BridgeOptions) {
  const expectedAppOrigin = normalizeExpectedOrigin(options.appOrigin);
  const bridgeKind = options.bridgeKind ?? 'native';
  const globalScope = window as typeof window & {
    __DESIGN_INSPECTOR_BRIDGE__?: { destroy?: () => void };
  };
  const previousBridge = globalScope.__DESIGN_INSPECTOR_BRIDGE__;
  if (previousBridge && typeof previousBridge.destroy === 'function') {
    try {
      previousBridge.destroy();
    } catch {
      delete globalScope.__DESIGN_INSPECTOR_BRIDGE__;
    }
  }
  if (globalScope.__DESIGN_INSPECTOR_BRIDGE__ === previousBridge) {
    delete globalScope.__DESIGN_INSPECTOR_BRIDGE__;
  }
  const capabilities = {
    selectionCrop: typeof options.captureElement === 'function',
    maxSelectionImages: 4,
    maxImageBytes: 524288,
    maxImageDimension: 1600,
    maxImagePixels: 2_000_000,
    cssPreview: true,
    maxPreviewChanges: PREVIEW_MAX_CHANGES,
    maxPreviewPropertiesPerChange: PREVIEW_MAX_DECLARATIONS,
    maxPreviewValueLength: PREVIEW_MAX_VALUE_CHARS,
  };
  let mode: BridgeMode = options.initialMode ?? 'html';
  let frozen = false;
  const connectionId = uid('bridge');
  const documentGeneration = uid('doc');
  let sequence = 0;
  let orderCounter = 0;
  let lastHelloRequestId: string | null = null;
  let appHelloReceived = false;
  let lastAppSequence = 0;

  const styleNonce =
    typeof options.styleNonce === 'string' && options.styleNonce.length > 0 && options.styleNonce.length <= 256
      ? options.styleNonce
      : '';

  interface PreviewLayer {
    key: string;
    bindingId: string;
    transactionId: string;
    routeKey: string;
    routeEpoch: number;
    attribute: string;
    marks: Array<{ element: Element; value: string }>;
    styleElement: HTMLStyleElement | null;
    adoptedSheet: CSSStyleSheet | null;
    anchors: InspectorAnchor[];
    specificity: number;
  }

  interface PreviewIndexEntry {
    element: Element;
    key: string;
  }

  const previewLayers = new Map<string, PreviewLayer>();
  const previewBindingOrder = new Map<string, string[]>();
  const cleanupFns: Array<() => void> = [];
  let previewOrdinal = 0;
  let previewLayerCounter = 0;
  let routeKey = '';
  let routeEpoch = 0;

  const byElementKey = new Map<string, Rec>();
  const bySelectionId = new Map<string, Rec>();
  const activeOrder: string[] = [];

  const r3fRegs: R3FRegistration[] = [];
  const konvaRegs: KonvaRegistration[] = [];

  // ---- Shadow DOM overlay host (CSS isolation, §11.3) ----
  const host = document.createElement('div');
  host.setAttribute('data-vera-inspector', 'overlay-host');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .vi-hover { position:fixed; border:1.5px dashed #0ea5e9; border-radius:6px; pointer-events:none; }
    .vi-sel { position:fixed; border:2px solid #0ea5e9; border-radius:6px; pointer-events:none; }
    .vi-label { position:fixed; background:#0ea5e9; color:#fff; font:600 11px/1 system-ui,sans-serif;
      padding:3px 7px; border-radius:999px; pointer-events:none; transform:translateY(-110%); white-space:nowrap; }
  `;
  shadow.appendChild(style);
  const layer = document.createElement('div');
  shadow.appendChild(layer);
  // Pointer shield. Lives in the shadow root so page CSS cannot restyle it, and
  // stays `pointer-events:none` until freeze, at which point the host (which is
  // itself pointer-events:none) opts this single child back in.
  const shield = document.createElement('div');
  shield.setAttribute('data-vera-inspector', 'freeze-shield');
  shield.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
  shadow.appendChild(shield);
  function mountHost() {
    if (!host.isConnected && document.body) document.body.appendChild(host);
  }
  if (document.body) mountHost();
  else document.addEventListener('DOMContentLoaded', mountHost, { once: true });

  let hoverBox: HTMLDivElement | null = null;
  const selBoxes = new Map<string, { box: HTMLDivElement; label: HTMLDivElement }>();
  let captureDepth = 0;
  let capturePreviousDisplay = '';
  const MAX_ACTIVE_SELECTIONS = 4;
  let captureQueue: Promise<void> = Promise.resolve();
  let captureQueueDepth = 0;
  let activeCaptureCancel: ((error: unknown) => void) | null = null;
  let bridgeDestroyed = false;
  let rafPending = false;
  let rafHandle: number | null = null;
  let hoverEl: Element | null = null;

  function send(type: string, payload: unknown, requestId?: string) {
    sequence += 1;
    const bridgePayload = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), bridgeKind }
      : { bridgeKind };
    window.parent.postMessage(
      {
        protocolVersion: PROTOCOL_VERSION,
        type,
        connectionId,
        documentGeneration,
        requestId: requestId ?? uid('req'),
        sequence,
        payload: bridgePayload,
      },
      expectedAppOrigin,
    );
  }

  function styleFactsForRecord(rec: Rec): StyleFacts | undefined {
    const el = rec.target;
    // Same guard as anchorForRecord: a non-HTML mode or a detached target has
    // no computed style to report, and a route change nulls the target, which
    // invalidates the facts for free.
    if (rec.mode !== 'html' || el === null) return undefined;
    try {
      return collectStyleFacts(el);
    } catch {
      return undefined;
    }
  }

  function recordPayload(rec: Rec) {
    const anchor = anchorForRecord(rec);
    const styleFacts = styleFactsForRecord(rec);
    return {
      selectionId: rec.selectionId,
      elementKey: rec.elementKey,
      component: rec.component,
      file: rec.file,
      line: rec.line,
      mode: rec.mode,
      extra: rec.extra,
      state: rec.state,
      order: rec.order,
      ...(anchor === undefined ? {} : { anchor }),
      ...(styleFacts === undefined ? {} : { styleFacts }),
    };
  }

  function snapshotPayload() {
    const selections = [...bySelectionId.values()]
      .filter((r) => r.state === 'active')
      .map((r) => recordPayload(r));
    return {
      connectionId,
      documentGeneration,
      capabilities,
      inspectorFrozen: frozen,
      mode,
      routeKey,
      routeEpoch,
      selections,
      activeOrder: activeOrder.filter((id) => bySelectionId.get(id)?.state === 'active'),
    };
  }

  function emitSnapshot(requestId?: string) {
    send('VERA_INSPECTOR_SNAPSHOT', snapshotPayload(), requestId);
  }

  function emitSelection(rec: Rec) {
    send('VERA_INSPECTOR_SELECTION', {
      record: recordPayload(rec),
      activeOrder: activeOrder.filter((id) => bySelectionId.get(id)?.state === 'active'),
    });
  }

  // ---- Stable elementKey (§5.2): inspector metadata > data attrs > fiber-ish path ----
  function domPathFor(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 8) {
      const parent: Element | null = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      let idx = 0;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur!.tagName);
        idx = sibs.indexOf(cur);
      }
      const cls = typeof cur.getAttribute === 'function' ? (cur.getAttribute('class') ?? '').split(' ')[0] : '';
      parts.unshift(`${tag}${cls ? `.${cls}` : ''}:${idx}`);
      cur = parent;
      depth += 1;
    }
    return parts.join('/');
  }

  function elementKeyFor(el: Element): string {
    const explicit =
      el.getAttribute('data-inspector-key') ?? (el as HTMLElement).dataset?.['inspectorKey'];
    if (explicit) return `html:${explicit}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `html:testid:${testId}`;
    const id = el.id;
    if (id) return `html:id:${id}`;
    // Deterministic DOM path as fallback (stable across remounts with same structure).
    return `html:path:${domPathFor(el)}`;
  }

  function anchorForRecord(rec: Rec): InspectorAnchor | undefined {
    const el = rec.target;
    if (rec.mode !== 'html' || el === null) return undefined;
    let tagName = '';
    let id = '';
    let testId = '';
    let path = '';
    try {
      tagName = el.tagName.toLowerCase();
      id = el.getAttribute('id') ?? '';
      testId = el.getAttribute('data-testid') ?? '';
      path = domPathFor(el);
    } catch {
      return undefined;
    }
    if (!PREVIEW_TAG_NAME_RE.test(tagName)) return undefined;
    return {
      elementKey: rec.elementKey,
      routeKey,
      mode: 'html',
      tagName,
      id,
      testId,
      path,
    };
  }

  function sourceFor(el: Element) {
    if (options.resolveSource) {
      try {
        return options.resolveSource(el);
      } catch {
        // fall through to fallback
      }
    }
    // Explicit fallback: never fabricate (§25.2).
    return {
      component: el.getAttribute('data-inspector-component'),
      file: el.getAttribute('data-inspector-file'),
      line: el.getAttribute('data-inspector-line') !== null ? Number(el.getAttribute('data-inspector-line')) : null,
    };
  }

  function canActivateSelection(): boolean {
    if (activeOrder.length < MAX_ACTIVE_SELECTIONS) return true;
    send('VERA_INSPECTOR_ERROR', {
      code: 'selection-limit',
      message: `Select no more than ${MAX_ACTIVE_SELECTIONS} components at once.`,
    }, uid('limit'));
    return false;
  }

  function selectHtmlElement(el: Element) {
    const key = elementKeyFor(el);
    const existing = byElementKey.get(key);
    if (existing && existing.state === 'active') {
      // Toggle off: same selectionId, becomes inactive (§5.3).
      existing.revision += 1;
      existing.state = 'inactive';
      const i = activeOrder.indexOf(existing.selectionId);
      if (i >= 0) activeOrder.splice(i, 1);
      removeSelBox(existing.selectionId);
      emitSelection(existing);
      return;
    }
    if (existing && existing.state === 'inactive') {
      if (!canActivateSelection()) return;
      // Reselect same logical element: reuse same selectionId (§5.3/5.4).
      existing.revision += 1;
      existing.state = 'active';
      existing.target = el;
      activeOrder.push(existing.selectionId);
      drawSelBox(existing);
      emitSelection(existing);
      return;
    }
    if (!canActivateSelection()) return;
    const src = sourceFor(el);
    const rec: Rec = {
      selectionId: uid('sel'),
      elementKey: key,
      component: src.component ?? el.tagName.toLowerCase(),
      file: src.file,
      line: typeof src.line === 'number' && Number.isFinite(src.line) ? src.line : null,
      mode: 'html',
      extra: undefined,
      state: 'active',
      order: orderCounter++,
      revision: 0,
      target: el,
    };
    byElementKey.set(key, rec);
    bySelectionId.set(rec.selectionId, rec);
    activeOrder.push(rec.selectionId);
    drawSelBox(rec);
    emitSelection(rec);
  }

  function clearSelectionById(selectionId: string) {
    const rec = bySelectionId.get(selectionId);
    if (!rec) return;
    rec.revision += 1;
    rec.state = 'inactive';
    const i = activeOrder.indexOf(selectionId);
    if (i >= 0) activeOrder.splice(i, 1);
    removeSelBox(selectionId);
    emitSelection(rec);
  }

  function clearAll() {
    for (const id of [...activeOrder]) {
      const rec = bySelectionId.get(id);
        if (rec) {
          rec.revision += 1;
          rec.state = 'inactive';
        removeSelBox(id);
        emitSelection(rec);
      }
    }
    activeOrder.length = 0;
  }

  /**
   * Re-activates a selection the app already holds, keeping its selectionId so
   * the citation numbering survives. An undo in the composer has to bring the
   * target highlight back with the tag, and a deselected record is retained here
   * precisely so this can happen.
   *
   * A record whose element is gone from the page (a route change or a session
   * reset dropped its target) is left inactive: an active selection with nothing
   * to outline would be a lie the model would then reason about.
   */
  function reselectSelectionById(selectionId: string) {
    const rec = bySelectionId.get(selectionId);
    if (!rec) return;
    if (rec.state === 'active') {
      emitSelection(rec);
      return;
    }
    if (!rec.target || !rec.target.isConnected) return;
    if (!canActivateSelection()) return;
    rec.revision += 1;
    rec.state = 'active';
    activeOrder.push(rec.selectionId);
    // Following a citation from the answer is pointless if the element is off
    // screen, and a box drawn outside the viewport outlines nothing.
    try {
      rec.target.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch {
      // A target that refuses to scroll still gets its outline.
    }
    drawSelBox(rec);
    emitSelection(rec);
  }

  function safeCaptureDetails(error: unknown): { code: string; message: string } {
    let code = 'capture-failed';
    try {
      if (error && typeof error === 'object') {
        const candidate = (error as { code?: unknown }).code;
        if (
          typeof candidate === 'string' &&
          Object.prototype.hasOwnProperty.call(SAFE_CAPTURE_MESSAGES, candidate)
        ) {
          code = candidate;
        }
      }
    } catch {
      code = 'capture-failed';
    }
    return { code, message: SAFE_CAPTURE_MESSAGES[code] };
  }

  function sendCaptureMessage(type: string, payload: Record<string, unknown>, requestId: string): boolean {
    try {
      send(type, payload, requestId);
      return true;
    } catch {
      return false;
    }
  }

  function sendCaptureError(requestId: string, code: string, messageKey?: string): boolean {
    const safeCode = Object.prototype.hasOwnProperty.call(SAFE_CAPTURE_MESSAGES, code)
      ? code
      : 'capture-failed';
    const override = typeof messageKey === 'string' && Object.prototype.hasOwnProperty.call(SAFE_CAPTURE_MESSAGE_OVERRIDES, messageKey)
      ? SAFE_CAPTURE_MESSAGE_OVERRIDES[messageKey]
      : undefined;
    const safeMessage = override ?? SAFE_CAPTURE_MESSAGES[safeCode];
    return sendCaptureMessage(
      'VERA_INSPECTOR_ERROR',
      { code: safeCode, message: safeMessage },
      requestId,
    );
  }

  function sendCaptureFailure(requestId: string, error: unknown): boolean {
    const details = safeCaptureDetails(error);
    return sendCaptureMessage('VERA_INSPECTOR_ERROR', details, requestId);
  }

  function isCaptureAsset(value: unknown): value is CaptureAsset {
    try {
      if (!value || typeof value !== 'object') return false;
      const asset = value as Record<string, unknown>;
      if (
        (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') ||
        typeof asset.base64 !== 'string' ||
        typeof asset.width !== 'number' ||
        typeof asset.height !== 'number' ||
        typeof asset.byteLength !== 'number'
      ) return false;
      const padding = asset.base64.endsWith('==') ? 2 : asset.base64.endsWith('=') ? 1 : 0;
      const decodedLength = Math.floor(asset.base64.length * 3 / 4) - padding;
      const signatureMatches =
        (asset.mimeType === 'image/png' && asset.base64.startsWith('iVBORw0KGgo')) ||
        (asset.mimeType === 'image/jpeg' && asset.base64.startsWith('/9j/'));
      return (
        Number.isSafeInteger(asset.width) &&
        Number.isSafeInteger(asset.height) &&
        Number.isSafeInteger(asset.byteLength) &&
        Number.isFinite(asset.width) &&
        Number.isFinite(asset.height) &&
        Number.isFinite(asset.byteLength) &&
        asset.width > 0 &&
        asset.height > 0 &&
        asset.byteLength > 0 &&
        asset.base64.length > 0 &&
        asset.base64.length <= 700_000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64) &&
        decodedLength === asset.byteLength &&
        signatureMatches &&
        asset.width <= capabilities.maxImageDimension &&
        asset.height <= capabilities.maxImageDimension &&
        Number.isFinite(asset.width * asset.height) &&
        asset.width * asset.height <= capabilities.maxImagePixels &&
        asset.byteLength <= capabilities.maxImageBytes
      );
    } catch {
      return false;
    }
  }

  function captureWithTimeout(target: Element): Promise<CaptureAsset> {
    return new Promise<CaptureAsset>((resolve, reject) => {
      let settled = false;
      let timer: number | null = null;
      let cancel: ((error: unknown) => void) | null = null;
      const clearActive = () => {
        if (cancel && activeCaptureCancel === cancel) activeCaptureCancel = null;
      };
      const finish = (callback: (value: CaptureAsset) => void, value: CaptureAsset) => {
        if (settled) return;
        settled = true;
        clearActive();
        if (timer !== null) {
          try {
            window.clearTimeout(timer);
          } catch {
            timer = null;
          }
        }
        callback(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearActive();
        if (timer !== null) {
          try {
            window.clearTimeout(timer);
          } catch {
            timer = null;
          }
        }
        reject(error);
      };
      cancel = (error: unknown) => fail(error);
      activeCaptureCancel = cancel;
      try {
        timer = window.setTimeout(
          () => fail({ code: 'capture-timeout' }),
          CAPTURE_OPERATION_TIMEOUT_MS,
        );
        Promise.resolve()
          .then(() => {
            if (typeof options.captureElement !== 'function') throw { code: 'capture-unsupported' };
            return options.captureElement(target);
          })
          .then(
            (value) => finish(resolve, value),
            (error) => fail(error),
          );
      } catch (error) {
        fail(error);
      }
    });
  }

  function beginCaptureVisibility(): void {
    if (captureDepth === 0) {
      let previous = '';
      try {
        previous = host.style.display;
      } catch {
        previous = '';
      }
      capturePreviousDisplay = previous;
      captureDepth = 1;
      try {
        host.style.display = 'none';
      } catch {
        return;
      }
      return;
    }
    captureDepth += 1;
  }

  function endCaptureVisibility(): void {
    if (captureDepth <= 0) return;
    captureDepth -= 1;
    if (captureDepth !== 0) return;
    try {
      host.style.display = capturePreviousDisplay;
    } catch {
      return;
    }
  }

  async function captureSelectionById(selectionId: string, requestId: string) {
    let responseStarted = false;
    const respondError = (code: string, messageKey?: string) => {
      if (responseStarted) return;
      responseStarted = true;
      sendCaptureError(requestId, code, messageKey);
    };
    const respondFailure = (error: unknown) => {
      if (responseStarted) return;
      responseStarted = true;
      sendCaptureFailure(requestId, error);
    };
    try {
      const rec = bySelectionId.get(selectionId);
      if (!rec || rec.state !== 'active' || !rec.target) {
        respondError('capture-selection-unavailable');
        return;
      }
      if (typeof options.captureElement !== 'function') {
        respondError('capture-unsupported');
        return;
      }
      if (bridgeDestroyed) {
        respondError('capture-selection-unavailable');
        return;
      }
      const captureTarget = rec.target;
      const captureRevision = rec.revision;
      beginCaptureVisibility();
      try {
        const asset = await captureWithTimeout(captureTarget);
        if (
          bridgeDestroyed ||
          rec.state !== 'active' ||
          rec.revision !== captureRevision ||
          rec.target !== captureTarget ||
          captureTarget.isConnected === false
        ) {
          respondError('capture-selection-unavailable', 'selection-changed');
          return;
        }
        if (!isCaptureAsset(asset)) {
          respondError('capture-limits');
          return;
        }
        const result = {
          selectionId,
          mimeType: asset.mimeType,
          base64: asset.base64,
          width: asset.width,
          height: asset.height,
          byteLength: asset.byteLength,
        };
        responseStarted = true;
        sendCaptureMessage('VERA_INSPECTOR_CAPTURE_RESULT', result, requestId);
      } catch (error) {
        respondFailure(error);
      } finally {
        endCaptureVisibility();
      }
    } catch (error) {
      respondFailure(error);
    }
  }

  // ---- Overlay drawing + coordinate lifecycle (§11.4) ----
  function rectOf(el: Element): DOMRect | null {
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return r;
    } catch {
      return null;
    }
  }

  function drawHover(el: Element) {
    const r = rectOf(el);
    if (!r) return;
    if (!hoverBox) {
      hoverBox = document.createElement('div');
      hoverBox.className = 'vi-hover';
      layer.appendChild(hoverBox);
    }
    hoverBox.style.left = `${r.left}px`;
    hoverBox.style.top = `${r.top}px`;
    hoverBox.style.width = `${r.width}px`;
    hoverBox.style.height = `${r.height}px`;
  }

  function clearHover() {
    hoverBox?.remove();
    hoverBox = null;
    hoverEl = null;
  }

  function drawSelBox(rec: Rec) {
    if (!rec.target) return;
    const r = rectOf(rec.target);
    if (!r) return;
    let entry = selBoxes.get(rec.selectionId);
    if (!entry) {
      const box = document.createElement('div');
      box.className = 'vi-sel';
      const label = document.createElement('div');
      label.className = 'vi-label';
      layer.appendChild(box);
      layer.appendChild(label);
      entry = { box, label };
      selBoxes.set(rec.selectionId, entry);
    }
    entry.box.style.left = `${r.left}px`;
    entry.box.style.top = `${r.top}px`;
    entry.box.style.width = `${r.width}px`;
    entry.box.style.height = `${r.height}px`;
    const num = activeOrder.indexOf(rec.selectionId) + 1;
    entry.label.textContent = String(num > 0 ? num : activeOrder.length + 1);
    entry.label.style.left = `${r.left}px`;
    entry.label.style.top = `${r.top}px`;
  }

  function removeSelBox(selectionId: string) {
    const e = selBoxes.get(selectionId);
    if (e) {
      e.box.remove();
      e.label.remove();
      selBoxes.delete(selectionId);
    }
  }

  function refreshAllBoxes() {
    for (const rec of bySelectionId.values()) {
      if (rec.state === 'active' && rec.target) drawSelBox(rec);
    }
    if (hoverEl && frozen && mode === 'html') drawHover(hoverEl);
  }

  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    try {
      rafHandle = requestAnimationFrame(() => {
        rafPending = false;
        rafHandle = null;
        if (!frozen) return;
        if (pendingPointer && mode === 'html') {
          const { x, y, target } = pendingPointer;
          pendingPointer = null;
          const t = hitTestPage(x, y, target);
          if (t) {
            hoverEl = t;
          } else if (hoverEl) {
            clearHover();
          }
        }
        refreshAllBoxes();
      });
    } catch {
      rafPending = false;
      rafHandle = null;
    }
  }

  // ---- Frozen listeners (attached ONLY while frozen) ----
  /**
   * Resolve the page element under (x,y) while the shield is swallowing pointer
   * events. `e.target` is useless here: at document level the shield retargets
   * to the host, so every hit would look like "the overlay". Briefly drop the
   * shield, ask the browser, then restore it. `elementsFromPoint` flushes
   * pending style, so the one-off pointer-events toggle is visible immediately.
   *
   * The event target is kept as a fallback for environments without geometric
   * hit-testing (jsdom), where nothing intercepts the pointer and `e.target` is
   * still the real element.
   */
  function hitTestPage(x: number, y: number, fallback: EventTarget | null): Element | null {
    if (typeof document.elementsFromPoint === 'function') {
      const previous = shield.style.pointerEvents;
      shield.style.pointerEvents = 'none';
      try {
        for (const el of document.elementsFromPoint(x, y)) {
          if (el === host || host.contains(el)) continue;
          return el;
        }
        return null;
      } catch {
        /* fall through to the event target */
      } finally {
        shield.style.pointerEvents = previous;
      }
    }
    if (fallback instanceof Element && fallback !== host && !host.contains(fallback)) return fallback;
    return null;
  }

  let pendingPointer: { x: number; y: number; target: EventTarget | null } | null = null;

  function onMouseMove(e: MouseEvent) {
    if (!frozen || mode !== 'html') return;
    // Hit-testing is deferred into the rAF so the shield toggle costs at most
    // one forced reflow per frame instead of one per mousemove event.
    pendingPointer = { x: e.clientX, y: e.clientY, target: e.target };
    scheduleRefresh();
  }

  function onClick(e: MouseEvent) {
    if (!frozen) return;
    // Safe interception: capture-phase, block Vera side effects.
    e.preventDefault();
    e.stopPropagation();
    if (mode !== 'html') {
      handleCanvasClick(e);
      return;
    }
    const t = hitTestPage(e.clientX, e.clientY, e.target);
    if (!t) return;
    selectHtmlElement(t);
  }

  function onSubmit(e: Event) {
    if (frozen) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Swallow an event at the very top of the capture phase. */
  function blockFrozenEvent(e: Event) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onFrozenKeyDown(e: KeyboardEvent) {
    // The Freeze shortcut and Escape stay live so the user can get out again.
    if (isFreezeKey(e)) return;
    if (e.key === 'Escape') return;
    blockFrozenEvent(e);
  }

  function onFrozenKeyUp(e: KeyboardEvent) {
    blockFrozenEvent(e);
  }

  function onFrozenKeyPress(e: KeyboardEvent) {
    blockFrozenEvent(e);
  }

  function onFrozenEdit(e: Event) {
    blockFrozenEvent(e);
  }

  function onFrozenPointer(e: Event) {
    // Backstop only: the shield already stops these. Kept so a browser that
    // mis-hit-tests a fixed overlay still cannot hand the page a live pointer.
    blockFrozenEvent(e);
  }

  function handleCanvasClick(e: MouseEvent) {
    // R3F / Konva hit-testing via Vera-registered access paths (§12.3/12.4).
    const regs =
      mode === '3d'
        ? r3fRegs.map((r) => ({ key: 'r3f', hits: r.getHits?.(e.clientX, e.clientY) ?? [] }))
        : konvaRegs.map((r) => ({ key: 'konva', hits: r.getHits?.(e.clientX, e.clientY) ?? [] }));
    for (const reg of regs) {
      const hit = reg.hits[0];
      if (!hit) continue;
      const existing = byElementKey.get(hit.elementKey);
      if (existing && existing.state === 'active') {
        existing.revision += 1;
        existing.state = 'inactive';
        const i = activeOrder.indexOf(existing.selectionId);
        if (i >= 0) activeOrder.splice(i, 1);
        emitSelection(existing);
        return;
      }
      if (existing) {
        if (!canActivateSelection()) return;
        existing.revision += 1;
        existing.state = 'active';
        activeOrder.push(existing.selectionId);
        emitSelection(existing);
        return;
      }
      if (!canActivateSelection()) return;
      const rec: Rec = {
        selectionId: uid('sel'),
        elementKey: hit.elementKey,
        component: hit.component,
        file: hit.file,
        line: hit.line,
        mode,
        extra: hit.extra,
        state: 'active',
        order: orderCounter++,
        revision: 0,
        target: null,
      };
      byElementKey.set(hit.elementKey, rec);
      bySelectionId.set(rec.selectionId, rec);
      activeOrder.push(rec.selectionId);
      emitSelection(rec);
      return;
    }
    // No metadata: explicit fallback selection (never fabricated).
    const fallbackKey = `${mode}:miss:${e.clientX}x${e.clientY}`;
    if (!canActivateSelection()) return;
    const rec: Rec = {
      selectionId: uid('sel'),
      elementKey: fallbackKey,
      component: null,
      file: null,
      line: null,
      mode,
      extra: { note: 'no hit metadata — register R3F/Konva access path (see checklist)' },
      state: 'active',
      order: orderCounter++,
      revision: 0,
      target: null,
    };
    byElementKey.set(fallbackKey, rec);
    bySelectionId.set(rec.selectionId, rec);
    activeOrder.push(rec.selectionId);
    emitSelection(rec);
  }

  function isFreezeKey(e: KeyboardEvent): boolean {
    // Keep in sync with App A src/shortcut.ts. Primary Ctrl/Cmd+Shift+F:
    // Alt+Shift is reserved by Windows (language switch) and often never
    // reaches the page, so Alt+Shift+F is legacy fallback only.
    const isF = e.key === 'F' || e.key === 'f';
    if (!isF || !e.shiftKey) return false;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) return true;
    if (e.altKey && !e.ctrlKey && !e.metaKey) return true;
    return false;
  }

  function onKeyDown(e: KeyboardEvent) {
    // Narrow inspector keys only — no blanket blocking (§10.4).
    if (isFreezeKey(e)) {
      e.preventDefault();
      setFrozen(!frozen);
      return;
    }
    if (e.key === 'Escape' && frozen) {
      clearHover();
    }
  }

  const FREEZE_STYLE_TEXT = `
*, *::before, *::after {
  animation-play-state: paused !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`;
  let freezeStyle: HTMLStyleElement | null = null;

  function applyFreezeVisuals(on: boolean) {
    shield.style.pointerEvents = on ? 'auto' : 'none';
    if (on) {
      if (!freezeStyle) {
        const parent = document.head ?? document.documentElement;
        if (parent) {
          freezeStyle = document.createElement('style');
          freezeStyle.setAttribute('data-vera-inspector', 'freeze-style');
          freezeStyle.textContent = FREEZE_STYLE_TEXT;
          parent.appendChild(freezeStyle);
        }
      }
    } else if (freezeStyle) {
      freezeStyle.remove();
      freezeStyle = null;
    }
  }

  function attach() {
    // Window-capture blockers fire before anything the page registered, so
    // stopPropagation here keeps the event away from document/body/target.
    window.addEventListener('keydown', onFrozenKeyDown, { capture: true });
    window.addEventListener('keyup', onFrozenKeyUp, { capture: true });
    window.addEventListener('keypress', onFrozenKeyPress, { capture: true });
    for (const type of ['beforeinput', 'input', 'change', 'focusin', 'focusout', 'paste', 'cut', 'drop', 'dragstart']) {
      window.addEventListener(type, onFrozenEdit, { capture: true });
    }
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
      window.addEventListener(type, onFrozenPointer, { capture: true });
    }
    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('submit', onSubmit, { capture: true });
    window.addEventListener('scroll', scheduleRefresh, { capture: true, passive: true });
    window.addEventListener('resize', scheduleRefresh);
  }

  function detach() {
    window.removeEventListener('keydown', onFrozenKeyDown, { capture: true });
    window.removeEventListener('keyup', onFrozenKeyUp, { capture: true });
    window.removeEventListener('keypress', onFrozenKeyPress, { capture: true });
    for (const type of ['beforeinput', 'input', 'change', 'focusin', 'focusout', 'paste', 'cut', 'drop', 'dragstart']) {
      window.removeEventListener(type, onFrozenEdit, { capture: true });
    }
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
      window.removeEventListener(type, onFrozenPointer, { capture: true });
    }
    document.removeEventListener('mousemove', onMouseMove, { capture: true });
    document.removeEventListener('click', onClick, { capture: true });
    document.removeEventListener('submit', onSubmit, { capture: true });
    window.removeEventListener('scroll', scheduleRefresh, { capture: true });
    window.removeEventListener('resize', scheduleRefresh);
    applyFreezeVisuals(false);
  }

  function blurActiveElement() {
    try {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
    } catch {
      /* focus may be inside a cross-origin frame */
    }
  }

  function setFrozen(next: boolean, requestId?: string) {
    const changed = next !== frozen;
    frozen = next;
    if (frozen && changed) {
      applyFreezeVisuals(true);
      blurActiveElement();
      attach();
    }
    if (!frozen) {
      detach();
      clearHover();
      if (changed) {
        // Freeze OFF is a canonical live-state reset: clear live state.
        clearAll();
        layer.innerHTML = '';
        selBoxes.clear();
      }
    }
    send('VERA_INSPECTOR_FREEZE_ACK', { inspectorFrozen: frozen, mode }, requestId);
    if (changed) emitSnapshot();
  }

  function setMode(next: BridgeMode, requestId?: string) {
    if (next !== mode) {
      mode = next;
      // Mode switch invalidates mode-specific hover state (§12.1, chosen policy:
      // preserve cross-mode live selections, clear hover only).
      clearHover();
    }
    emitSnapshot(requestId);
  }

  function currentRouteKey(): string {
    try {
      const loc = window.location;
      if (!loc) return '';
      return `${loc.pathname ?? ''}${loc.search ?? ''}${loc.hash ?? ''}`;
    } catch {
      return '';
    }
  }

  function clearLiveRuntimeState(): void {
    for (const rec of bySelectionId.values()) {
      if (rec.state === 'active') {
        rec.state = 'inactive';
        rec.revision += 1;
      }
      rec.target = null;
    }
    activeOrder.length = 0;
    selBoxes.clear();
    try {
      layer.innerHTML = '';
    } catch {
      layer.textContent = '';
    }
    clearHover();
    const cancel = activeCaptureCancel;
    activeCaptureCancel = null;
    cancel?.({ code: 'capture-selection-unavailable' });
    if (frozen) {
      frozen = false;
      detach();
    }
    applyFreezeVisuals(false);
    removeAllPreviewLayers();
  }

  function onRouteEvent(): void {
    try {
      syncRoute();
    } catch {
      return;
    }
  }

  function syncRoute(): void {
    if (bridgeDestroyed) return;
    const next = currentRouteKey();
    if (next === routeKey) {
      mountHost();
      return;
    }
    routeKey = next;
    routeEpoch += 1;
    clearLiveRuntimeState();
    mountHost();
    if (bridgeDestroyed) return;
    send('VERA_INSPECTOR_ROUTE_CHANGED', { routeKey, routeEpoch });
    emitSnapshot();
  }

  function patchHistoryMethod(name: 'pushState' | 'replaceState'): void {
    const historyRef = window.history;
    if (!historyRef) return;
    let original: History['pushState'] | undefined;
    try {
      original = historyRef[name];
    } catch {
      return;
    }
    if (typeof original !== 'function') return;
    const patched = function patchedHistoryMethod(this: unknown, ...args: unknown[]): unknown {
      const result = (original as (...callArgs: unknown[]) => unknown).apply(this ?? historyRef, args);
      onRouteEvent();
      return result;
    } as History['pushState'];
    try {
      historyRef[name] = patched;
    } catch {
      return;
    }
    cleanupFns.push(() => {
      try {
        if (historyRef[name] === patched) historyRef[name] = original;
      } catch {
        return;
      }
    });
  }

  function previewLayerKey(bindingId: string, transactionId: string): string {
    return JSON.stringify([bindingId, transactionId]);
  }

  function removeAdoptedSheet(sheet: CSSStyleSheet): void {
    try {
      const current = document.adoptedStyleSheets;
      if (!Array.isArray(current)) return;
      const next = current.filter((entry) => entry !== sheet);
      if (next.length === current.length) return;
      document.adoptedStyleSheets = next;
    } catch {
      return;
    }
  }

  function createAdoptedSheet(cssText: string): CSSStyleSheet | null {
    try {
      if (!Array.isArray(document.adoptedStyleSheets)) return null;
      const constructor = (globalThis as typeof globalThis & { CSSStyleSheet?: unknown }).CSSStyleSheet;
      if (typeof constructor !== 'function') return null;
      const sheet = new (constructor as new () => CSSStyleSheet)();
      if (typeof sheet.replaceSync !== 'function') return null;
      sheet.replaceSync(cssText);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return sheet;
    } catch {
      return null;
    }
  }

  function createStyleLayer(
    cssText: string,
  ): { styleElement: HTMLStyleElement | null; adoptedSheet: CSSStyleSheet | null } {
    if (styleNonce === '') {
      const sheet = createAdoptedSheet(cssText);
      if (sheet !== null) return { styleElement: null, adoptedSheet: sheet };
    }
    let styleElement: HTMLStyleElement | null = null;
    try {
      styleElement = document.createElement('style');
      styleElement.setAttribute('data-vera-inspector', PREVIEW_LAYER_MARKER);
      if (styleNonce !== '') {
        styleElement.setAttribute('nonce', styleNonce);
        styleElement.nonce = styleNonce;
      }
      styleElement.textContent = cssText;
      (document.head ?? document.documentElement).appendChild(styleElement);
    } catch {
      if (styleElement !== null) {
        try {
          styleElement.remove();
        } catch {
          styleElement = null;
        }
      }
      return { styleElement: null, adoptedSheet: null };
    }
    return { styleElement, adoptedSheet: null };
  }

  function removePreviewLayer(key: string): PreviewLayer | null {
    const layer = previewLayers.get(key);
    if (!layer) return null;
    previewLayers.delete(key);
    const order = previewBindingOrder.get(layer.bindingId);
    if (order) {
      const index = order.indexOf(key);
      if (index >= 0) order.splice(index, 1);
      if (order.length === 0) previewBindingOrder.delete(layer.bindingId);
    }
    for (const mark of layer.marks) {
      try {
        if (mark.element.getAttribute(layer.attribute) === mark.value) {
          mark.element.removeAttribute(layer.attribute);
        }
      } catch {
        continue;
      }
    }
    layer.marks.length = 0;
    if (layer.styleElement !== null) {
      try {
        layer.styleElement.remove();
      } catch {
        layer.styleElement = null;
      }
      layer.styleElement = null;
    }
    if (layer.adoptedSheet !== null) {
      removeAdoptedSheet(layer.adoptedSheet);
      layer.adoptedSheet = null;
    }
    return layer;
  }

  function removeAllPreviewLayers(): void {
    for (const key of [...previewLayers.keys()]) removePreviewLayer(key);
    previewLayers.clear();
    previewBindingOrder.clear();
  }

  function trimPreviewLayers(bindingId: string): void {
    const order = previewBindingOrder.get(bindingId);
    if (order) {
      while (order.length > PREVIEW_MAX_LAYERS_PER_BINDING) {
        const oldest = order[0];
        if (oldest === undefined) break;
        removePreviewLayer(oldest);
      }
    }
    while (previewLayers.size > PREVIEW_MAX_LAYERS) {
      const oldest = previewLayers.keys().next();
      if (oldest.done === true) break;
      removePreviewLayer(oldest.value);
    }
  }

  function buildPreviewIndex(): PreviewIndexEntry[] {
    const entries: PreviewIndexEntry[] = [];
    let nodes: Element[];
    try {
      nodes = [...document.querySelectorAll('*')];
    } catch {
      return entries;
    }
    for (const node of nodes) {
      if (node === host) continue;
      try {
        if (host.contains(node)) continue;
        if (typeof node.getAttribute === 'function' && node.getAttribute('data-vera-inspector') !== null) {
          continue;
        }
      } catch {
        continue;
      }
      let key = '';
      try {
        key = elementKeyFor(node);
      } catch {
        continue;
      }
      entries.push({ element: node, key });
    }
    return entries;
  }

  function anchorHintsMatch(element: Element, anchor: InspectorAnchor): boolean {
    try {
      if (anchor.tagName !== '' && element.tagName.toLowerCase() !== anchor.tagName) return false;
      if (anchor.id !== '' && element.getAttribute('id') !== anchor.id) return false;
      if (anchor.testId !== '') {
        const testId = element.getAttribute('data-testid');
        const inspectorKey = element.getAttribute('data-inspector-key');
        if (testId !== anchor.testId && inspectorKey !== anchor.testId) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  function resolvePreviewAnchor(
    anchor: InspectorAnchor,
    index: PreviewIndexEntry[],
  ): { ok: true; element: Element } | { ok: false; status: 'unbound' | 'ambiguous'; matchCount: number } {
    const crossRoute = anchor.routeKey !== '' && anchor.routeKey !== routeKey;
    if (crossRoute && anchor.id === '' && anchor.testId === '') {
      return { ok: false, status: 'unbound', matchCount: 0 };
    }
    for (let i = activeOrder.length - 1; i >= 0; i -= 1) {
      const rec = bySelectionId.get(activeOrder[i]);
      if (!rec || rec.state !== 'active' || rec.target === null) continue;
      if (rec.elementKey !== anchor.elementKey && !crossRoute) continue;
      if (rec.target.isConnected === false) continue;
      let currentKey = '';
      try {
        currentKey = elementKeyFor(rec.target);
      } catch {
        currentKey = '';
      }
      if (
        currentKey === anchor.elementKey ||
        (crossRoute && anchorHintsMatch(rec.target, anchor))
      ) {
        return { ok: true, element: rec.target };
      }
    }
    const matches: Element[] = [];
    for (const entry of index) {
      if (entry.key !== anchor.elementKey && !crossRoute) continue;
      if (crossRoute && !anchorHintsMatch(entry.element, anchor)) continue;
      if (entry.element.isConnected === false) continue;
      matches.push(entry.element);
    }
    if (matches.length === 1) return { ok: true, element: matches[0] };
    if (matches.length > 1) {
      const confirmed = matches.filter((element) => anchorHintsMatch(element, anchor));
      if (confirmed.length === 1) return { ok: true, element: confirmed[0] };
      return { ok: false, status: 'ambiguous', matchCount: Math.min(matches.length, PREVIEW_MAX_MATCH_COUNT) };
    }
    return { ok: false, status: 'unbound', matchCount: 0 };
  }

  function applyPreviewLayer(
    bindingId: string,
    transactionId: string,
    resolved: Array<{ anchor: InspectorAnchor; declarations: Record<string, string>; element: Element }>,
  ): void {
    const key = previewLayerKey(bindingId, transactionId);
    removePreviewLayer(key);
    previewOrdinal += 1;
    previewLayerCounter += 1;
    const specificity = Math.min(PREVIEW_BASE_SPECIFICITY + previewOrdinal, PREVIEW_MAX_SPECIFICITY);
    const token = `${previewLayerCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const attribute = `${PREVIEW_ATTRIBUTE_PREFIX}${token}`;
    const rules: string[] = [];
    const marks: Array<{ element: Element; value: string }> = [];
    resolved.forEach((item, index) => {
      const value = `${token}-${index.toString(36)}`;
      const selector = new Array(specificity).fill(`[${attribute}="${value}"]`).join('');
      const body = Object.entries(item.declarations)
        .map(([property, propertyValue]) => `${property}:${propertyValue}`)
        .join(';');
      rules.push(`${selector}{${body}}`);
      marks.push({ element: item.element, value });
    });
    const created = createStyleLayer(rules.join('\n'));
    for (const mark of marks) {
      try {
        mark.element.setAttribute(attribute, mark.value);
      } catch {
        continue;
      }
    }
    previewLayers.set(key, {
      key,
      bindingId,
      transactionId,
      routeKey,
      routeEpoch,
      attribute,
      marks,
      styleElement: created.styleElement,
      adoptedSheet: created.adoptedSheet,
      anchors: resolved.map((item) => item.anchor),
      specificity,
    });
    const order = previewBindingOrder.get(bindingId) ?? [];
    order.push(key);
    previewBindingOrder.set(bindingId, order);
    trimPreviewLayers(bindingId);
  }

  function sendPreviewResult(
    operation: PreviewOperation,
    bindingId: string,
    transactionId: string,
    status: PreviewStatus,
    anchors: PreviewAnchorResult[],
    requestId: string,
  ): void {
    if (bridgeDestroyed) return;
    const payload: PreviewResultPayload = {
      bindingId,
      transactionId,
      operation,
      status,
      anchors,
      routeKey,
      routeEpoch,
    };
    send('VERA_INSPECTOR_PREVIEW_RESULT', payload, requestId);
  }

  function sendPreviewCommandError(requestId: string, code: string, message: string): void {
    if (bridgeDestroyed) return;
    send('VERA_INSPECTOR_ERROR', { code, message }, requestId);
  }

  function anchorResult(
    elementKey: string,
    status: PreviewAnchorStatus,
    matchCount: number,
  ): PreviewAnchorResult | null {
    if (elementKey.length === 0 || elementKey.length > PREVIEW_MAX_ELEMENT_KEY_CHARS) return null;
    const bounded = Math.max(0, Math.min(PREVIEW_MAX_MATCH_COUNT, matchCount));
    if (status === 'unbound' && bounded > 0) return null;
    if (status === 'applied' && bounded < 1) return null;
    return { elementKey, status, matchCount: bounded };
  }

  function pushAnchorResult(
    results: PreviewAnchorResult[],
    seen: Set<string>,
    elementKey: string,
    status: PreviewAnchorStatus,
    matchCount: number,
  ): void {
    if (seen.has(elementKey)) return;
    const result = anchorResult(elementKey, status, matchCount);
    if (result === null) return;
    seen.add(elementKey);
    results.push(result);
  }

  function handlePreviewApply(payload: Record<string, unknown>, requestId: string): void {
    const bindingId = parseBoundedId(payload['bindingId'], PREVIEW_MAX_BINDING_ID_CHARS);
    const transactionId = parseBoundedId(payload['transactionId'], PREVIEW_MAX_TRANSACTION_ID_CHARS);
    if (bindingId === null || transactionId === null) {
      sendPreviewCommandError(
        requestId,
        'invalid-preview-command',
        'Preview apply requires a binding id and transaction id.',
      );
      return;
    }
    const rawChanges = payload['changes'];
    if (!Array.isArray(rawChanges) || rawChanges.length < 1 || rawChanges.length > PREVIEW_MAX_CHANGES) {
      sendPreviewResult('apply', bindingId, transactionId, 'rejected', [], requestId);
      return;
    }
    const index = buildPreviewIndex();
    const results: PreviewAnchorResult[] = [];
    const seen = new Set<string>();
    const resolved: Array<{
      anchor: InspectorAnchor;
      declarations: Record<string, string>;
      element: Element;
    }> = [];
    for (const rawChange of rawChanges) {
      if (!isPlainRecord(rawChange) || !hasExactKeys(rawChange, PREVIEW_CHANGE_KEYS)) {
        sendPreviewResult('apply', bindingId, transactionId, 'rejected', results, requestId);
        return;
      }
      const anchor = parseInspectorAnchor(rawChange['anchor']);
      if (anchor === null) {
        sendPreviewResult('apply', bindingId, transactionId, 'rejected', results, requestId);
        return;
      }
      const declarations = validatePreviewDeclarations(rawChange['declarations']);
      if (!declarations.ok) {
        pushAnchorResult(results, seen, anchor.elementKey, 'rejected', 0);
        sendPreviewResult('apply', bindingId, transactionId, 'rejected', results, requestId);
        return;
      }
      const target = resolvePreviewAnchor(anchor, index);
      if (!target.ok) {
        for (const entry of resolved) {
          pushAnchorResult(results, seen, entry.anchor.elementKey, 'rejected', 1);
        }
        pushAnchorResult(results, seen, anchor.elementKey, target.status, target.matchCount);
        sendPreviewResult('apply', bindingId, transactionId, target.status, results, requestId);
        return;
      }
      resolved.push({ anchor, declarations: declarations.declarations, element: target.element });
    }
    try {
      applyPreviewLayer(bindingId, transactionId, resolved);
    } catch {
      for (const entry of resolved) {
        pushAnchorResult(results, seen, entry.anchor.elementKey, 'rejected', 1);
      }
      sendPreviewResult('apply', bindingId, transactionId, 'rejected', results, requestId);
      return;
    }
    for (const entry of resolved) {
      pushAnchorResult(results, seen, entry.anchor.elementKey, 'applied', 1);
    }
    sendPreviewResult('apply', bindingId, transactionId, 'applied', results, requestId);
  }

  function handlePreviewUndo(payload: Record<string, unknown>, requestId: string): void {
    const bindingId = parseBoundedId(payload['bindingId'], PREVIEW_MAX_BINDING_ID_CHARS);
    const transactionId = parseBoundedId(payload['transactionId'], PREVIEW_MAX_TRANSACTION_ID_CHARS);
    if (bindingId === null || transactionId === null) {
      sendPreviewCommandError(
        requestId,
        'invalid-preview-command',
        'Preview undo requires a binding id and transaction id.',
      );
      return;
    }
    const layer = removePreviewLayer(previewLayerKey(bindingId, transactionId));
    sendPreviewResult(
      'undo',
      bindingId,
      transactionId,
      layer === null ? 'no-op' : 'undone',
      [],
      requestId,
    );
  }

  function handlePreviewReset(payload: Record<string, unknown>, requestId: string): void {
    const bindingId = parseBoundedId(payload['bindingId'], PREVIEW_MAX_BINDING_ID_CHARS);
    if (bindingId === null) {
      sendPreviewCommandError(
        requestId,
        'invalid-preview-command',
        'Preview reset requires a binding id.',
      );
      return;
    }
    const rawIds = payload['transactionIds'];
    let keys: string[] = [];
    let requestedId = PREVIEW_NO_TRANSACTION;
    if (rawIds === undefined || rawIds === null) {
      keys = [...(previewBindingOrder.get(bindingId) ?? [])];
    } else {
      if (!Array.isArray(rawIds) || rawIds.length > PREVIEW_MAX_TRANSACTION_IDS) {
        sendPreviewResult('reset', bindingId, requestedId, 'rejected', [], requestId);
        return;
      }
      const ids: string[] = [];
      const seenIds = new Set<string>();
      for (const rawId of rawIds) {
        const id = parseBoundedId(rawId, PREVIEW_MAX_TRANSACTION_ID_CHARS);
        if (id === null || seenIds.has(id)) {
          sendPreviewResult('reset', bindingId, requestedId, 'rejected', [], requestId);
          return;
        }
        seenIds.add(id);
        ids.push(id);
      }
      if (ids.length === 1) requestedId = ids[0] ?? PREVIEW_NO_TRANSACTION;
      keys = ids.map((id) => previewLayerKey(bindingId, id));
    }
    let removed = 0;
    for (const key of keys) {
      const layer = removePreviewLayer(key);
      if (layer === null) continue;
      removed += 1;
      if (requestedId === PREVIEW_NO_TRANSACTION) requestedId = layer.transactionId;
    }
    sendPreviewResult(
      'reset',
      bindingId,
      requestedId,
      removed === 0 ? 'no-op' : 'reset',
      [],
      requestId,
    );
  }
  function handleSessionReset(requestId: string): void {
    clearLiveRuntimeState();
    if (bridgeDestroyed) return;
    send('VERA_INSPECTOR_SESSION_RESET_ACK', { routeKey, routeEpoch }, requestId);
    emitSnapshot(requestId);
  }

  // ---- Incoming commands: origin + source validation (§7.2/7.3) ----
  function onMessage(e: MessageEvent) {
    if (e.origin !== expectedAppOrigin) return;
    if (e.source !== window.parent) return;
    const m = e.data as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') return;
    if (m['protocolVersion'] !== PROTOCOL_VERSION) return;
    const type = m['type'] as string;
    const payload = (m['payload'] ?? {}) as Record<string, unknown>;
    const requestId = typeof m['requestId'] === 'string' ? (m['requestId'] as string) : uid('req');
    const commandSequence = m['sequence'];
    if (typeof commandSequence !== 'number' || !Number.isSafeInteger(commandSequence) || commandSequence < 0) return;
    if (type !== 'VERA_INSPECTOR_HELLO' && commandSequence <= lastAppSequence) return;
    lastAppSequence = commandSequence;
    if (
      type !== 'VERA_INSPECTOR_HELLO' &&
      appHelloReceived &&
      (m['connectionId'] !== connectionId || m['documentGeneration'] !== documentGeneration)
    ) return;

    switch (type) {
      case 'VERA_INSPECTOR_HELLO': {
        appHelloReceived = true;
        lastHelloRequestId = requestId;
        send(
          'VERA_INSPECTOR_HELLO_ACK',
          {
            bridgeConnectionId: connectionId,
            documentGeneration,
            veraUrl: location.href,
            routeKey,
            routeEpoch,
            capabilities,
          },
          requestId,
        );
        emitSnapshot();
        break;
      }
      case 'VERA_INSPECTOR_FREEZE': {
        if (typeof payload['active'] !== 'boolean') {
          send('VERA_INSPECTOR_ERROR', { code: 'invalid-freeze', message: 'Freeze active must be boolean.' }, requestId);
          break;
        }
        setFrozen(payload['active'], requestId);
        break;
      }
      case 'VERA_INSPECTOR_SET_MODE': {
        const next = payload['mode'] as BridgeMode;
        if (next === 'html' || next === '3d' || next === 'konva') setMode(next, requestId);
        break;
      }
      case 'VERA_INSPECTOR_CLEAR_SELECTION': {
        const id = payload['selectionId'];
        if (typeof id === 'string') clearSelectionById(id);
        emitSnapshot(requestId);
        break;
      }
      case 'VERA_INSPECTOR_RESELECT_SELECTION': {
        const id = payload['selectionId'];
        if (typeof id === 'string') reselectSelectionById(id);
        emitSnapshot(requestId);
        break;
      }
      case 'VERA_INSPECTOR_CLEAR_ALL': {
        clearAll();
        emitSnapshot(requestId);
        break;
      }
      case 'VERA_INSPECTOR_CAPTURE_SELECTION': {
        const id = payload['selectionId'];
        if (typeof id !== 'string') {
          sendCaptureError(requestId, 'capture-selection-unavailable');
          break;
        }
        if (captureQueueDepth >= 8) {
          sendCaptureError(requestId, 'capture-busy');
          break;
        }
        captureQueueDepth += 1;
        captureQueue = captureQueue
          .catch(() => undefined)
          .then(() => captureSelectionById(id, requestId))
          .catch(() => undefined)
          .finally(() => {
            captureQueueDepth = Math.max(0, captureQueueDepth - 1);
          });
        break;
      }
      case 'VERA_INSPECTOR_REQUEST_SNAPSHOT': {
        emitSnapshot(requestId);
        break;
      }
      case 'VERA_INSPECTOR_PING': {
        send('VERA_INSPECTOR_PONG', { inspectorFrozen: frozen, mode }, requestId);
        break;
      }
      case 'VERA_INSPECTOR_SESSION_RESET': {
        handleSessionReset(requestId);
        break;
      }
      case 'VERA_INSPECTOR_PREVIEW_APPLY': {
        handlePreviewApply(payload, requestId);
        break;
      }
      case 'VERA_INSPECTOR_PREVIEW_UNDO': {
        handlePreviewUndo(payload, requestId);
        break;
      }
      case 'VERA_INSPECTOR_PREVIEW_RESET': {
        handlePreviewReset(payload, requestId);
        break;
      }
      default:
        break;
    }
  }

  window.addEventListener('message', onMessage);
  document.addEventListener('keydown', onKeyDown);
  // Freeze hotkey must work while Live too (§9.1: focus inside the iframe),
  // so it is attached at init — not only while frozen. The handler performs
  // no inspection, hit-testing, or selection against any DOM.

  routeKey = currentRouteKey();
  mountHost();
  window.addEventListener('popstate', onRouteEvent);
  window.addEventListener('hashchange', onRouteEvent);
  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  // Late-App recovery: announce presence in case App A already sent HELLO (§8.5).
  // App A retries handshake after iframe load, so this is best-effort only.
  try {
    window.parent.postMessage(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'VERA_INSPECTOR_HELLO_ACK',
        connectionId,
        documentGeneration,
        requestId: lastHelloRequestId ?? uid('req'),
        sequence: 0,
        payload: {
          bridgeConnectionId: connectionId,
          documentGeneration,
          veraUrl: location.href,
          routeKey,
          routeEpoch,
          bridgeKind,
          capabilities,
        },
      },
      expectedAppOrigin,
    );
  } catch {
    // parent not reachable yet — App A retry loop will recover
  }

  send('VERA_INSPECTOR_BRIDGE_PRESENT', {
    bridgeConnectionId: connectionId,
    documentGeneration,
    routeKey,
    routeEpoch,
    capabilities,
  });

  let destroyed = false;
  const bridge = {
    kind: bridgeKind,
    connectionId,
    documentGeneration,
    registerR3F(reg: R3FRegistration) {
      r3fRegs.push(reg);
    },
    registerKonva(reg: KonvaRegistration) {
      konvaRegs.push(reg);
    },
    getState() {
      return {
        frozen,
        mode,
        activeCount: activeOrder.length,
        capabilities,
        routeKey,
        routeEpoch,
        previewLayerCount: previewLayers.size,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      bridgeDestroyed = true;
      activeCaptureCancel?.({ code: 'capture-selection-unavailable' });
      activeCaptureCancel = null;
      while (captureDepth > 0) endCaptureVisibility();
      detach();
      for (const cleanup of cleanupFns) {
        try {
          cleanup();
        } catch {
          continue;
        }
      }
      cleanupFns.length = 0;
      window.removeEventListener('popstate', onRouteEvent);
      window.removeEventListener('hashchange', onRouteEvent);
      removeAllPreviewLayers();
      if (rafHandle !== null) {
        try {
          cancelAnimationFrame(rafHandle);
        } catch {
          rafHandle = null;
        }
        rafHandle = null;
      }
      rafPending = false;
      selBoxes.clear();
      clearHover();
      document.removeEventListener('DOMContentLoaded', mountHost);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', bridge.destroy);
      if (globalScope.__DESIGN_INSPECTOR_BRIDGE__ === bridge) {
        delete globalScope.__DESIGN_INSPECTOR_BRIDGE__;
      }
      host.remove();
    },
  };
  globalScope.__DESIGN_INSPECTOR_BRIDGE__ = bridge;
  window.addEventListener('pagehide', bridge.destroy, { once: true });
  return bridge;
}

export type VeraInspectorBridge = ReturnType<typeof initVeraInspectorBridge>;

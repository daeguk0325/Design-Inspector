export type CssRejectionReason =
  | 'not-an-object'
  | 'too-many-declarations'
  | 'empty-property'
  | 'invalid-property-name'
  | 'forbidden-property'
  | 'unknown-property'
  | 'value-not-string'
  | 'value-empty'
  | 'value-too-long'
  | 'forbidden-token'
  | 'invalid-value';

export type CssCheck =
  | { ok: true; declarations: Readonly<Record<string, string>> }
  | { ok: false; reason: CssRejectionReason; property?: string };

export const MAX_CSS_DECLARATIONS = 12;
export const MAX_CSS_VALUE_CHARS = 120;
export const MAX_CSS_LENGTH_VALUE = 4000;
export const MAX_CSS_PERCENT_VALUE = 400;
export const MAX_CSS_COLOR_CHANNELS = 4;
export const MAX_CSS_FONT_FAMILIES = 4;
export const MAX_CSS_SHADOW_LAYERS = 4;

const PROPERTY_NAME_RE = /^[a-z][a-z0-9-]*$/;
const VALUE_CHARSET_RE = /^[A-Za-z0-9 \t#%.,()/_'"-]+$/;
const FUNCTION_NAME_RE = /([A-Za-z-]+)\(/g;
const NUMBER_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

const ALLOWED_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

const LENGTH_UNITS = new Set([
  'px',
  'rem',
  'em',
  'ch',
  'pt',
  'vh',
  'vw',
  'vmin',
  'vmax',
]);

const DENIED_PROPERTIES = new Set([
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'z-index',
  'display',
  'visibility',
  'float',
  'clear',
  'flex',
  'flex-basis',
  'flex-direction',
  'flex-flow',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'order',
  'align-content',
  'align-items',
  'align-self',
  'justify-content',
  'justify-items',
  'justify-self',
  'place-content',
  'place-items',
  'place-self',
  'grid',
  'grid-area',
  'grid-auto-columns',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-column',
  'grid-gap',
  'grid-row',
  'grid-template',
  'grid-template-areas',
  'grid-template-columns',
  'grid-template-rows',
  'content',
  'transform',
  'transform-origin',
  'transform-style',
  'transition',
  'transition-delay',
  'transition-duration',
  'transition-property',
  'animation',
  'animation-delay',
  'animation-direction',
  'animation-duration',
  'animation-fill-mode',
  'animation-iteration-count',
  'animation-name',
  'animation-play-state',
  'animation-timing-function',
  'filter',
  'background',
  'background-image',
  'background-position',
  'background-repeat',
  'background-size',
  'list-style',
  'box-sizing',
  'cursor',
  'pointer-events',
  'user-select',
  'will-change',
  'contain',
  'content-visibility',
  'writing-mode',
  'direction',
]);

const LENGTH_PROPERTIES: readonly string[] = [
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'letter-spacing',
  'gap',
  'row-gap',
  'column-gap',
];

const LENGTH_LIST_PROPERTIES: readonly string[] = [
  'margin',
  'padding',
  'border-width',
  'border-radius',
];

const BORDER_STYLE_LIST_PROPERTIES: readonly string[] = ['border-style'];

const BORDER_STYLE_PROPERTIES: readonly string[] = [
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
];

const COLOR_PROPERTIES: readonly string[] = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
];

const COLOR_KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'brown',
  'gray',
  'grey',
  'silver',
  'gold',
  'beige',
  'ivory',
  'coral',
  'salmon',
  'crimson',
  'indigo',
  'violet',
  'teal',
  'olive',
  'maroon',
  'navy',
  'aqua',
  'cyan',
  'fuchsia',
  'magenta',
  'lime',
  'tan',
  'khaki',
  'plum',
  'orchid',
  'tomato',
  'wheat',
  'azure',
  'lavender',
  'linen',
  'snow',
  'seashell',
  'turquoise',
  'sienna',
  'peru',
  'chocolate',
  'firebrick',
  'darkgray',
  'darkgrey',
  'lightgray',
  'lightgrey',
  'dimgray',
  'slategray',
  'slategrey',
  'darkslategray',
  'steelblue',
  'skyblue',
  'royalblue',
  'midnightblue',
  'dodgerblue',
  'seagreen',
  'forestgreen',
  'darkgreen',
  'olivedrab',
  'slateblue',
]);

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FUNCTION_RE = /^(rgba?|hsla?)\(([^()]*)\)$/;
const BORDER_STYLE_KEYWORDS = new Set([
  'none',
  'hidden',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);
const OVERFLOW_RE = /^(visible|hidden|clip|scroll|auto)$/;
const FONT_STYLE_RE = /^(normal|italic|oblique)$/;
const FONT_SIZE_KEYWORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'smaller',
  'larger',
]);
const FONT_WEIGHT_KEYWORDS = new Set(['normal', 'bold']);
const TEXT_ALIGN_RE = /^(left|right|center|justify|start|end)$/;
const TEXT_TRANSFORM_RE = /^(none|capitalize|uppercase|lowercase)$/;
const TEXT_DECORATION_TOKENS = new Set([
  'none',
  'underline',
  'line-through',
  'overline',
]);
const TEXT_OVERFLOW_RE = /^(clip|ellipsis)$/;
const WHITE_SPACE_RE = /^(normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/;
const FONT_FAMILY_NAME_RE =
  /^(?:"[^"]{1,64}"|'[^']{1,64}'|[A-Za-z0-9][A-Za-z0-9 _.-]{0,63})$/;
const ASPECT_RATIO_PART_RE = /^(?:\d{1,5}(?:\.\d{1,6})?|\.\d{1,6})$/;

export const VISUAL_ONLY_CSS_PROPERTIES: readonly string[] = [
  ...LENGTH_PROPERTIES,
  ...LENGTH_LIST_PROPERTIES,
  ...COLOR_PROPERTIES,
  ...BORDER_STYLE_LIST_PROPERTIES,
  ...BORDER_STYLE_PROPERTIES,
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
].slice().sort();

Object.freeze(VISUAL_ONLY_CSS_PROPERTIES);

const ALLOWED_PROPERTIES = new Set(VISUAL_ONLY_CSS_PROPERTIES);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const countChar = (value: string, char: string): number => {
  let total = 0;
  for (const c of value) {
    if (c === char) total += 1;
  }
  return total;
};

const splitTopLevel = (value: string, separator: string): string[] => {
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
};

const tokensOf = (value: string): string[] => {
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
};

const isNumber = (value: string): boolean => NUMBER_RE.test(value);

const isPercentage = (value: string): boolean =>
  value.endsWith('%') && isNumber(value.slice(0, -1));

const isLength = (value: string): boolean => {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/.exec(value.toLowerCase());
  if (match === null) return false;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return false;
  const unit = match[2] ?? '';
  if (unit === '') return parsed === 0;
  if (unit === '%') return parsed >= -MAX_CSS_PERCENT_VALUE && parsed <= MAX_CSS_PERCENT_VALUE;
  if (!LENGTH_UNITS.has(unit)) return false;
  return parsed >= -MAX_CSS_LENGTH_VALUE && parsed <= MAX_CSS_LENGTH_VALUE;
};

const isLengthList = (value: string): boolean => {
  const tokens = tokensOf(value);
  if (tokens.length < 1 || tokens.length > 4) return false;
  return tokens.every(isLength);
};

const isColorAlpha = (raw: string): boolean => {
  if (raw === '') return false;
  if (isPercentage(raw)) {
    const value = Number(raw.slice(0, -1));
    return value >= 0 && value <= 100;
  }
  if (!isNumber(raw)) return false;
  const value = Number(raw);
  return value >= 0 && value <= 1;
};

const colorArguments = (name: string, args: string): { channels: string[]; alpha: string | null } | null => {
  const commaParts = splitTopLevel(args, ',');
  if (commaParts.length > 1) {
    if (commaParts.length < 3 || commaParts.length > MAX_CSS_COLOR_CHANNELS) return null;
    const channels = commaParts.slice(0, 3).map((part) => part.trim());
    if (channels.some((part) => part === '')) return null;
    const alpha = commaParts.length === 4 ? commaParts[3].trim() : null;
    if (alpha !== null && alpha === '') return null;
    return { channels, alpha };
  }
  const slashParts = args.split('/');
  if (slashParts.length > 2) return null;
  const channels = tokensOf(slashParts[0] ?? '');
  if (channels.length !== 3) return null;
  const alpha = slashParts.length === 2 ? (slashParts[1] ?? '').trim() : null;
  if (alpha !== null && alpha === '') return null;
  if (alpha === null && name === 'rgba') return null;
  return { channels, alpha };
};

const isColor = (value: string): boolean => {
  const text = value.trim().toLowerCase();
  if (text === '') return false;
  if (COLOR_KEYWORDS.has(text)) return true;
  if (HEX_COLOR_RE.test(text)) return true;
  const match = COLOR_FUNCTION_RE.exec(text);
  if (match === null) return false;
  const name = match[1] ?? '';
  const parsed = colorArguments(name, match[2] ?? '');
  if (parsed === null) return false;
  const channels = parsed.channels;
  if (name === 'rgb' || name === 'rgba') {
    const allNumbers = channels.every((part) => isNumber(part));
    const allPercent = channels.every(isPercentage);
    if (!allNumbers && !allPercent) return false;
    for (const part of channels) {
      if (allNumbers) {
        const parsedChannel = Number(part);
        if (parsedChannel < 0 || parsedChannel > 255) return false;
      } else {
        const parsedChannel = Number(part.slice(0, -1));
        if (parsedChannel < 0 || parsedChannel > 100) return false;
      }
    }
    if (parsed.alpha !== null) return isColorAlpha(parsed.alpha);
    return name === 'rgb';
  }
  const hue = channels[0] ?? '';
  const hueValue = hue.endsWith('deg') ? hue.slice(0, -3) : hue;
  if (!isNumber(hueValue)) return false;
  const degrees = Number(hueValue);
  if (degrees < 0 || degrees > 360) return false;
  const saturation = channels[1] ?? '';
  const lightness = channels[2] ?? '';
  if (!isPercentage(saturation) || !isPercentage(lightness)) return false;
  if (Number(saturation.slice(0, -1)) > 100) return false;
  if (Number(lightness.slice(0, -1)) > 100) return false;
  if (parsed.alpha !== null) return isColorAlpha(parsed.alpha);
  return name === 'hsl';
};

const isOpacity = (value: string): boolean => {
  const text = value.toLowerCase();
  if (isPercentage(text)) {
    const parsed = Number(text.slice(0, -1));
    return parsed >= 0 && parsed <= 100;
  }
  if (!isNumber(text)) return false;
  const parsed = Number(text);
  return parsed >= 0 && parsed <= 1;
};

const isFontSize = (value: string): boolean => {
  const text = value.toLowerCase();
  if (FONT_SIZE_KEYWORDS.has(text)) return true;
  return isLength(text);
};

const isFontWeight = (value: string): boolean => {
  const text = value.toLowerCase();
  if (FONT_WEIGHT_KEYWORDS.has(text)) return true;
  if (!isNumber(text)) return false;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000;
};

const isLineHeight = (value: string): boolean => {
  const text = value.toLowerCase();
  if (text === 'normal') return true;
  if (isNumber(text)) {
    const parsed = Number(text);
    return parsed >= 0 && parsed <= 4;
  }
  return isLength(text);
};

const isVerticalAlign = (value: string): boolean => {
  const text = value.toLowerCase();
  if (/^(baseline|middle|sub|super|text-top|text-bottom|top|bottom)$/.test(text)) return true;
  return isLength(text);
};

const isTextDecorationLine = (value: string): boolean => {
  const tokens = tokensOf(value.toLowerCase());
  if (tokens.length < 1 || tokens.length > 3) return false;
  if (tokens.every((token) => !TEXT_DECORATION_TOKENS.has(token))) return false;
  if (tokens.includes('none') && tokens.length > 1) return false;
  return tokens.every((token) => TEXT_DECORATION_TOKENS.has(token));
};

const isFontFamily = (value: string): boolean => {
  const families = splitTopLevel(value, ',');
  if (families.length < 1 || families.length > MAX_CSS_FONT_FAMILIES) return false;
  return families.every((family) => FONT_FAMILY_NAME_RE.test(family.trim()));
};

const isAspectRatio = (value: string): boolean => {
  const text = value.toLowerCase().replace(/\s+/g, '');
  if (text === 'auto') return true;
  if (text === '') return false;
  const parts = text.split('/');
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((part) => {
    if (!ASPECT_RATIO_PART_RE.test(part)) return false;
    const parsed = Number(part);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_CSS_LENGTH_VALUE;
  });
};

const isBoxShadow = (value: string): boolean => {
  const layers = splitTopLevel(value, ',');
  if (layers.length < 1 || layers.length > MAX_CSS_SHADOW_LAYERS) return false;
  return layers.every((layer) => {
    let tokens = tokensOf(layer.toLowerCase());
    if (tokens.length > 0 && tokens[0] === 'inset') tokens = tokens.slice(1);
    if (tokens.length > 0 && isColor(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
    if (tokens.length > 0 && isColor(tokens[0])) tokens = tokens.slice(1);
    if (tokens.length < 2 || tokens.length > 4) return false;
    return tokens.every(isLength);
  });
};

const isEnum = (pattern: RegExp) => (value: string): boolean => pattern.test(value.toLowerCase());

const isKeywordList = (
  allowed: ReadonlySet<string>,
  maxTokens: number,
) => (value: string): boolean => {
  const tokens = tokensOf(value.toLowerCase());
  if (tokens.length < 1 || tokens.length > maxTokens) return false;
  return tokens.every((token) => allowed.has(token));
};

const VALUE_CHECKS: ReadonlyMap<string, (value: string) => boolean> = new Map<string, (value: string) => boolean>([
  ...LENGTH_PROPERTIES.map((property) => [property, isLength] as const),
  ...LENGTH_LIST_PROPERTIES.map((property) => [property, isLengthList] as const),
  ...COLOR_PROPERTIES.map((property) => [property, isColor] as const),
  ...BORDER_STYLE_PROPERTIES.map((property) => [property, isKeywordList(BORDER_STYLE_KEYWORDS, 1)] as const),
  ['border-style', isKeywordList(BORDER_STYLE_KEYWORDS, 4)],
  ['opacity', isOpacity],
  ['font-family', isFontFamily],
  ['font-size', isFontSize],
  ['font-style', isEnum(FONT_STYLE_RE)],
  ['font-weight', isFontWeight],
  ['line-height', isLineHeight],
  ['text-align', isEnum(TEXT_ALIGN_RE)],
  ['text-transform', isEnum(TEXT_TRANSFORM_RE)],
  ['text-decoration-line', isTextDecorationLine],
  ['text-overflow', isEnum(TEXT_OVERFLOW_RE)],
  ['white-space', isEnum(WHITE_SPACE_RE)],
  ['overflow', isEnum(OVERFLOW_RE)],
  ['aspect-ratio', isAspectRatio],
  ['box-shadow', isBoxShadow],
  ['vertical-align', isVerticalAlign],
]);

const FORBIDDEN_SUBSTRINGS = ['!', '*', '\\', ';', ':', '{', '}', '@', '<', '>', '$', '`', '|', '&'];

const forbiddenTokenReason = (value: string): CssRejectionReason | null => {
  for (const token of FORBIDDEN_SUBSTRINGS) {
    if (value.includes(token)) return 'forbidden-token';
  }
  if (!VALUE_CHARSET_RE.test(value)) return 'forbidden-token';
  FUNCTION_NAME_RE.lastIndex = 0;
  let match = FUNCTION_NAME_RE.exec(value);
  while (match !== null) {
    if (!ALLOWED_FUNCTIONS.has((match[1] ?? '').toLowerCase())) return 'forbidden-token';
    match = FUNCTION_NAME_RE.exec(value);
  }
  if (countChar(value, '(') !== countChar(value, ')')) return 'invalid-value';
  return null;
};

export function validateCssDeclaration(property: string, value: string): CssCheck {
  if (property.length === 0) return { ok: false, reason: 'empty-property' };
  if (property.length > 64) return { ok: false, reason: 'invalid-property-name', property };
  if (!PROPERTY_NAME_RE.test(property)) {
    return { ok: false, reason: 'invalid-property-name', property };
  }
  if (DENIED_PROPERTIES.has(property)) return { ok: false, reason: 'forbidden-property', property };
  if (!ALLOWED_PROPERTIES.has(property)) return { ok: false, reason: 'unknown-property', property };
  if (typeof value !== 'string') return { ok: false, reason: 'value-not-string', property };
  const text = value.trim();
  if (text === '') return { ok: false, reason: 'value-empty', property };
  if (text.length > MAX_CSS_VALUE_CHARS) {
    return { ok: false, reason: 'value-too-long', property };
  }
  const tokenReason = forbiddenTokenReason(text);
  if (tokenReason !== null) return { ok: false, reason: tokenReason, property };
  const check = VALUE_CHECKS.get(property);
  if (check === undefined) return { ok: false, reason: 'unknown-property', property };
  if (!check(text)) return { ok: false, reason: 'invalid-value', property };
  return { ok: true, declarations: { [property]: text } };
}

export function validateDeclarations(input: unknown): CssCheck {
  if (!isPlainObject(input)) return { ok: false, reason: 'not-an-object' };
  const entries = Object.entries(input);
  if (entries.length > MAX_CSS_DECLARATIONS) return { ok: false, reason: 'too-many-declarations' };
  const accepted: Record<string, string> = {};
  for (const [property, value] of entries) {
    const check = validateCssDeclaration(property, value as string);
    if (!check.ok) {
      return { ok: false, reason: check.reason, property: check.property ?? property };
    }
    Object.assign(accepted, check.declarations);
  }
  return { ok: true, declarations: Object.freeze(accepted) };
}

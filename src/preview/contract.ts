import type { CssRejectionReason } from './cssPolicy.ts';
import { validateDeclarations } from './cssPolicy.ts';

export const PREVIEW_BLOCK_LANGUAGE = 'design-inspector-preview';

/**
 * v2 added operations that are not CSS declarations.
 *
 * v1 could only say "set this property to this value", which made three real
 * requests inexpressible: removing text, replacing text, and taking a component
 * out of the page. The model had no way to answer those except to pretend, and
 * the workarounds it reached for (`color: transparent`, `font-size: 0`) are
 * hiding, not removing — the element still occupies its box.
 *
 * v1 is still accepted so a block produced against the older shape, or a
 * session persisted before the upgrade, keeps working.
 */
export const PREVIEW_SCHEMA_VERSION = 2;
export const SUPPORTED_PREVIEW_SCHEMA_VERSIONS: readonly number[] = Object.freeze([1, 2]);

export const MAX_PREVIEW_RULES = 12;
export const MAX_PREVIEW_BLOCK_CHARS = 8_192;
export const MAX_PREVIEW_TARGET = 9_999;
export const MAX_PREVIEW_TEXT_CHARS = 200;

export type PreviewTextOp = 'clear';
export type PreviewElementOp = 'hide' | 'remove';

export const PREVIEW_TEXT_OPS: readonly PreviewTextOp[] = Object.freeze(['clear']);
export const PREVIEW_ELEMENT_OPS: readonly PreviewElementOp[] = Object.freeze(['hide', 'remove']);

export interface PreviewRule {
  target: number;
  /** Always an object. Empty when the rule carries only a text or element op. */
  declarations: Readonly<Record<string, string>>;
  /** 'clear' removes the element's own text. */
  text?: PreviewTextOp;
  /** Replaces the element's own text with this string. */
  replaceText?: string;
  /** 'hide' takes it out of the render, 'remove' takes it out of the DOM. */
  element?: PreviewElementOp;
}

export interface PreviewCandidate {
  version: number;
  rules: readonly PreviewRule[];
}

export type PreviewRejectionReason =
  | 'block-not-json'
  | 'block-too-large'
  | 'not-an-object'
  | 'missing-key'
  | 'unknown-key'
  | 'bad-version'
  | 'bad-rules'
  | 'bad-rule'
  | 'duplicate-citation'
  | 'bad-target'
  | 'unknown-citation'
  | 'bad-declarations'
  | 'bad-text-op'
  | 'bad-element-op'
  | 'conflicting-operations'
  | 'no-operation';

export type PreviewCheck =
  | { ok: true; candidate: PreviewCandidate }
  | {
      ok: false;
      reason: PreviewRejectionReason;
      detail?: CssRejectionReason;
      target?: number;
      property?: string;
    };

export interface PreviewValidationContext {
  knownCitationNumbers?: readonly number[];
}

const TOP_LEVEL_KEYS = new Set(['version', 'rules']);

/**
 * `target` is the only required key. The other three are operations, and a rule
 * has to carry at least one of them or it does nothing.
 */
const RULE_REQUIRED_KEYS = new Set(['target']);
const RULE_OPTIONAL_KEYS = new Set(['declarations', 'text', 'replaceText', 'element']);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): PreviewRejectionReason | null {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) return 'unknown-key';
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return 'missing-key';
  }
  return null;
}

function hasKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): PreviewRejectionReason | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return 'unknown-key';
  }
  return null;
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
): PreviewRejectionReason | null {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return 'missing-key';
  }
  return null;
}

function readTarget(raw: unknown): number | PreviewRejectionReason {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > MAX_PREVIEW_TARGET
  ) {
    return 'bad-target';
  }
  return raw;
}

function readOperations(raw: Record<string, unknown>): Extract<PreviewCheck, { ok: false }> | null {
  const text = raw['text'];
  if (text !== undefined && !PREVIEW_TEXT_OPS.includes(text as PreviewTextOp)) {
    return { ok: false, reason: 'bad-text-op' };
  }
  const element = raw['element'];
  if (element !== undefined && !PREVIEW_ELEMENT_OPS.includes(element as PreviewElementOp)) {
    return { ok: false, reason: 'bad-element-op' };
  }
  const replaceText = raw['replaceText'];
  if (replaceText !== undefined) {
    // Clearing and replacing are two ways to do one job, and a rule that asks
    // for both has no single meaning to apply.
    if (text !== undefined) return { ok: false, reason: 'conflicting-operations' };
    if (typeof replaceText !== 'string' || replaceText.length > MAX_PREVIEW_TEXT_CHARS) {
      return { ok: false, reason: 'bad-text-op' };
    }
  }
  return null;
}

export function validatePreviewPayload(
  input: unknown,
  ctx: PreviewValidationContext = {},
): PreviewCheck {
  if (!isPlainObject(input)) return { ok: false, reason: 'not-an-object' };
  const shape = hasExactKeys(input, TOP_LEVEL_KEYS);
  if (shape !== null) return { ok: false, reason: shape };
  if (
    typeof input['version'] !== 'number' ||
    !SUPPORTED_PREVIEW_SCHEMA_VERSIONS.includes(input['version'])
  ) {
    return { ok: false, reason: 'bad-version' };
  }
  const rawRules = input['rules'];
  if (!Array.isArray(rawRules)) return { ok: false, reason: 'bad-rules' };
  if (rawRules.length < 1 || rawRules.length > MAX_PREVIEW_RULES) {
    return { ok: false, reason: 'bad-rules' };
  }
  const known = ctx.knownCitationNumbers;
  const seen = new Set<number>();
  const rules: PreviewRule[] = [];
  for (const rawRule of rawRules) {
    if (!isPlainObject(rawRule)) return { ok: false, reason: 'bad-rule' };
    const unknown = hasKnownKeys(rawRule, new Set([...RULE_REQUIRED_KEYS, ...RULE_OPTIONAL_KEYS]));
    if (unknown !== null) return { ok: false, reason: unknown };
    const missing = hasRequiredKeys(rawRule, RULE_REQUIRED_KEYS);
    if (missing !== null) return { ok: false, reason: missing };
    const target = readTarget(rawRule['target']);
    if (typeof target !== 'number') return { ok: false, reason: target, };
    if (known !== undefined && !known.includes(target)) {
      return { ok: false, reason: 'unknown-citation', target };
    }
    if (seen.has(target)) return { ok: false, reason: 'duplicate-citation', target };
    seen.add(target);

    const rawDeclarations = rawRule['declarations'];
    const declarations =
      rawDeclarations === undefined
        ? { ok: true as const, declarations: Object.freeze({} as Record<string, string>) }
        : validateDeclarations(rawDeclarations);
    if (!declarations.ok) {
      return {
        ok: false,
        reason: 'bad-declarations',
        detail: declarations.reason,
        target,
        ...(declarations.property === undefined ? {} : { property: declarations.property }),
      };
    }

    const operationError = readOperations(rawRule);
    if (operationError !== null) return { ...operationError, target };

    const text = rawRule['text'];
    const element = rawRule['element'];
    const replaceText = rawRule['replaceText'];
    if (
      Object.keys(declarations.declarations).length === 0 &&
      text === undefined &&
      element === undefined &&
      replaceText === undefined
    ) {
      return { ok: false, reason: 'no-operation', target };
    }

    const rule: PreviewRule = { target, declarations: declarations.declarations };
    if (text !== undefined) rule.text = text as PreviewTextOp;
    if (element !== undefined) rule.element = element as PreviewElementOp;
    if (typeof replaceText === 'string') rule.replaceText = replaceText;
    rules.push(Object.freeze(rule));
  }
  return { ok: true, candidate: Object.freeze({ version: input['version'], rules: Object.freeze(rules) }) };
}

export function validatePreviewBlock(
  raw: string,
  ctx: PreviewValidationContext = {},
): PreviewCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'block-not-json' };
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'block-not-json' };
  if (text.length > MAX_PREVIEW_BLOCK_CHARS) return { ok: false, reason: 'block-too-large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'block-not-json' };
  }
  return validatePreviewPayload(parsed, ctx);
}

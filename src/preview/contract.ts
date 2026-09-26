import type { CssRejectionReason } from './cssPolicy.ts';
import { validateDeclarations } from './cssPolicy.ts';

export const PREVIEW_BLOCK_LANGUAGE = 'design-inspector-preview';
export const PREVIEW_SCHEMA_VERSION = 1;
export const MAX_PREVIEW_RULES = 12;
export const MAX_PREVIEW_BLOCK_CHARS = 8_192;
export const MAX_PREVIEW_TARGET = 9_999;

export interface PreviewRule {
  target: number;
  declarations: Readonly<Record<string, string>>;
}

export interface PreviewCandidate {
  version: typeof PREVIEW_SCHEMA_VERSION;
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
  | 'bad-declarations';

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
const RULE_KEYS = new Set(['target', 'declarations']);

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

export function validatePreviewPayload(
  input: unknown,
  ctx: PreviewValidationContext = {},
): PreviewCheck {
  if (!isPlainObject(input)) return { ok: false, reason: 'not-an-object' };
  const shape = hasExactKeys(input, TOP_LEVEL_KEYS);
  if (shape !== null) return { ok: false, reason: shape };
  if (input['version'] !== PREVIEW_SCHEMA_VERSION) return { ok: false, reason: 'bad-version' };
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
    const ruleShape = hasExactKeys(rawRule, RULE_KEYS);
    if (ruleShape !== null) return { ok: false, reason: ruleShape };
    const target = rawRule['target'];
    if (
      typeof target !== 'number' ||
      !Number.isSafeInteger(target) ||
      target < 1 ||
      target > MAX_PREVIEW_TARGET
    ) {
      return { ok: false, reason: 'bad-target' };
    }
    if (known !== undefined && !known.includes(target)) {
      return { ok: false, reason: 'unknown-citation', target };
    }
    if (seen.has(target)) return { ok: false, reason: 'duplicate-citation', target };
    seen.add(target);
    const declarations = validateDeclarations(rawRule['declarations']);
    if (!declarations.ok) {
      return {
        ok: false,
        reason: 'bad-declarations',
        detail: declarations.reason,
        target,
        ...(declarations.property === undefined ? {} : { property: declarations.property }),
      };
    }
    rules.push(Object.freeze({ target, declarations: declarations.declarations }));
  }
  return { ok: true, candidate: Object.freeze({ version: PREVIEW_SCHEMA_VERSION, rules: Object.freeze(rules) }) };
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

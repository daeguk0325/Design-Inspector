import { describe, expect, it } from 'vitest';
import {
  MAX_PREVIEW_BLOCK_CHARS,
  MAX_PREVIEW_RULES,
  MAX_PREVIEW_TEXT_CHARS,
  PREVIEW_BLOCK_LANGUAGE,
  PREVIEW_ELEMENT_OPS,
  PREVIEW_SCHEMA_VERSION,
  PREVIEW_TEXT_OPS,
  SUPPORTED_PREVIEW_SCHEMA_VERSIONS,
  validatePreviewBlock,
  validatePreviewPayload,
} from './contract.ts';

const rule = (target: number, declarations: Record<string, string> = { 'border-radius': '8px' }) => ({
  target,
  declarations,
});

const payload = (rules: unknown[] = [rule(1)], extra: Record<string, unknown> = {}) => ({
  version: PREVIEW_SCHEMA_VERSION,
  rules,
  ...extra,
});

const reasonOf = (check: ReturnType<typeof validatePreviewBlock>) =>
  check.ok ? 'ok' : check.reason;

describe('preview block contract', () => {
  it('exposes stable contract constants', () => {
    expect(PREVIEW_BLOCK_LANGUAGE).toBe('design-inspector-preview');
    // v2 is what the prompt teaches. v1 is still accepted so a block written
    // against the older shape keeps working.
    expect(PREVIEW_SCHEMA_VERSION).toBe(2);
    expect(SUPPORTED_PREVIEW_SCHEMA_VERSIONS).toEqual([1, 2]);
    expect(MAX_PREVIEW_RULES).toBe(12);
    expect(MAX_PREVIEW_BLOCK_CHARS).toBe(8_192);
    expect(MAX_PREVIEW_TEXT_CHARS).toBe(200);
    expect(PREVIEW_TEXT_OPS).toEqual(['clear']);
    expect(PREVIEW_ELEMENT_OPS).toEqual(['hide', 'remove']);
  });

  it('accepts a minimal well-formed block', () => {
    const raw = JSON.stringify(payload());
    const check = validatePreviewBlock(raw);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.candidate).toEqual({
      version: PREVIEW_SCHEMA_VERSION,
      rules: [{ target: 1, declarations: { 'border-radius': '8px' } }],
    });
    expect(Object.isFrozen(check.candidate)).toBe(true);
    expect(Object.isFrozen(check.candidate.rules)).toBe(true);
    expect(Object.isFrozen(check.candidate.rules[0]?.declarations)).toBe(true);
  });

  it('still accepts a v1 block', () => {
    // Sessions persisted before the upgrade, and a model that ignored the new
    // version number, both have to keep working.
    const check = validatePreviewBlock(
      JSON.stringify({ version: 1, rules: [rule(1)] }),
      { knownCitationNumbers: [1] },
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.candidate.version).toBe(1);
  });

  it('accepts multiple rules and trims block whitespace', () => {
    const raw = `\n  ${JSON.stringify(
      payload([
        rule(1, { color: '#111111', 'font-size': '13px' }),
        rule(4, { 'background-color': 'rgb(246, 247, 249)', padding: '8px 16px' }),
      ]),
    )}  \n`;
    const check = validatePreviewBlock(raw);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.candidate.rules.map((entry) => entry.target)).toEqual([1, 4]);
  });

  it('rejects invalid JSON and non-string input', () => {
    expect(reasonOf(validatePreviewBlock('{"version":1,'))).toBe('block-not-json');
    expect(reasonOf(validatePreviewBlock('not json at all'))).toBe('block-not-json');
    expect(reasonOf(validatePreviewBlock('   '))).toBe('block-not-json');
    expect(reasonOf(validatePreviewBlock(undefined as unknown as string))).toBe('block-not-json');
    expect(reasonOf(validatePreviewBlock('[]'))).toBe('not-an-object');
    expect(reasonOf(validatePreviewBlock('null'))).toBe('not-an-object');
    expect(reasonOf(validatePreviewBlock('42'))).toBe('not-an-object');
  });

  it('rejects oversized block text before parsing', () => {
    const filler = 'x'.repeat(MAX_PREVIEW_BLOCK_CHARS + 1);
    expect(reasonOf(validatePreviewBlock(filler))).toBe('block-too-large');
    const padded = `{"version":1,"rules":[],"pad":"${'x'.repeat(9_000)}"}`;
    expect(reasonOf(validatePreviewBlock(padded))).toBe('block-too-large');
  });

  it('rejects unknown and missing top-level keys', () => {
    const withExtra = JSON.stringify(payload([rule(1)], { extra: 1 }));
    const withNotes = JSON.stringify({ version: 1, rules: [rule(1)], notes: 'x' });
    expect(reasonOf(validatePreviewBlock(withExtra))).toBe('unknown-key');
    expect(reasonOf(validatePreviewBlock(JSON.stringify({ rules: [rule(1)] })))).toBe('missing-key');
    expect(reasonOf(validatePreviewBlock(JSON.stringify({ version: 1 })))).toBe('missing-key');
    expect(reasonOf(validatePreviewBlock(withNotes))).toBe('unknown-key');
  });

  it('rejects a wrong version', () => {
    const v3 = JSON.stringify({ version: 3, rules: [rule(1)] });
    const v0 = JSON.stringify({ version: 0, rules: [rule(1)] });
    const stringV2 = JSON.stringify({ version: '2', rules: [rule(1)] });
    const noVersion = JSON.stringify({ rules: [rule(1)] });
    expect(reasonOf(validatePreviewBlock(v3))).toBe('bad-version');
    expect(reasonOf(validatePreviewBlock(v0))).toBe('bad-version');
    expect(reasonOf(validatePreviewBlock(stringV2))).toBe('bad-version');
    expect(reasonOf(validatePreviewBlock(noVersion))).toBe('missing-key');
  });

  it('bounds the rule array', () => {
    const many = Array.from({ length: MAX_PREVIEW_RULES }, (_unused, index) => rule(index + 1));
    expect(validatePreviewBlock(JSON.stringify(payload(many))).ok).toBe(true);
    const tooMany = [...many, rule(MAX_PREVIEW_RULES + 1)];
    expect(reasonOf(validatePreviewBlock(JSON.stringify(payload(tooMany))))).toBe('bad-rules');
    expect(reasonOf(validatePreviewBlock(JSON.stringify(payload([]))))).toBe('bad-rules');
    const notArray = JSON.stringify({ version: 1, rules: {} });
    expect(reasonOf(validatePreviewBlock(notArray))).toBe('bad-rules');
  });

  it('rejects malformed rule objects and rule keys', () => {
    const raw = (rules: unknown[]): string => JSON.stringify(payload(rules));
    expect(reasonOf(validatePreviewBlock(raw(['#app'])))).toBe('bad-rule');
    expect(reasonOf(validatePreviewBlock(raw([null])))).toBe('bad-rule');
    expect(reasonOf(validatePreviewBlock(raw([['target', 1]])))).toBe('bad-rule');
    expect(reasonOf(validatePreviewBlock(raw([{ target: 1, declarations: {}, x: 1 }])))).toBe(
      'unknown-key',
    );
    expect(reasonOf(validatePreviewBlock(raw([{ declarations: { color: 'red' } }])))).toBe(
      'missing-key',
    );
  });

  it('rejects a rule that carries no operation', () => {
    // `target` alone and an empty declarations map both parse, validate and then
    // do nothing, which is how a block gets offered and no page moves.
    const raw = (rule: unknown): string => JSON.stringify(payload([rule]));
    expect(reasonOf(validatePreviewBlock(raw({ target: 1 })))).toBe('no-operation');
    expect(reasonOf(validatePreviewBlock(raw({ target: 1, declarations: {} })))).toBe('no-operation');
  });

  it('accepts the v2 operations, alone and beside declarations', () => {
    const rules: unknown[] = [
      { target: 1, declarations: {}, text: 'clear' },
      { target: 2, declarations: {}, replaceText: '주문하기' },
      { target: 3, declarations: {}, element: 'hide' },
      { target: 4, declarations: {}, element: 'remove' },
      // The font-only component case: words gone, element untouched.
      { target: 5, declarations: { padding: '12px 16px' }, text: 'clear' },
    ];
    const check = validatePreviewBlock(JSON.stringify(payload(rules)), {
      knownCitationNumbers: [1, 2, 3, 4, 5],
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.candidate.rules.map((entry) => entry.target)).toEqual([1, 2, 3, 4, 5]);
    expect(check.candidate.rules[0]).toEqual({ target: 1, declarations: {}, text: 'clear' });
    expect(check.candidate.rules[1]).toEqual({ target: 2, declarations: {}, replaceText: '주문하기' });
    expect(check.candidate.rules[2]).toEqual({ target: 3, declarations: {}, element: 'hide' });
    expect(check.candidate.rules[4]).toEqual({
      target: 5,
      declarations: { padding: '12px 16px' },
      text: 'clear',
    });
  });

  it('applies the operation rules the Bridge implements', () => {
    const raw = (rule: unknown): string => JSON.stringify(payload([rule]));
    const long = '가'.repeat(MAX_PREVIEW_TEXT_CHARS);
    expect(validatePreviewBlock(raw({ target: 1, declarations: {}, replaceText: long })).ok).toBe(true);
    expect(reasonOf(validatePreviewBlock(raw({ target: 1, declarations: {}, replaceText: `${long}가` })))).toBe(
      'bad-text-op',
    );
    // Clearing and replacing are two ways to do one job.
    expect(
      reasonOf(validatePreviewBlock(raw({ target: 1, declarations: {}, text: 'clear', replaceText: 'x' }))),
    ).toBe('conflicting-operations');
    for (const text of ['CLEAR', 'clear ', 1, null, 'remove']) {
      expect({ text: String(text), reason: reasonOf(validatePreviewBlock(raw({ target: 1, text }))) }).toEqual({
        text: String(text),
        reason: 'bad-text-op',
      });
    }
    for (const element of ['HIDE', 'display', 'none', 1, null]) {
      expect(
        { element: String(element), reason: reasonOf(validatePreviewBlock(raw({ target: 1, element }))) },
      ).toEqual({ element: String(element), reason: 'bad-element-op' });
    }
    expect(reasonOf(validatePreviewBlock(raw({ target: 1, replaceText: 7 })))).toBe('bad-text-op');
  });

  it('keeps the display denylist inside declarations, not on the element op', () => {
    // `element` is a deliberate operation and `display` is a model inventing a
    // property in a free-form map. They are not the same request, and widening
    // the allowlist for the first would allow the second.
    const hidden = JSON.stringify(payload([{ target: 1, declarations: {}, element: 'hide' }]));
    expect(validatePreviewBlock(hidden).ok).toBe(true);
    const declared = JSON.stringify(payload([rule(1, { display: 'none' })]));
    expect(reasonOf(validatePreviewBlock(declared))).toBe('bad-declarations');
    const declaredVisibility = JSON.stringify(payload([rule(1, { visibility: 'hidden' })]));
    expect(reasonOf(validatePreviewBlock(declaredVisibility))).toBe('bad-declarations');
  });

  it('rejects duplicate citation targets', () => {
    const check = validatePreviewBlock(JSON.stringify(payload([rule(1), rule(2), rule(1)])));
    expect(check).toEqual({ ok: false, reason: 'duplicate-citation', target: 1 });
  });

  it('rejects invalid targets', () => {
    for (const target of ['1', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000, null]) {
      const raw = JSON.stringify(payload([{ target, declarations: { color: 'red' } }]));
      expect({ target: String(target), reason: reasonOf(validatePreviewBlock(raw)) }).toEqual({
        target: String(target),
        reason: 'bad-target',
      });
    }
  });

  it('rejects unknown citation numbers when the known set is supplied', () => {
    const raw = JSON.stringify(payload([rule(3)]));
    expect(validatePreviewBlock(raw, { knownCitationNumbers: [1, 2, 3] }).ok).toBe(true);
    expect(validatePreviewBlock(raw, { knownCitationNumbers: [1, 2] })).toEqual({
      ok: false,
      reason: 'unknown-citation',
      target: 3,
    });
    expect(validatePreviewBlock(raw, { knownCitationNumbers: [] })).toEqual({
      ok: false,
      reason: 'unknown-citation',
      target: 3,
    });
    expect(validatePreviewBlock(raw).ok).toBe(true);
  });

  it('forwards CSS policy rejections', () => {
    const display = JSON.stringify(payload([rule(1, { display: 'none' })]));
    const url = JSON.stringify(payload([rule(1, { 'background-color': 'url(x)' })]));
    const notAMap = JSON.stringify(payload([rule(1, 'color:red' as unknown as Record<string, string>)]));
    const custom = JSON.stringify(payload([rule(1, { '--accent': '#fff' })]));
    expect(validatePreviewBlock(display)).toEqual({
      ok: false,
      reason: 'bad-declarations',
      detail: 'forbidden-property',
      target: 1,
      property: 'display',
    });
    expect(validatePreviewBlock(url)).toEqual({
      ok: false,
      reason: 'bad-declarations',
      detail: 'forbidden-token',
      target: 1,
      property: 'background-color',
    });
    expect(reasonOf(validatePreviewBlock(notAMap))).toBe('bad-declarations');
    expect(validatePreviewBlock(custom)).toEqual({
      ok: false,
      reason: 'bad-declarations',
      detail: 'invalid-property-name',
      target: 1,
      property: '--accent',
    });
  });

  it('validates already-parsed payloads with the same rules', () => {
    expect(validatePreviewPayload(payload()).ok).toBe(true);
    expect(validatePreviewPayload(JSON.parse(JSON.stringify(payload()))).ok).toBe(true);
    expect(validatePreviewPayload({ version: 1, rules: 'nope' })).toEqual({
      ok: false,
      reason: 'bad-rules',
    });
    expect(validatePreviewPayload(new Map())).toEqual({ ok: false, reason: 'not-an-object' });
  });

  it('never throws on hostile input', () => {
    const hostile: unknown[] = [
      { version: 1, rules: [{ target: 1, declarations: { color: { nested: true } } }] },
      { version: 1, rules: [{ target: 1, declarations: [] }] },
      { version: 1, rules: [{ target: 1, declarations: null }] },
      { version: NaN, rules: [rule(1)] },
      { version: 1, rules: { length: 1 } },
    ];
    for (const input of hostile) {
      expect(() => validatePreviewPayload(input)).not.toThrow();
      expect(validatePreviewPayload(input).ok).toBe(false);
    }
  });
});

// Protocol tests (§22.1): envelope, staleness, source/origin helpers.
import { describe, expect, it } from 'vitest';
import {
  isExpectedSource,
  targetOriginFor,
  validateAppMessage,
  validateBridgeMessage,
} from './validate.ts';
import type { AppValidationContext, ValidationContext } from './validate.ts';

function envelope(over: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    type: 'VERA_INSPECTOR_PONG',
    connectionId: 'c1',
    documentGeneration: 'd1',
    requestId: 'r1',
    sequence: 5,
    payload: {},
    ...over,
  };
}

const HANDSHAKE: ValidationContext = {
  expectedConnectionId: null,
  expectedDocumentGeneration: null,
  lastSequence: 0,
};

const CONNECTED: ValidationContext = {
  expectedConnectionId: 'c1',
  expectedDocumentGeneration: 'd1',
  lastSequence: 0,
};

const APP: AppValidationContext = { expectedConnectionId: 'c1', lastSequence: 0 };

function check(raw: unknown, ctx: ValidationContext = CONNECTED) {
  return validateBridgeMessage(raw, ctx);
}

function checkApp(raw: unknown, ctx: AppValidationContext = APP) {
  return validateAppMessage(raw, ctx);
}

function anchor(over: Record<string, unknown> = {}) {
  return {
    elementKey: 'html:testid:cta',
    routeKey: '/checkout',
    mode: 'html',
    tagName: 'button',
    id: '',
    testId: 'cta',
    path: 'main/div/button:0',
    ...over,
  };
}

function record(over: Record<string, unknown> = {}) {
  return {
    selectionId: 'sel-1',
    elementKey: 'html:testid:cta',
    component: 'Button',
    file: 'src/App.tsx',
    line: 12,
    mode: 'html',
    state: 'active',
    order: 0,
    ...over,
  };
}

function snapshotPayload(over: Record<string, unknown> = {}) {
  return {
    connectionId: 'c1',
    documentGeneration: 'd1',
    inspectorFrozen: true,
    mode: 'html',
    selections: [record()],
    activeOrder: ['sel-1'],
    ...over,
  };
}

function selectionPayload(recordOver: Record<string, unknown> = {}, activeOrder: unknown = ['sel-1']) {
  return { record: record(recordOver), activeOrder };
}

function previewResult(over: Record<string, unknown> = {}) {
  return {
    bindingId: 'bind-1',
    transactionId: 'tx-1',
    operation: 'apply',
    status: 'applied',
    anchors: [{ elementKey: 'html:testid:cta', status: 'applied', matchCount: 1 }],
    routeKey: '/checkout',
    routeEpoch: 3,
    ...over,
  };
}

function previewApply(over: Record<string, unknown> = {}) {
  return {
    bindingId: 'bind-1',
    transactionId: 'tx-1',
    changes: [{ anchor: anchor(), declarations: { 'background-color': '#0ea5e9' } }],
    ...over,
  };
}

function oversized(max: number): string {
  return 'a'.repeat(max + 1);
}

function manyItems(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `sel-${index}`);
}

describe('validateBridgeMessage', () => {
  it('accepts a well-formed HELLO_ACK during handshake (null context)', () => {
    const res = validateBridgeMessage(envelope({
      type: 'VERA_INSPECTOR_HELLO_ACK',
      payload: {
        bridgeConnectionId: 'c1',
        documentGeneration: 'd1',
        veraUrl: 'http://127.0.0.1:3000',
      },
    }), HANDSHAKE);
    expect(res.ok).toBe(true);
  });

  it('rejects malformed envelopes without mutating', () => {
    for (const bad of [null, 42, 'x', {}, { type: 'VERA_INSPECTOR_PONG' }]) {
      expect(
        validateBridgeMessage(bad, HANDSHAKE).ok,
      ).toBe(false);
    }
  });

  it('rejects unsafe sequence values and null payloads', () => {
    for (const over of [
      { sequence: Number.NaN },
      { sequence: Number.POSITIVE_INFINITY },
      { sequence: -1 },
      { payload: null },
      { payload: [] },
    ]) {
      expect(validateBridgeMessage(envelope(over), HANDSHAKE).ok).toBe(false);
    }
  });

  it('rejects unknown protocol versions and unknown types', () => {
    expect(
      validateBridgeMessage(envelope({ protocolVersion: 999 }), HANDSHAKE).reason,
    ).toBe('bad-protocol-version');
    expect(
      validateBridgeMessage(envelope({ type: 'NOPE' }), HANDSHAKE).reason,
    ).toBe('unknown-type');
  });

  it('rejects unknown Bridge kind values', () => {
    expect(
      validateBridgeMessage(envelope({ payload: { bridgeKind: 'unexpected' } }), HANDSHAKE).reason,
    ).toBe('bad-envelope');
  });

  it('rejects stale connection IDs (HMR/restart creates a new instance)', () => {
    const res = validateBridgeMessage(
      envelope({
        type: 'VERA_INSPECTOR_SELECTION',
        sequence: 9,
        payload: selectionPayload(),
      }),
      { expectedConnectionId: 'c2', expectedDocumentGeneration: null, lastSequence: 0 },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stale-connection');
  });

  it('accepts sequence-zero HELLO_ACK from a new instance during rotation', () => {
    const res = validateBridgeMessage(
      envelope({
        type: 'VERA_INSPECTOR_HELLO_ACK',
        connectionId: 'c-new',
        documentGeneration: 'd1',
        sequence: 0,
        payload: {
          bridgeConnectionId: 'c-new',
          documentGeneration: 'd1',
          veraUrl: 'http://127.0.0.1:3000',
        },
      }),
      { expectedConnectionId: 'c-old', expectedDocumentGeneration: null, lastSequence: 9 },
    );
    expect(res.ok).toBe(true);
  });

  it('rejects stale document generations for selection events', () => {
    const res = validateBridgeMessage(
      envelope({
        type: 'VERA_INSPECTOR_SELECTION',
        documentGeneration: 'd-old',
        sequence: 9,
        payload: selectionPayload(),
      }),
      { expectedConnectionId: 'c1', expectedDocumentGeneration: 'd-new', lastSequence: 0 },
    );
    expect(res.reason).toBe('stale-generation');
  });

  it('rejects stale sequences (old ACKs cannot overwrite newer state)', () => {
    const res = validateBridgeMessage(envelope({ type: 'VERA_INSPECTOR_SNAPSHOT', sequence: 3 }), {
      expectedConnectionId: 'c1',
      expectedDocumentGeneration: null,
      lastSequence: 7,
    });
    expect(res.reason).toBe('stale-sequence');
  });

  it('accepts bounded component capture results and rejects malformed assets', () => {
    const valid = validateBridgeMessage(envelope({
      type: 'VERA_INSPECTOR_CAPTURE_RESULT',
      payload: {
        selectionId: 's1',
        mimeType: 'image/png',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==',
        width: 1,
        height: 1,
        byteLength: 67,
      },
    }), {
      expectedConnectionId: 'c1',
      expectedDocumentGeneration: null,
      lastSequence: 0,
    });
    expect(valid.ok).toBe(true);

    const invalid = validateBridgeMessage(envelope({
      type: 'VERA_INSPECTOR_CAPTURE_RESULT',
      payload: {
        selectionId: 's1',
        mimeType: 'image/svg+xml',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==',
        width: 1,
        height: 1,
        byteLength: 67,
      },
    }), {
      expectedConnectionId: 'c1',
      expectedDocumentGeneration: null,
      lastSequence: 0,
    });
    expect(invalid.ok).toBe(false);
  });

  it('rejects selections without a Bridge-issued selectionId', () => {
    const res = validateBridgeMessage(
      envelope({ type: 'VERA_INSPECTOR_SELECTION', payload: { record: {} } }),
      CONNECTED,
    );
    expect(res.reason).toBe('missing-selection-id');
  });
});

describe('handshake payload validation', () => {
  it('accepts HELLO_ACK with bounded preview capabilities and route identity', () => {
    const res = check(envelope({
      type: 'VERA_INSPECTOR_HELLO_ACK',
      sequence: 0,
      payload: {
        bridgeConnectionId: 'c1',
        documentGeneration: 'd1',
        veraUrl: 'http://127.0.0.1:3000/checkout',
        bridgeKind: 'compatibility',
        routeKey: '/checkout',
        routeEpoch: 7,
        capabilities: {
          selectionCrop: true,
          maxSelectionImages: 4,
          maxImageBytes: 524_288,
          maxImageDimension: 1_600,
          maxImagePixels: 2_000_000,
          cssPreview: true,
          maxPreviewChanges: 12,
          maxPreviewPropertiesPerChange: 12,
          maxPreviewValueLength: 120,
        },
      },
    }), HANDSHAKE);
    expect(res.ok).toBe(true);
  });

  it('rejects out-of-contract preview capabilities', () => {
    const base = {
      selectionCrop: true,
      maxSelectionImages: 4,
      maxImageBytes: 524_288,
      maxImageDimension: 1_600,
      maxImagePixels: 2_000_000,
    };
    for (const capabilities of [
      { ...base, cssPreview: 'yes' },
      { ...base, maxPreviewChanges: 13 },
      { ...base, maxPreviewChanges: -1 },
      { ...base, maxPreviewChanges: 1.5 },
      { ...base, maxPreviewPropertiesPerChange: 0x7fffffff },
      { ...base, maxPreviewValueLength: 121 },
      { ...base, maxPreviewValueLength: '120' },
      { ...base, maxSelectionImages: 17 },
      { ...base, maxImageBytes: 5_000_001 },
      { ...base, selectionCrop: 1 },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_HELLO_ACK',
        sequence: 0,
        payload: {
          bridgeConnectionId: 'c1',
          documentGeneration: 'd1',
          veraUrl: 'http://127.0.0.1:3000',
          capabilities,
        },
      }), HANDSHAKE);
      expect(res.ok).toBe(false);
    }
  });

  it('rejects unsafe route identity and oversized veraUrl on HELLO_ACK', () => {
    for (const over of [
      { routeEpoch: -1 },
      { routeEpoch: 1.5 },
      { routeEpoch: '3' },
      { routeEpoch: Number.NaN },
      { routeKey: oversized(512) },
      { routeKey: 5 },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_HELLO_ACK',
        sequence: 0,
        payload: {
          bridgeConnectionId: 'c1',
          documentGeneration: 'd1',
          veraUrl: 'http://127.0.0.1:3000',
          ...over,
        },
      }), HANDSHAKE);
      expect(res.ok).toBe(false);
    }
    expect(check(envelope({
      type: 'VERA_INSPECTOR_HELLO_ACK',
      sequence: 0,
      payload: {
        bridgeConnectionId: 'c1',
        documentGeneration: 'd1',
        veraUrl: `http://127.0.0.1:3000/${'p'.repeat(2_048)}`,
      },
    }), HANDSHAKE).ok).toBe(false);
  });
});

describe('selection record validation', () => {
  it('accepts anchored active and inactive selection events', () => {
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: selectionPayload({ anchor: anchor() }),
    })).ok).toBe(true);
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: { record: record({ state: 'inactive' }), activeOrder: [] },
    })).ok).toBe(true);
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: selectionPayload({ anchor: anchor({ elementKey: 'html:testid:cta' }) }, ['sel-9', 'sel-1']),
    })).ok).toBe(true);
  });

  it('requires a bounded Bridge-issued elementKey', () => {
    for (const elementKey of [undefined, null, '', 5, oversized(512)]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_SELECTION',
        payload: { record: record({ elementKey }), activeOrder: ['sel-1'] },
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('requires an anchor to identify the same element as its record', () => {
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: selectionPayload({ anchor: anchor({ elementKey: 'html:id:other' }) }),
    })).ok).toBe(false);
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: selectionPayload({ anchor: anchor({ mode: '3d' }) }),
    })).ok).toBe(false);
  });

  it('rejects malformed anchors', () => {
    for (const bad of [
      null,
      'anchor',
      [],
      { ...anchor(), extra: 'nope' },
      { ...anchor(), elementKey: undefined },
      { ...anchor(), routeKey: '' },
      { ...anchor(), tagName: 'Button' },
      { ...anchor(), tagName: '<img>' },
      { ...anchor(), id: 7 },
      { ...anchor(), testId: oversized(256) },
      { ...anchor(), path: oversized(1_024) },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_SELECTION',
        payload: selectionPayload({ anchor: bad }),
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('bounds selection metadata and ordering fields', () => {
    for (const over of [
      { selectionId: oversized(200) },
      { order: -1 },
      { order: 1.5 },
      { order: 1_000_000_001 },
      { line: -1 },
      { line: 10_000_001 },
      { component: oversized(200) },
      { file: oversized(400) },
      { component: 12 },
      { mode: 'svg' },
      { state: 'pending' },
      { extra: { note: 'x'.repeat(20_000) } },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_SELECTION',
        payload: { record: record(over), activeOrder: ['sel-1'] },
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('rejects cyclic extra payloads instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const res = check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: { record: record({ extra: cyclic }), activeOrder: ['sel-1'] },
    }));
    expect(res.ok).toBe(false);
  });

  it('requires unique, bounded activeOrder entries', () => {
    for (const activeOrder of [
      ['sel-1', 'sel-1'],
      [''],
      [5],
      [oversized(200)],
      manyItems(101),
      'sel-1',
      null,
      {},
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_SELECTION',
        payload: { record: record(), activeOrder },
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('keeps activeOrder consistent with the record state', () => {
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: { record: record({ state: 'active' }), activeOrder: [] },
    })).ok).toBe(false);
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: { record: record({ state: 'inactive' }), activeOrder: ['sel-1'] },
    })).ok).toBe(false);
  });
});

describe('style facts validation', () => {
  function withFacts(styleFacts: unknown) {
    return check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: { record: record({ styleFacts }), activeOrder: ['sel-1'] },
    }));
  }

  function facts(over: Record<string, unknown> = {}) {
    return {
      props: { 'background-color': '#3884ff', display: 'inline-flex' },
      geometry: { x: 24, y: 180, width: 120, height: 40 },
      label: '주문하기',
      ancestors: ['header.nav', 'main'],
      tagName: 'button',
      ...over,
    };
  }

  it('accepts a record whose facts are within the allowlist', () => {
    expect(withFacts(facts()).ok).toBe(true);
  });

  it('accepts a partial record, because defaults are omitted', () => {
    // hasExactKeys would reject this: the Bridge omits every property whose
    // computed value equals its default, so the key set is a subset.
    expect(withFacts({ props: {} }).ok).toBe(true);
    expect(withFacts({ props: { display: 'grid' } }).ok).toBe(true);
    expect(withFacts({ props: {}, tagName: 'div' }).ok).toBe(true);
  });

  it('rejects a property outside the allowlist', () => {
    expect(withFacts(facts({ props: { 'background-image': 'url(https://evil.test/x.png)' } })).ok).toBe(false);
    // Computed key, so it is an own property rather than a prototype write.
    expect(withFacts(facts({ props: { ['__proto__']: 'x' } })).ok).toBe(false);
    expect(withFacts(facts({ props: { constructor: 'x' } })).ok).toBe(false);
  });

  it('rejects a value longer than the bound', () => {
    expect(withFacts(facts({ props: { 'font-family': 'x'.repeat(121) } })).ok).toBe(false);
    expect(withFacts(facts({ props: { 'font-family': 'x'.repeat(120) } })).ok).toBe(true);
  });

  it('rejects a non-string or empty property value', () => {
    expect(withFacts(facts({ props: { display: 42 } })).ok).toBe(false);
    expect(withFacts(facts({ props: { display: ['flex'] } })).ok).toBe(false);
    expect(withFacts(facts({ props: { display: '   ' } })).ok).toBe(false);
  });

  it('rejects more properties than the allowlist can hold', () => {
    const props: Record<string, string> = {};
    for (let index = 0; index < 57; index += 1) props[`x-${index}`] = '1px';
    expect(withFacts(facts({ props })).ok).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(withFacts(facts({ innerHTML: '<script>' })).ok).toBe(false);
  });

  it('rejects a manipulated props container', () => {
    expect(withFacts(facts({ props: [] })).ok).toBe(false);
    expect(withFacts(facts({ props: 'display:flex' })).ok).toBe(false);
    expect(withFacts(facts({ props: null })).ok).toBe(false);
  });

  it('rejects a manipulated geometry', () => {
    expect(withFacts(facts({ geometry: { x: 1, y: 2, width: 3 } })).ok).toBe(false);
    expect(withFacts(facts({ geometry: { x: 1, y: 2, width: 3, height: 4, z: 5 } })).ok).toBe(false);
    expect(withFacts(facts({ geometry: { x: 1, y: 2, width: -3, height: 4 } })).ok).toBe(false);
    expect(withFacts(facts({ geometry: { x: 1.5, y: 2, width: 3, height: 4 } })).ok).toBe(false);
    expect(withFacts(facts({ geometry: { x: '1', y: 2, width: 3, height: 4 } })).ok).toBe(false);
  });

  it('rejects an over-long label and a malformed tag name', () => {
    expect(withFacts(facts({ label: 'x'.repeat(81) })).ok).toBe(false);
    expect(withFacts(facts({ tagName: 'Button' })).ok).toBe(false);
    expect(withFacts(facts({ tagName: 'div><script>' })).ok).toBe(false);
  });

  it('rejects a manipulated ancestor chain', () => {
    expect(withFacts(facts({ ancestors: ['a', 'b', 'c', 'd'] })).ok).toBe(false);
    expect(withFacts(facts({ ancestors: 'header' })).ok).toBe(false);
    expect(withFacts(facts({ ancestors: ['header nav'] })).ok).toBe(false);
    expect(withFacts(facts({ ancestors: ['header>main'] })).ok).toBe(false);
    expect(withFacts(facts({ ancestors: [] })).ok).toBe(true);
  });

  it('rejects a styleFacts value that is not an object at all', () => {
    expect(withFacts('display:flex').ok).toBe(false);
    expect(withFacts([]).ok).toBe(false);
  });
});

describe('style facts derived validation', () => {
  // The `derived` block is the Bridge's own verdict (contrast, truncation, font
  // load) rather than something read off computed style. The model is told to
  // quote it rather than recompute it, so a forged or half-shaped verdict has
  // to be refused at the boundary: a wrong `pass` here is a wrong `pass` in
  // the answer.
  function withDerived(derived: unknown) {
    return check(envelope({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: {
        record: record({
          styleFacts: { props: { 'background-color': '#3884ff' }, derived },
        }),
        activeOrder: ['sel-1'],
      },
    }));
  }

  const VERDICT = {
    ratio: 4.54,
    min: 4.5,
    pass: true,
    large: false,
    background: '#3884ff',
  };

  it('accepts a full derived block, and the unmeasurable form', () => {
    expect(withDerived({ contrast: VERDICT, truncated: true, fontLoad: 'fallback' }).ok).toBe(true);
    expect(withDerived({ contrast: { unmeasurable: true } }).ok).toBe(true);
    // Each field is independently optional: the Bridge measures what it can.
    expect(withDerived({ truncated: true }).ok).toBe(true);
    expect(withDerived({ fontLoad: 'unknown' }).ok).toBe(true);
    // `derived` is a subset, like `props` and like the record itself.
    expect(withDerived({ fontLoad: 'fallback' }).ok).toBe(true);
  });

  it('rejects a derived block with an unknown key', () => {
    expect(withDerived({ contrast: VERDICT, computedRatio: 21 }).ok).toBe(false);
    expect(withDerived({ contrast: VERDICT, verdict: 'pass' }).ok).toBe(false);
  });

  it('rejects an empty derived block', () => {
    // An empty object says "measured, found nothing", which is a different
    // claim from sending no block at all.
    expect(withDerived({}).ok).toBe(false);
    expect(withDerived([]).ok).toBe(false);
    expect(withDerived('contrast 4.5 pass').ok).toBe(false);
    expect(withDerived(null).ok).toBe(false);
  });

  it('rejects `truncated: false`, because only `true` is ever sent', () => {
    // Same rule as a default-valued CSS property: the unremarkable state is
    // omitted, so a literal false means the sender is not who it claims.
    expect(withDerived({ truncated: false }).ok).toBe(false);
    expect(withDerived({ truncated: 'yes' }).ok).toBe(false);
    expect(withDerived({ truncated: true }).ok).toBe(true);
  });

  it('rejects a fontLoad other than fallback or unknown', () => {
    expect(withDerived({ fontLoad: 'loaded' }).ok).toBe(false);
    expect(withDerived({ fontLoad: 'error' }).ok).toBe(false);
    expect(withDerived({ fontLoad: true }).ok).toBe(false);
  });

  it('rejects a ratio outside 1..21, or one that is not a number', () => {
    // 1:1 and 21:1 are the arithmetic limits of WCAG 2.x contrast, so nothing
    // outside that range is a measurement.
    expect(withDerived({ contrast: { ...VERDICT, ratio: 0.99 } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, ratio: 21.01 } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, ratio: 0 } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, ratio: '4.54' } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, ratio: Number.NaN } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, ratio: 1 } }).ok).toBe(true);
    expect(withDerived({ contrast: { ...VERDICT, ratio: 21 } }).ok).toBe(true);
  });

  it('rejects a min outside 1..21', () => {
    expect(withDerived({ contrast: { ...VERDICT, min: 0 } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, min: 21.5 } }).ok).toBe(false);
  });

  it('rejects a pass or large flag that is not a boolean', () => {
    expect(withDerived({ contrast: { ...VERDICT, pass: 'true' } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, pass: 1 } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, large: 'false' } }).ok).toBe(false);
  });

  it('rejects a background that is not a six-digit hex colour', () => {
    expect(withDerived({ contrast: { ...VERDICT, background: '#fff' } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, background: 'rgb(56,132,255)' } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, background: 'white' } }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, background: '#3884ff' } }).ok).toBe(true);
  });

  it('rejects a contrast object missing a key or carrying an extra one', () => {
    // The verdict is all-or-nothing: a partial contrast is indistinguishable
    // from one where the model fills the missing field in itself.
    const { min: _min, ...withoutMin } = VERDICT;
    expect(withDerived({ contrast: withoutMin }).ok).toBe(false);
    expect(withDerived({ contrast: { ...VERDICT, foreground: '#1e1e1e' } }).ok).toBe(false);
    // An extra key alongside a fully valid verdict is still refused.
    expect(withDerived({ contrast: { ...VERDICT, note: 'measured by hand' } }).ok).toBe(false);
  });

  it('rejects unmeasurable: false, which is the absence of a verdict', () => {
    expect(withDerived({ contrast: { unmeasurable: false } }).ok).toBe(false);
    expect(withDerived({ contrast: { unmeasurable: 'true' } }).ok).toBe(false);
    expect(withDerived({ contrast: { unmeasurable: true } }).ok).toBe(true);
  });

  it('refuses to let a number ride along with unmeasurable', () => {
    // The whole point of the unmeasurable form is that it stops the model
    // supplying a number. Carrying one makes the record say both.
    expect(withDerived({ contrast: { unmeasurable: true, ratio: 4.54 } }).ok).toBe(false);
    expect(withDerived({ contrast: { unmeasurable: true, ...VERDICT } }).ok).toBe(false);
  });
});

describe('snapshot validation', () => {
  it('accepts a canonical live snapshot', () => {
    const res = check(envelope({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({
        bridgeKind: 'native',
        routeKey: '/checkout',
        routeEpoch: 2,
        capabilities: {
          selectionCrop: true,
          maxSelectionImages: 4,
          maxImageBytes: 524_288,
          maxImageDimension: 1_600,
          maxImagePixels: 2_000_000,
          cssPreview: true,
        },
        selections: [
          record({ anchor: anchor() }),
          record({ selectionId: 'sel-2', elementKey: 'html:id:total', order: 1 }),
        ],
        activeOrder: ['sel-2', 'sel-1'],
      }),
    }));
    expect(res.ok).toBe(true);
  });

  it('accepts an empty canonical snapshot from a v1 Bridge without new fields', () => {
    const res = check(envelope({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({ selections: [], activeOrder: [] }),
    }));
    expect(res.ok).toBe(true);
  });

  it('requires activeOrder to match the snapshot selections exactly', () => {
    for (const over of [
      { activeOrder: [] },
      { activeOrder: ['sel-1', 'sel-9'] },
      { activeOrder: ['sel-1', 'sel-1'] },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_SNAPSHOT',
        payload: snapshotPayload(over),
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('rejects duplicate selection or element identities', () => {
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({
        selections: [record(), record({ order: 1 })],
        activeOrder: ['sel-1'],
      }),
    })).ok).toBe(false);
    expect(check(envelope({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({
        selections: [record(), record({ selectionId: 'sel-2', order: 1 })],
        activeOrder: ['sel-1', 'sel-2'],
      }),
    })).ok).toBe(false);
  });

  it('rejects oversized collections and unsafe snapshot scalars', () => {
    const many = Array.from({ length: 101 }, (_value, index) =>
      record({ selectionId: `sel-${index}`, elementKey: `html:id:e${index}`, order: index }),
    );
    for (const over of [
      { selections: many, activeOrder: many.map((item) => item.selectionId) },
      { selections: [record()], activeOrder: manyItems(101) },
      { inspectorFrozen: 'true' },
      { mode: 'webgl' },
      { connectionId: '' },
      { documentGeneration: oversized(200) },
      { selections: [record({ state: 'inactive' })] },
      { selections: [{ ...record(), elementKey: '' }] },
      { routeEpoch: -1 },
      { routeKey: oversized(512) },
      { capabilities: { selectionCrop: true } },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_SNAPSHOT',
        payload: snapshotPayload(over),
      }));
      expect(res.ok).toBe(false);
    }
  });
});

describe('route and session messages', () => {
  it('accepts session reset acknowledgements and route changes', () => {
    for (const type of ['VERA_INSPECTOR_SESSION_RESET_ACK', 'VERA_INSPECTOR_ROUTE_CHANGED']) {
      expect(check(envelope({ type, payload: { routeKey: '/checkout', routeEpoch: 4 } })).ok).toBe(true);
      expect(check(envelope({ type, payload: { routeKey: '', routeEpoch: 0 } })).ok).toBe(true);
    }
  });

  it('rejects route payloads with missing, negative, or oversized values', () => {
    for (const payload of [
      { routeKey: '/checkout' },
      { routeEpoch: 4 },
      { routeKey: 5, routeEpoch: 4 },
      { routeKey: '/checkout', routeEpoch: -1 },
      { routeKey: '/checkout', routeEpoch: 2 ** 53 },
      { routeKey: '/checkout', routeEpoch: 4.5 },
      { routeKey: oversized(512), routeEpoch: 4 },
    ]) {
      for (const type of ['VERA_INSPECTOR_SESSION_RESET_ACK', 'VERA_INSPECTOR_ROUTE_CHANGED']) {
        expect(check(envelope({ type, payload })).ok).toBe(false);
      }
    }
  });

  it('rejects route messages older than the observed route epoch', () => {
    const ctx: ValidationContext = { ...CONNECTED, expectedRouteEpoch: 5 };
    const stale = check(envelope({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/checkout', routeEpoch: 4 },
    }), ctx);
    expect(stale.reason).toBe('stale-route-epoch');
    expect(check(envelope({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/checkout', routeEpoch: 5 },
    }), ctx).ok).toBe(true);
    expect(check(envelope({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/checkout', routeEpoch: 6 },
    }), ctx).ok).toBe(true);
  });

  it('requires bridge presence to match the envelope identity', () => {
    expect(check(envelope({
      type: 'VERA_INSPECTOR_BRIDGE_PRESENT',
      payload: { bridgeConnectionId: 'c1', documentGeneration: 'd1' },
    })).ok).toBe(true);
    for (const payload of [
      { bridgeConnectionId: 'c2', documentGeneration: 'd1' },
      { bridgeConnectionId: 'c1', documentGeneration: 'd2' },
      { bridgeConnectionId: 'c1' },
      { documentGeneration: 'd1' },
      { bridgeConnectionId: '', documentGeneration: 'd1' },
      { bridgeConnectionId: 'c1', documentGeneration: oversized(200) },
    ]) {
      expect(check(envelope({ type: 'VERA_INSPECTOR_BRIDGE_PRESENT', payload })).ok).toBe(false);
    }
  });
});

describe('preview result validation', () => {
  it('accepts applied, unbound, ambiguous, rejected, undone, reset, and no-op results', () => {
    const results: Array<[string, unknown[]]> = [
      ['applied', [{ elementKey: 'html:testid:cta', status: 'applied', matchCount: 1 }]],
      ['ambiguous', [{ elementKey: 'html:testid:cta', status: 'ambiguous', matchCount: 3 }]],
      ['rejected', [{ elementKey: 'html:testid:cta', status: 'rejected', matchCount: 1 }]],
      ['unbound', [{ elementKey: 'html:testid:cta', status: 'unbound', matchCount: 0 }]],
      ['undone', []],
      ['reset', []],
      ['no-op', []],
    ];
    for (const [status, anchors] of results) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_PREVIEW_RESULT',
        payload: previewResult({ status, anchors }),
      }));
      expect(res.ok).toBe(true);
    }
  });

  it('rejects unknown operations, statuses, and anchor shapes', () => {
    for (const over of [
      { operation: 'reapply' },
      { operation: null },
      { status: 'pending' },
      { status: '' },
      { bindingId: '' },
      { bindingId: oversized(200) },
      { transactionId: oversized(256) },
      { anchors: 'none' },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'applied' }] },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'applied', matchCount: 1, extra: 1 }] },
      { anchors: [{ elementKey: '', status: 'applied', matchCount: 1 }] },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'undone', matchCount: 1 }] },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'applied', matchCount: -1 }] },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'applied', matchCount: 1.5 }] },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'applied', matchCount: 1_001 }] },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'unbound', matchCount: 2 }] },
      { anchors: [{ elementKey: 'html:testid:cta', status: 'applied', matchCount: 0 }] },
      { anchors: [
        { elementKey: 'html:testid:cta', status: 'applied', matchCount: 1 },
        { elementKey: 'html:testid:cta', status: 'applied', matchCount: 1 },
      ] },
      { anchors: Array.from({ length: 13 }, (_value, index) => ({
        elementKey: `html:id:e${index}`,
        status: 'applied',
        matchCount: 1,
      })) },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_PREVIEW_RESULT',
        payload: previewResult(over),
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('requires route identity and rejects stale result epochs', () => {
    for (const over of [
      { routeKey: undefined },
      { routeKey: 9 },
      { routeEpoch: undefined },
      { routeEpoch: -1 },
      { routeEpoch: Number.POSITIVE_INFINITY },
    ]) {
      const res = check(envelope({
        type: 'VERA_INSPECTOR_PREVIEW_RESULT',
        payload: previewResult(over),
      }));
      expect(res.ok).toBe(false);
    }
    const ctx: ValidationContext = { ...CONNECTED, expectedRouteEpoch: 9 };
    expect(check(envelope({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      payload: previewResult({ routeEpoch: 8 }),
    }), ctx).reason).toBe('stale-route-epoch');
    expect(check(envelope({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      payload: previewResult({ routeEpoch: 9 }),
    }), ctx).ok).toBe(true);
  });
});

describe('app command validation', () => {
  it('accepts session reset, preview apply, undo, and reset commands', () => {
    expect(checkApp(envelope({ type: 'VERA_INSPECTOR_SESSION_RESET', payload: {} })).ok).toBe(true);
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_PREVIEW_APPLY',
      payload: previewApply(),
    })).ok).toBe(true);
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_PREVIEW_UNDO',
      payload: { bindingId: 'bind-1', transactionId: 'tx-1' },
    })).ok).toBe(true);
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_PREVIEW_RESET',
      payload: { bindingId: 'bind-1', transactionIds: ['tx-1', 'tx-2'] },
    })).ok).toBe(true);
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_PREVIEW_RESET',
      payload: { bindingId: 'bind-1' },
    })).ok).toBe(true);
  });

  it('accepts a reselect command so an undo can bring the highlight back', () => {
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_RESELECT_SELECTION',
      payload: { selectionId: 'sel-1' },
    })).ok).toBe(true);
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_RESELECT_SELECTION',
      payload: { selectionId: '' },
    })).ok).toBe(false);
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_RESELECT_SELECTION',
      payload: { selectionId: oversized(200) },
    })).ok).toBe(false);
  });

  it('rejects unknown app types, versions, and stale commands', () => {
    expect(checkApp(envelope({ type: 'VERA_INSPECTOR_PREVIEW' })).reason).toBe('unknown-type');
    expect(checkApp(envelope({ protocolVersion: 2 })).reason).toBe('bad-protocol-version');
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_PING',
      connectionId: 'c-old',
    })).reason).toBe('stale-connection');
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_PING',
      sequence: 4,
    }), { expectedConnectionId: 'c1', lastSequence: 4 }).reason).toBe('stale-sequence');
  });

  it('validates legacy app command payloads', () => {
    expect(checkApp(envelope({
      type: 'VERA_INSPECTOR_HELLO',
      payload: { appOrigin: 'http://127.0.0.1:5199' },
    })).ok).toBe(true);
    for (const over of [
      { type: 'VERA_INSPECTOR_HELLO', payload: { appOrigin: 'file:///etc/passwd' } },
      { type: 'VERA_INSPECTOR_HELLO', payload: { appOrigin: '*' } },
      { type: 'VERA_INSPECTOR_HELLO', payload: {} },
      { type: 'VERA_INSPECTOR_FREEZE', payload: { active: 'true' } },
      { type: 'VERA_INSPECTOR_SET_MODE', payload: { mode: 'webgl' } },
      { type: 'VERA_INSPECTOR_CLEAR_SELECTION', payload: { selectionId: '' } },
      { type: 'VERA_INSPECTOR_CAPTURE_SELECTION', payload: { selectionId: oversized(200) } },
      { type: 'VERA_INSPECTOR_CLEAR_ALL', payload: null },
    ]) {
      expect(checkApp(envelope(over)).ok).toBe(false);
    }
  });

  it('rejects unsafe preview apply changes', () => {
    const change = previewApply().changes[0];
    for (const changes of [
      null,
      {},
      [],
      [{ ...change, declarations: {} }],
      [{ ...change, declarations: null }],
      [{ ...change, declarations: { color: 5 } }],
      [{ ...change, declarations: { color: '' } }],
      [{ ...change, declarations: { color: 'red; position: fixed' } }],
      [{ ...change, declarations: { color: 'red}' } }],
      [{ ...change, declarations: { color: 'url(https://evil.test/x.png)' } }],
      [{ ...change, declarations: { color: 'expression(alert(1))' } }],
      [{ ...change, declarations: { color: '</style><script>' } }],
      [{ ...change, target: 1 }],
      [{ ...change, anchor: { ...anchor(), mode: '3d' } }],
      [{ ...change, anchor: { ...anchor(), elementKey: '' } }],
      [{ ...change, anchor: 'html:testid:cta' }],
      [change, { ...change }],
      [change, { ...change, anchor: anchor({ routeKey: '/cart' }) }],
      Array.from({ length: 13 }, (_value, index) => ({
        ...change,
        anchor: anchor({ elementKey: `html:id:e${index}` }),
      })),
    ]) {
      const res = checkApp(envelope({
        type: 'VERA_INSPECTOR_PREVIEW_APPLY',
        payload: previewApply({ changes }),
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('rejects oversized and prototype-polluting declarations', () => {
    const manyProperties: Record<string, string> = {};
    for (let index = 0; index < 13; index += 1) manyProperties[`margin-top-${index}`] = '1px';
    const oversizedProperty = { ['a'.repeat(65)]: '1px' };
    const oversizedValue = { color: 'a'.repeat(121) };
    const protoPolluted = JSON.parse('{"__proto__":{"color":"red"}}') as unknown;
    for (const declarations of [manyProperties, oversizedProperty, oversizedValue, protoPolluted]) {
      const res = checkApp(envelope({
        type: 'VERA_INSPECTOR_PREVIEW_APPLY',
        payload: previewApply({ changes: [{ anchor: anchor(), declarations }] }),
      }));
      expect(res.ok).toBe(false);
    }
  });

  it('accepts bounded multi-property visual declarations', () => {
    const res = checkApp(envelope({
      type: 'VERA_INSPECTOR_PREVIEW_APPLY',
      payload: previewApply({
        changes: [
          {
            anchor: anchor(),
            declarations: {
              'background-color': 'rgba(14, 165, 233, 0.5)',
              'border-top-color': 'hsl(200 90% 50%)',
              width: 'calc(100% - 2px)',
            },
          },
          { anchor: anchor({ elementKey: 'html:id:total' }), declarations: { opacity: '0.75' } },
        ],
      }),
    }));
    expect(res.ok).toBe(true);
  });

  it('rejects unsafe preview undo and reset targeting', () => {
    for (const over of [
      { transactionId: '' },
      { transactionId: oversized(256) },
      { transactionIds: 'tx-1' },
      { transactionIds: [''] },
      { transactionIds: ['tx-1', 'tx-1'] },
      { transactionIds: manyItems(65) },
      { transactionIds: [oversized(256)] },
      { bindingId: '' },
      { bindingId: oversized(200) },
      { bindingId: 7 },
    ]) {
      for (const type of ['VERA_INSPECTOR_PREVIEW_UNDO', 'VERA_INSPECTOR_PREVIEW_RESET']) {
        expect(checkApp(envelope({ type, payload: { bindingId: 'bind-1', ...over } })).ok).toBe(false);
      }
    }
  });
});

describe('trust helpers', () => {
  it('derives exact target origins, rejecting non-http', () => {
    expect(targetOriginFor('http://localhost:3000/a?b=1#c')).toBe('http://localhost:3000');
    expect(targetOriginFor('not a url')).toBeNull();
    expect(targetOriginFor('file:///etc/passwd')).toBeNull();
  });

  it('checks event.source against the live iframe window', () => {
    const w = {};
    expect(isExpectedSource(w, w)).toBe(true);
    expect(isExpectedSource({}, w)).toBe(false);
    expect(isExpectedSource(null, w)).toBe(false);
  });
});

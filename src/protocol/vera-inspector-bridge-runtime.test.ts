import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initVeraInspectorBridge } from '../../bridge/vera-inspector-bridge.ts';
import { validateBridgeMessage } from './validate.ts';
import type { ValidationContext } from './validate.ts';

const APP_ORIGIN = 'http://app.test';
const PREVIEW_ATTRIBUTE_PREFIX = 'data-vera-inspector-pv-';

interface BridgeMessage {
  type: string;
  requestId: string;
  sequence: number;
  connectionId: string;
  documentGeneration: string;
  payload: Record<string, unknown>;
}

type PreviewChangeInput = Record<string, unknown>;

interface Harness {
  bridge: ReturnType<typeof initVeraInspectorBridge>;
  nativePushState: History['pushState'];
  nativeReplaceState: History['replaceState'];
  sent: () => BridgeMessage[];
  typed: (type: string) => BridgeMessage[];
  dispatch: (type: string, payload: Record<string, unknown>, requestId: string) => void;
  hello: () => void;
  freeze: (active: boolean, requestId?: string) => void;
  apply: (bindingId: string, transactionId: string, changes: PreviewChangeInput[], requestId?: string) => BridgeMessage[];
  undo: (bindingId: string, transactionId: string, requestId?: string) => BridgeMessage[];
  reset: (bindingId: string, transactionIds?: string[], requestId?: string) => BridgeMessage[];
  mark: (element: Element, selectionId?: unknown) => void;
  contractFailures: () => string[];
}

let requestCounter = 0;
let liveHarnesses: Harness[] = [];

function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

function currentRouteKey(): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function createHarness(options: { styleNonce?: string } = {}): Harness {
  const postMessage = vi.spyOn(window.parent, 'postMessage');
  const nativePushState = window.history.pushState;
  const nativeReplaceState = window.history.replaceState;
  const bridge = initVeraInspectorBridge({ appOrigin: APP_ORIGIN, ...options });
  let connectionId = '';
  let documentGeneration = '';
  let sequence = 0;
  const sent = (): BridgeMessage[] => postMessage.mock.calls.map((call) => call[0] as BridgeMessage);
  const typed = (type: string): BridgeMessage[] => sent().filter((message) => message.type === type);
  const dispatch = (type: string, payload: Record<string, unknown>, requestId: string): void => {
    sequence += 1;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          protocolVersion: 1,
          type,
          connectionId,
          documentGeneration,
          requestId,
          sequence,
          payload,
        },
        origin: APP_ORIGIN,
        source: window.parent,
      }),
    );
  };
  const harness: Harness = {
    bridge,
    nativePushState,
    nativeReplaceState,
    sent,
    typed,
    dispatch,
    hello() {
      const requestId = nextRequestId('hello');
      dispatch('VERA_INSPECTOR_HELLO', {}, requestId);
      const ack = sent().find(
        (message) => message.type === 'VERA_INSPECTOR_HELLO_ACK' && message.requestId === requestId,
      );
      if (ack === undefined) throw new Error('handshake failed');
      connectionId = ack.connectionId;
      documentGeneration = ack.documentGeneration;
    },
    freeze(active, requestId = nextRequestId('freeze')) {
      dispatch('VERA_INSPECTOR_FREEZE', { active }, requestId);
    },
    apply(bindingId, transactionId, changes, requestId = nextRequestId('apply')) {
      dispatch('VERA_INSPECTOR_PREVIEW_APPLY', { bindingId, transactionId, changes }, requestId);
      return sent().filter(
        (message) => message.type === 'VERA_INSPECTOR_PREVIEW_RESULT' && message.requestId === requestId,
      );
    },
    undo(bindingId, transactionId, requestId = nextRequestId('undo')) {
      dispatch('VERA_INSPECTOR_PREVIEW_UNDO', { bindingId, transactionId }, requestId);
      return sent().filter(
        (message) => message.type === 'VERA_INSPECTOR_PREVIEW_RESULT' && message.requestId === requestId,
      );
    },
    reset(bindingId, transactionIds, requestId = nextRequestId('reset')) {
      const payload: Record<string, unknown> = { bindingId };
      if (transactionIds !== undefined) payload['transactionIds'] = transactionIds;
      dispatch('VERA_INSPECTOR_PREVIEW_RESET', payload, requestId);
      return sent().filter(
        (message) => message.type === 'VERA_INSPECTOR_PREVIEW_RESULT' && message.requestId === requestId,
      );
    },
    mark(element) {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
    contractFailures() {
      const failures: string[] = [];
      let lastSequence = 0;
      for (const message of sent()) {
        const ctx: ValidationContext = {
          expectedConnectionId: connectionId === '' ? null : connectionId,
          expectedDocumentGeneration: documentGeneration === '' ? null : documentGeneration,
          lastSequence,
          expectedRouteEpoch: null,
        };
        const result = validateBridgeMessage(message, ctx);
        if (result.ok) lastSequence = message.sequence;
        else failures.push(`${message.type}#${message.sequence}:${result.reason ?? 'unknown'}`);
      }
      return failures;
    },
  };
  liveHarnesses.push(harness);
  return harness;
}

function mountElement(testId: string, tag = 'div'): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute('data-testid', testId);
  document.body.appendChild(element);
  return element;
}

function testIdAnchor(testId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    elementKey: `html:testid:${testId}`,
    routeKey: currentRouteKey(),
    mode: 'html',
    tagName: 'div',
    id: '',
    testId,
    path: '',
    ...overrides,
  };
}

function previewStyleLayers(): HTMLStyleElement[] {
  return [...document.querySelectorAll('style[data-vera-inspector="preview-layer"]')] as HTMLStyleElement[];
}

function previewAttributes(element: Element): string[] {
  return [...element.attributes]
    .map((attribute) => attribute.name)
    .filter((name) => name.startsWith(PREVIEW_ATTRIBUTE_PREFIX));
}

function markedElements(): Element[] {
  return [...document.querySelectorAll('*')].filter((element) => previewAttributes(element).length > 0);
}

function selectorOf(cssText: string): string {
  const index = cssText.indexOf('{');
  return index < 0 ? cssText : cssText.slice(0, index);
}

function selectorRepetitions(selector: string): number {
  return (selector.match(/\[data-vera-inspector-pv-/g) ?? []).length;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  for (const harness of liveHarnesses) {
    try {
      harness.bridge.destroy();
    } catch {
      liveHarnesses = [];
    }
  }
  liveHarnesses = [];
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.head.querySelectorAll('[data-vera-inspector]').forEach((node) => node.remove());
  window.history.replaceState({}, '', '/');
});

describe('bridge presence', () => {
  it('emits a bridge present hint with the initial route', () => {
    const harness = createHarness();
    const present = harness.typed('VERA_INSPECTOR_BRIDGE_PRESENT');
    expect(present).toHaveLength(1);
    expect(present[0]?.payload).toMatchObject({ routeKey: '/', routeEpoch: 0 });
    expect(present[0]?.payload['bridgeConnectionId']).toBe(harness.bridge.connectionId);
    expect(present[0]?.payload['documentGeneration']).toBe(harness.bridge.documentGeneration);
    expect(present[0]?.payload['capabilities']).toMatchObject({
      cssPreview: true,
      maxPreviewChanges: 12,
      maxPreviewPropertiesPerChange: 12,
      maxPreviewValueLength: 120,
    });
  });

  it('reports the route identity in the handshake ack', () => {
    const harness = createHarness();
    harness.hello();
    const acks = harness.typed('VERA_INSPECTOR_HELLO_ACK');
    const ack = acks.find((message) => message.requestId !== '');
    expect(ack?.payload).toMatchObject({ routeKey: '/', routeEpoch: 0 });
    expect(ack?.payload['bridgeConnectionId']).toBe(harness.bridge.connectionId);
  });
});

describe('selection anchors', () => {
  it('emits a usable anchor for html selections', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('anchor-target', 'section');
    target.setAttribute('id', 'anchor-card');
    harness.freeze(true);
    harness.mark(target);
    const selection = harness.typed('VERA_INSPECTOR_SELECTION').at(-1);
    const record = selection?.payload['record'] as Record<string, unknown> | undefined;
    const anchor = record?.['anchor'] as Record<string, unknown> | undefined;
    expect(anchor).toMatchObject({
      elementKey: 'html:testid:anchor-target',
      routeKey: '/',
      mode: 'html',
      tagName: 'section',
      id: 'anchor-card',
      testId: 'anchor-target',
    });
    expect(typeof anchor?.['path']).toBe('string');
    expect(anchor?.['elementKey']).toBe(record?.['elementKey']);
    harness.dispatch('VERA_INSPECTOR_REQUEST_SNAPSHOT', {}, nextRequestId('snapshot'));
    const snapshot = harness
      .typed('VERA_INSPECTOR_SNAPSHOT')
      .at(-1)
      ?.payload['selections'] as Array<Record<string, unknown>>;
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.['anchor']).toMatchObject({ elementKey: 'html:testid:anchor-target' });
  });
});

describe('protocol contract', () => {
  it('emits only messages the app side accepts across a full session', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('contract-target');
    harness.freeze(true);
    harness.mark(target);
    harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('contract-target'), declarations: { color: 'red' } },
    ]);
    harness.apply('bind-1', 'tx-2', [
      { anchor: testIdAnchor('contract-target'), declarations: { 'font-size': '20px' } },
    ]);
    harness.apply('bind-1', 'tx-bad', [
      { anchor: testIdAnchor('contract-target'), declarations: { position: 'fixed' } },
    ]);
    harness.apply('bind-1', 'tx-missing', [
      { anchor: testIdAnchor('contract-absent'), declarations: { color: 'red' } },
    ]);
    harness.undo('bind-1', 'tx-2');
    harness.reset('bind-1');
    window.history.pushState({}, '', '/contract-route');
    harness.dispatch('VERA_INSPECTOR_SESSION_RESET', {}, nextRequestId('contract-reset'));
    harness.dispatch('VERA_INSPECTOR_PING', {}, nextRequestId('contract-ping'));
    expect(harness.contractFailures()).toEqual([]);
  });
});

describe('reselect selection', () => {
  function selectAndRead(harness: Harness, element: HTMLElement): string {
    harness.freeze(true);
    harness.mark(element);
    const record = harness.typed('VERA_INSPECTOR_SELECTION').at(-1)?.payload['record'] as
      | Record<string, unknown>
      | undefined;
    const selectionId = record?.['selectionId'];
    if (typeof selectionId !== 'string') throw new Error('no selection was recorded');
    return selectionId;
  }

  function snapshotOf(harness: Harness, requestId: string): Record<string, unknown> {
    harness.dispatch('VERA_INSPECTOR_REQUEST_SNAPSHOT', {}, requestId);
    const message = harness
      .typed('VERA_INSPECTOR_SNAPSHOT')
      .at(-1);
    if (!message || message.requestId !== requestId) throw new Error('snapshot did not correlate');
    return message.payload as Record<string, unknown>;
  }

  it('re-activates a deselected record under the same id', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('reselect-target');
    const selectionId = selectAndRead(harness, target);
    expect(harness.bridge.getState().activeCount).toBe(1);

    const clearId = nextRequestId('clear');
    harness.dispatch('VERA_INSPECTOR_CLEAR_SELECTION', { selectionId }, clearId);
    expect(harness.bridge.getState().activeCount).toBe(0);
    expect(snapshotOf(harness, clearId)['selections']).toEqual([]);

    const reselectId = nextRequestId('reselect');
    harness.dispatch('VERA_INSPECTOR_RESELECT_SELECTION', { selectionId }, reselectId);
    expect(harness.bridge.getState().activeCount).toBe(1);

    const snapshot = snapshotOf(harness, reselectId);
    const selections = snapshot['selections'] as Array<Record<string, unknown>>;
    expect(selections).toHaveLength(1);
    // Same id, so the citation numbering the composer already wrote is stable.
    expect(selections[0]?.['selectionId']).toBe(selectionId);
    expect(selections[0]?.['state']).toBe('active');
    expect(snapshot['activeOrder']).toEqual([selectionId]);
  });

  it('leaves an unknown id alone', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('reselect-unknown');
    selectAndRead(harness, target);

    harness.dispatch(
      'VERA_INSPECTOR_RESELECT_SELECTION',
      { selectionId: 'sel-does-not-exist' },
      nextRequestId('reselect-missing'),
    );

    expect(harness.bridge.getState().activeCount).toBe(1);
  });

  it('refuses to re-activate a record whose element left the page', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('reselect-detached');
    const selectionId = selectAndRead(harness, target);
    harness.dispatch(
      'VERA_INSPECTOR_CLEAR_SELECTION',
      { selectionId },
      nextRequestId('clear-detached'),
    );
    target.remove();

    const reselectId = nextRequestId('reselect-detached');
    harness.dispatch('VERA_INSPECTOR_RESELECT_SELECTION', { selectionId }, reselectId);

    // An active selection with nothing to outline would be a lie.
    expect(harness.bridge.getState().activeCount).toBe(0);
    expect(snapshotOf(harness, reselectId)['selections']).toEqual([]);
  });
});

describe('session reset', () => {
  it('clears live selection, capture, preview and hover state and returns a fresh snapshot', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('reset-target');
    harness.freeze(true);
    harness.mark(target);
    expect(harness.bridge.getState().activeCount).toBe(1);
    const applied = harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('reset-target'), declarations: { color: 'red' } },
    ]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.payload['status']).toBe('applied');
    expect(previewStyleLayers()).toHaveLength(1);

    const requestId = nextRequestId('session-reset');
    harness.dispatch('VERA_INSPECTOR_SESSION_RESET', {}, requestId);

    const acks = harness.typed('VERA_INSPECTOR_SESSION_RESET_ACK').filter((message) => message.requestId === requestId);
    expect(acks).toHaveLength(1);
    expect(acks[0]?.payload).toMatchObject({ routeKey: '/', routeEpoch: 0 });
    const snapshots = harness
      .typed('VERA_INSPECTOR_SNAPSHOT')
      .filter((message) => message.requestId === requestId);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.payload['selections']).toEqual([]);
    expect(snapshots[0]?.payload['activeOrder']).toEqual([]);
    expect(snapshots[0]?.payload['inspectorFrozen']).toBe(false);
    expect(harness.bridge.getState()).toMatchObject({ activeCount: 0, previewLayerCount: 0 });
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);
    expect(markedElements()).toEqual([]);
  });

  it('is idempotent across repeated resets', () => {
    const harness = createHarness();
    harness.hello();
    mountElement('reset-idem');
    const first = nextRequestId('session-reset');
    const second = nextRequestId('session-reset');
    harness.dispatch('VERA_INSPECTOR_SESSION_RESET', {}, first);
    harness.dispatch('VERA_INSPECTOR_SESSION_RESET', {}, second);
    expect(harness.typed('VERA_INSPECTOR_SESSION_RESET_ACK').filter((message) => message.requestId === first)).toHaveLength(1);
    expect(harness.typed('VERA_INSPECTOR_SESSION_RESET_ACK').filter((message) => message.requestId === second)).toHaveLength(1);
    expect(
      harness.typed('VERA_INSPECTOR_SNAPSHOT').filter((message) => message.requestId === second),
    ).toHaveLength(1);
    expect(harness.typed('VERA_INSPECTOR_PREVIEW_RESULT')).toHaveLength(0);
  });
});

describe('route tracking', () => {
  it('invalidates live state, interception and preview layers on route change', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('route-target');
    harness.freeze(true);
    harness.mark(target);
    harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('route-target'), declarations: { color: 'red' } },
    ]);

    window.history.pushState({}, '', '/checkout?step=2#pay');

    const changed = harness.typed('VERA_INSPECTOR_ROUTE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toMatchObject({ routeKey: '/checkout?step=2#pay', routeEpoch: 1 });
    const snapshot = harness.typed('VERA_INSPECTOR_SNAPSHOT').at(-1);
    expect(snapshot?.payload).toMatchObject({ routeKey: '/checkout?step=2#pay', routeEpoch: 1 });
    expect(snapshot?.payload['selections']).toEqual([]);
    expect(snapshot?.payload['inspectorFrozen']).toBe(false);
    expect(harness.bridge.getState()).toMatchObject({ activeCount: 0, previewLayerCount: 0 });
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);

    const later = mountElement('route-target-two');
    harness.mark(later);
    expect(harness.bridge.getState().activeCount).toBe(0);
  });

  it('reports replaceState route changes and ignores unchanged routes', () => {
    const harness = createHarness();
    harness.hello();
    window.history.replaceState({}, '', '/replaced');
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')).toHaveLength(1);
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')[0]?.payload).toMatchObject({
      routeKey: '/replaced',
      routeEpoch: 1,
    });
    window.history.replaceState({}, '', '/replaced');
    harness.freeze(false);
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')).toHaveLength(1);
  });

  it('tracks popstate and hashchange navigation', () => {
    const harness = createHarness();
    harness.hello();
    harness.nativePushState.call(window.history, {}, '', '/from-popstate');
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')).toHaveLength(1);
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')[0]?.payload).toMatchObject({
      routeKey: '/from-popstate',
      routeEpoch: 1,
    });
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')).toHaveLength(1);

    harness.nativeReplaceState.call(window.history, {}, '', '/from-popstate#anchor');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')).toHaveLength(2);
    expect(harness.typed('VERA_INSPECTOR_ROUTE_CHANGED')[1]?.payload).toMatchObject({
      routeKey: '/from-popstate#anchor',
      routeEpoch: 2,
    });
  });

  it('refuses weak preview anchors from another route', () => {
    const harness = createHarness();
    harness.hello();
    mountElement('stale-anchor');
    const results = harness.apply('bind-1', 'tx-stale', [
      {
        anchor: testIdAnchor('stale-anchor', { routeKey: '/somewhere-else', testId: '', id: '' }),
        declarations: { color: 'red' },
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({ status: 'unbound' });
    expect(previewStyleLayers()).toHaveLength(0);
    expect(markedElements()).toEqual([]);
  });

  it('rebinds a unique strong anchor across routes', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('portable-anchor');
    harness.nativePushState.call(window.history, {}, '', '/next-route');
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    const results = harness.apply('bind-1', 'tx-portable', [
      {
        anchor: testIdAnchor('portable-anchor', { routeKey: '/' }),
        declarations: { color: 'red' },
      },
    ]);
    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    expect(previewStyleLayers()).toHaveLength(1);
    expect(target.getAttribute('style')).toBeNull();
  });
});

describe('preview apply', () => {
  it('applies one style layer per transaction using a bridge generated selector', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('apply-target');
    target.setAttribute('class', 'card');

    const results = harness.apply('bind-1', 'tx-1', [
      {
        anchor: testIdAnchor('apply-target'),
        declarations: { color: 'rgb(10, 20, 30)', 'font-size': '18px' },
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({
      bindingId: 'bind-1',
      transactionId: 'tx-1',
      operation: 'apply',
      status: 'applied',
      routeKey: '/',
      routeEpoch: 0,
    });
    expect(results[0]?.payload['anchors']).toEqual([
      { elementKey: 'html:testid:apply-target', status: 'applied', matchCount: 1 },
    ]);

    const layers = previewStyleLayers();
    expect(layers).toHaveLength(1);
    const cssText = layers[0]?.textContent ?? '';
    expect(cssText).toContain('color:rgb(10, 20, 30)');
    expect(cssText).toContain('font-size:18px');
    const selector = selectorOf(cssText);
    expect(selector).toMatch(/^(\[data-vera-inspector-pv-[a-z0-9]+="[a-z0-9-]+"\]){3,}$/);
    expect(selector).not.toContain('card');
    expect(selector).not.toContain('apply-target');
    expect(selector).not.toContain('data-testid');
    const attributes = previewAttributes(target);
    expect(attributes).toHaveLength(1);
    expect(cssText).toContain(`${attributes[0]}="${target.getAttribute(attributes[0] ?? '')}"`);
  });

  it('uses a nonce aware style element when a nonce is provided', () => {
    const harness = createHarness({ styleNonce: 'n0nce-value' });
    harness.hello();
    mountElement('nonce-target');
    const results = harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('nonce-target'), declarations: { color: 'red' } },
    ]);
    expect(results[0]?.payload['status']).toBe('applied');
    const layers = previewStyleLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0]?.getAttribute('nonce')).toBe('n0nce-value');
    const policies = [...document.querySelectorAll('meta[http-equiv]')].map(
      (meta) => meta.getAttribute('content') ?? '',
    );
    expect(policies.some((policy) => policy.includes('unsafe-inline'))).toBe(false);
  });

  it('resolves an anchor through the active selection target first', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('selected-target');
    harness.freeze(true);
    harness.mark(target);
    const results = harness.apply('bind-1', 'tx-1', [
      {
        anchor: testIdAnchor('selected-target', { tagName: 'span', testId: 'stale-hint' }),
        declarations: { color: 'red' },
      },
    ]);
    expect(results[0]?.payload['status']).toBe('applied');
    expect(previewAttributes(target)).toHaveLength(1);
  });

  it('rejects non visual or malformed declarations without mutating the document', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('invalid-target');
    const rejectedDeclarations: PreviewChangeInput[] = [
      { position: 'absolute' },
      { display: 'none' },
      { 'z-index': '5' },
      { color: 'red;' },
      { color: 'red}body{display:none' },
      { '--custom-property': 'red' },
      { width: 'calc(100% - 10px)' },
      { color: 'url(javascript:alert(1))' },
      { 'background-image': 'linear-gradient(red, blue)' },
      { color: 42 },
      { width: '' },
    ];
    for (const declarations of rejectedDeclarations) {
      const results = harness.apply('bind-1', 'tx-invalid', [
        { anchor: testIdAnchor('invalid-target'), declarations },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]?.payload['status']).toBe('rejected');
      expect(previewStyleLayers()).toHaveLength(0);
      expect(markedElements()).toEqual([]);
    }
    expect(previewAttributes(target)).toEqual([]);
  });

  it('rejects malformed payloads and never mutates', () => {
    const harness = createHarness();
    harness.hello();
    mountElement('payload-target');
    const rejectedResults = [
      harness.apply('bind-1', 'tx-1', []).length,
      harness.apply('bind-1', 'tx-1', [
        { declarations: { color: 'red' } },
      ]).length,
      harness.apply('bind-1', 'tx-1', [
        { anchor: { mode: 'html', elementKey: '', routeKey: '/', tagName: 'div', id: '', testId: '', path: '' }, declarations: { color: 'red' } },
      ]).length,
      harness.apply('bind-1', 'tx-1', [
        { anchor: testIdAnchor('payload-target'), declarations: { color: 'red' }, extra: 1 },
      ]).length,
    ];
    expect(rejectedResults).toEqual([1, 1, 1, 1]);
    expect(
      harness.typed('VERA_INSPECTOR_PREVIEW_RESULT').every((message) => message.payload['status'] === 'rejected'),
    ).toBe(true);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(markedElements()).toEqual([]);
  });

  it('reports a protocol error for commands without usable identities', () => {
    const harness = createHarness();
    harness.hello();
    mountElement('identity-target');
    const missingBinding = harness.apply('', 'tx-1', [
      { anchor: testIdAnchor('identity-target'), declarations: { color: 'red' } },
    ]);
    const missingTransaction = harness.apply('bind-1', '', [
      { anchor: testIdAnchor('identity-target'), declarations: { color: 'red' } },
    ]);
    expect(missingBinding).toHaveLength(0);
    expect(missingTransaction).toHaveLength(0);
    const errors = harness.typed('VERA_INSPECTOR_ERROR');
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.payload['code'] === 'invalid-preview-command')).toBe(true);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(markedElements()).toEqual([]);
  });

  it('reports unbound anchors without mutation', () => {
    const harness = createHarness();
    harness.hello();
    mountElement('present-target');
    const results = harness.apply('bind-1', 'tx-missing', [
      { anchor: testIdAnchor('absent-target'), declarations: { color: 'red' } },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({ status: 'unbound' });
    expect(results[0]?.payload['anchors']).toEqual([
      { elementKey: 'html:testid:absent-target', status: 'unbound', matchCount: 0 },
    ]);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(markedElements()).toEqual([]);
  });

  it('reports ambiguous anchors and never picks one of several matches', () => {
    const harness = createHarness();
    harness.hello();
    const first = mountElement('duplicate-target');
    const second = mountElement('duplicate-target');
    const results = harness.apply('bind-1', 'tx-ambiguous', [
      { anchor: testIdAnchor('duplicate-target'), declarations: { color: 'red' } },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({ status: 'ambiguous' });
    expect(results[0]?.payload['anchors']).toEqual([
      { elementKey: 'html:testid:duplicate-target', status: 'ambiguous', matchCount: 2 },
    ]);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(first)).toEqual([]);
    expect(previewAttributes(second)).toEqual([]);
  });

  it('sends exactly one correlated result when a later change is unbound', () => {
    const harness = createHarness();
    harness.hello();
    mountElement('mixed-present');
    const requestId = nextRequestId('mixed');
    const results = harness.apply(
      'bind-1',
      'tx-mixed',
      [
        { anchor: testIdAnchor('mixed-present'), declarations: { color: 'red' } },
        { anchor: testIdAnchor('mixed-absent'), declarations: { color: 'blue' } },
      ],
      requestId,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.requestId).toBe(requestId);
    expect(results[0]?.payload['status']).toBe('unbound');
    expect(results[0]?.payload['anchors']).toEqual([
      { elementKey: 'html:testid:mixed-present', status: 'rejected', matchCount: 1 },
      { elementKey: 'html:testid:mixed-absent', status: 'unbound', matchCount: 0 },
    ]);
    expect(harness.typed('VERA_INSPECTOR_PREVIEW_RESULT')).toHaveLength(1);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(markedElements()).toEqual([]);
  });
});

describe('preview transaction isolation', () => {
  it('lets the newest transaction win for overlapping properties', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('overlap-target');
    harness.apply('bind-1', 'tx-old', [
      { anchor: testIdAnchor('overlap-target'), declarations: { color: 'red' } },
    ]);
    harness.apply('bind-1', 'tx-new', [
      { anchor: testIdAnchor('overlap-target'), declarations: { color: 'blue' } },
    ]);

    const layers = previewStyleLayers();
    expect(layers).toHaveLength(2);
    const olderSelector = selectorOf(layers[0]?.textContent ?? '');
    const newerSelector = selectorOf(layers[1]?.textContent ?? '');
    expect(newerSelector).not.toBe(olderSelector);
    expect(selectorRepetitions(newerSelector)).toBeGreaterThan(selectorRepetitions(olderSelector));
    expect(previewAttributes(target)).toHaveLength(2);

    const undone = harness.undo('bind-1', 'tx-new');
    expect(undone).toHaveLength(1);
    expect(undone[0]?.payload).toMatchObject({ operation: 'undo', status: 'undone' });
    expect(undone[0]?.payload['anchors']).toEqual([]);
    const remaining = previewStyleLayers();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('color:red');
    expect(previewAttributes(target)).toHaveLength(1);
  });

  it('removes exactly one transaction on undo and stays idempotent', () => {
    const harness = createHarness();
    harness.hello();
    const first = mountElement('undo-one');
    const second = mountElement('undo-two');
    harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('undo-one'), declarations: { color: 'red' } },
    ]);
    harness.apply('bind-1', 'tx-2', [
      { anchor: testIdAnchor('undo-two'), declarations: { color: 'blue' } },
    ]);
    expect(previewStyleLayers()).toHaveLength(2);

    const undone = harness.undo('bind-1', 'tx-1');
    expect(undone[0]?.payload['status']).toBe('undone');
    expect(previewStyleLayers()).toHaveLength(1);
    expect(previewAttributes(first)).toEqual([]);
    expect(previewAttributes(second)).toHaveLength(1);
    expect(previewStyleLayers()[0]?.textContent).toContain('color:blue');

    const repeated = harness.undo('bind-1', 'tx-1');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.payload).toMatchObject({ status: 'no-op' });
    expect(repeated[0]?.payload['anchors']).toEqual([]);
    expect(previewStyleLayers()).toHaveLength(1);
  });

  it('replaces the layer when the same transaction is applied twice', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('reapply-target');
    harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('reapply-target'), declarations: { color: 'red' } },
    ]);
    const firstAttribute = previewAttributes(target)[0];
    const results = harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('reapply-target'), declarations: { color: 'blue' } },
    ]);
    expect(results[0]?.payload['status']).toBe('applied');
    const layers = previewStyleLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0]?.textContent).toContain('color:blue');
    const attributes = previewAttributes(target);
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).not.toBe(firstAttribute);
  });

  it('resets only the requested binding transactions', () => {
    const harness = createHarness();
    harness.hello();
    const first = mountElement('reset-a');
    const second = mountElement('reset-b');
    const third = mountElement('reset-c');
    harness.apply('bind-a', 'tx-a1', [
      { anchor: testIdAnchor('reset-a'), declarations: { color: 'red' } },
    ]);
    harness.apply('bind-a', 'tx-a2', [
      { anchor: testIdAnchor('reset-b'), declarations: { color: 'blue' } },
    ]);
    harness.apply('bind-b', 'tx-b1', [
      { anchor: testIdAnchor('reset-c'), declarations: { color: 'green' } },
    ]);
    expect(previewStyleLayers()).toHaveLength(3);

    const results = harness.reset('bind-a');
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({
      bindingId: 'bind-a',
      operation: 'reset',
      status: 'reset',
      routeKey: '/',
      routeEpoch: 0,
    });
    expect(results[0]?.payload['anchors']).toEqual([]);
    expect(results[0]?.payload['transactionId']).not.toBe('');
    const remaining = previewStyleLayers();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('color:green');
    expect(previewAttributes(first)).toEqual([]);
    expect(previewAttributes(second)).toEqual([]);
    expect(previewAttributes(third)).toHaveLength(1);
  });

  it('resets an explicit transaction subset', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('reset-subset');
    harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('reset-subset'), declarations: { color: 'red' } },
    ]);
    harness.apply('bind-1', 'tx-2', [
      { anchor: testIdAnchor('reset-subset'), declarations: { color: 'blue' } },
    ]);
    const results = harness.reset('bind-1', ['tx-1']);
    expect(results[0]?.payload['status']).toBe('reset');
    const remaining = previewStyleLayers();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('color:blue');
    expect(previewAttributes(target)).toHaveLength(1);

    const rejected = harness.reset('bind-1', ['tx-2', 7 as unknown as string]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload['status']).toBe('rejected');
    expect(previewStyleLayers()).toHaveLength(1);

    const emptied = harness.reset('bind-1');
    expect(emptied[0]?.payload['status']).toBe('reset');
    const unknown = harness.reset('bind-1', ['tx-never-applied']);
    expect(unknown[0]?.payload).toMatchObject({ status: 'no-op', transactionId: 'tx-never-applied' });
    expect(unknown[0]?.payload['anchors']).toEqual([]);
    expect(previewStyleLayers()).toHaveLength(0);
  });
});

describe('bridge destroy', () => {
  it('removes history patches, listeners, style layers, attributes and the singleton', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('destroy-target');
    harness.freeze(true);
    harness.mark(target);
    harness.apply('bind-1', 'tx-1', [
      { anchor: testIdAnchor('destroy-target'), declarations: { color: 'red' } },
    ]);
    expect(window.history.pushState).not.toBe(harness.nativePushState);
    expect(window.history.replaceState).not.toBe(harness.nativeReplaceState);

    harness.bridge.destroy();

    expect(window.history.pushState).toBe(harness.nativePushState);
    expect(window.history.replaceState).toBe(harness.nativeReplaceState);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);
    expect(markedElements()).toEqual([]);
    expect(document.querySelector('[data-vera-inspector="overlay-host"]')).toBeNull();
    expect(
      (window as typeof window & { __DESIGN_INSPECTOR_BRIDGE__?: unknown }).__DESIGN_INSPECTOR_BRIDGE__,
    ).toBeUndefined();

    const before = harness.sent().length;
    harness.dispatch('VERA_INSPECTOR_SESSION_RESET', {}, nextRequestId('after-destroy'));
    harness.dispatch('VERA_INSPECTOR_PREVIEW_APPLY', {
      bindingId: 'bind-1',
      transactionId: 'tx-2',
      changes: [{ anchor: testIdAnchor('destroy-target'), declarations: { color: 'red' } }],
    }, nextRequestId('after-destroy-apply'));
    window.history.pushState({}, '', '/after-destroy');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(harness.sent()).toHaveLength(before);
    expect(previewStyleLayers()).toHaveLength(0);
  });

  it('replaces a previous singleton without leaking its listeners or patches', () => {
    const first = createHarness();
    first.hello();
    const second = createHarness();
    second.hello();
    expect(window.history.pushState).not.toBe(second.nativePushState);
    window.history.pushState({}, '', '/singleton');
    const changed = second.typed('VERA_INSPECTOR_ROUTE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.connectionId).toBe(second.bridge.connectionId);
    const pingId = nextRequestId('ping');
    second.dispatch('VERA_INSPECTOR_PING', {}, pingId);
    expect(
      second.typed('VERA_INSPECTOR_PONG').filter((message) => message.requestId === pingId),
    ).toHaveLength(1);
    expect(
      second.typed('VERA_INSPECTOR_SNAPSHOT').filter(
        (message) => message.connectionId === first.bridge.connectionId,
      ),
    ).toEqual([]);
  });
});

describe('style facts on the wire', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits facts the app-side validator accepts', () => {
    // jsdom returns '' for most longhands, so a fixture is required or this
    // asserts nothing.
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (property: string) =>
            ({
              color: 'rgb(30, 30, 30)',
              'background-color': 'rgb(56, 132, 255)',
              'font-family': 'Pretendard',
              'font-size': '14px',
              'padding-top': '12px',
              'padding-right': '16px',
              'padding-bottom': '12px',
              'padding-left': '16px',
              display: 'inline-flex',
            })[property] ?? '',
        }) as unknown as CSSStyleDeclaration,
    );
    const harness = createHarness();
    harness.hello();
    harness.freeze(true);
    harness.mark(mountElement('cta', 'button'));
    const record = harness.typed('VERA_INSPECTOR_SELECTION').at(-1)?.payload['record'] as
      | Record<string, unknown>
      | undefined;
    expect(record?.['styleFacts']).toMatchObject({
      props: expect.objectContaining({ display: 'inline-flex', 'font-family': 'Pretendard' }),
      tagName: 'button',
    });
    // The harness validates everything the Bridge sends against the same
    // validator App A uses, so this is the real wire contract.
    expect(harness.contractFailures()).toEqual([]);
  });

  it('drops the facts on a route change, with no cache to go stale', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ getPropertyValue: () => 'inline-flex' }) as unknown as CSSStyleDeclaration,
    );
    const harness = createHarness();
    harness.hello();
    harness.freeze(true);
    harness.mark(mountElement('routed'));
    expect(
      harness.typed('VERA_INSPECTOR_SELECTION').at(-1)?.payload['record'],
    ).toHaveProperty('styleFacts');
    window.history.pushState({}, '', '/after-facts');
    window.dispatchEvent(new PopStateEvent('popstate'));
    const selections = harness
      .typed('VERA_INSPECTOR_SNAPSHOT')
      .at(-1)
      ?.payload['selections'] as Array<Record<string, unknown>>;
    for (const selection of selections) {
      expect(selection).not.toHaveProperty('styleFacts');
    }
    expect(harness.contractFailures()).toEqual([]);
  });

  it('omits the facts for a non-HTML mode', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ getPropertyValue: () => 'inline-flex' }) as unknown as CSSStyleDeclaration,
    );
    const harness = createHarness();
    harness.hello();
    harness.freeze(true);
    harness.dispatch('VERA_INSPECTOR_SET_MODE', { mode: 'konva' }, nextRequestId('mode-konva'));
    harness.mark(mountElement('konva-node'));
    const record = harness.typed('VERA_INSPECTOR_SELECTION').at(-1)?.payload['record'];
    expect(record).toMatchObject({ mode: 'konva' });
    expect(record).not.toHaveProperty('styleFacts');
    expect(harness.contractFailures()).toEqual([]);
  });
});

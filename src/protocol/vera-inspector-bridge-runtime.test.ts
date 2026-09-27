import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initVeraInspectorBridge } from '../../bridge/vera-inspector-bridge.ts';
import { validateBridgeMessage } from './validate.ts';
import type { ValidationContext } from './validate.ts';
import type { StyleFacts } from './types.ts';

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
  /** Restore window.parent.postMessage once the harness is finished with. */
  release: () => void;
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
  // Each harness gets its OWN postMessage capture, assigned rather than spied.
  // Vitest 4 returns the same mock when you vi.spyOn an already-mocked method,
  // so two harnesses in one test would otherwise share a call list and the
  // singleton-replacement test would see the first bridge's messages through the
  // second bridge's spy — a false failure that hides a real signal.
  const captured: BridgeMessage[] = [];
  const nativePostMessage = window.parent.postMessage;
  window.parent.postMessage = ((message: unknown) => {
    captured.push(message as BridgeMessage);
  }) as typeof window.parent.postMessage;
  const nativePushState = window.history.pushState;
  const nativeReplaceState = window.history.replaceState;
  const bridge = initVeraInspectorBridge({ appOrigin: APP_ORIGIN, ...options });
  let connectionId = '';
  let documentGeneration = '';
  let sequence = 0;
  const sent = (): BridgeMessage[] => [...captured];
  const typed = (type: string): BridgeMessage[] => sent().filter((message) => message.type === type);
  const restorePostMessage = (): void => {
    window.parent.postMessage = nativePostMessage;
  };
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
    release() {
      restorePostMessage();
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
  // Snapshot first: the destroy loop clears liveHarnesses on failure, and the
  // release loop must still see every harness that installed a capture.
  const harnesses = [...liveHarnesses];
  liveHarnesses = [];
  for (const harness of harnesses) {
    try {
      harness.bridge.destroy();
    } catch {
      // A throwing destroy is the condition under test elsewhere; keep going.
    }
  }
  // Reverse order: the last harness installed holds the previous harness's
  // capture as its "native" reference, not the real method.
  for (const harness of [...harnesses].reverse()) {
    harness.release();
  }
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
      { 'flex-direction': 'column' },
      { 'grid-template-columns': '1fr 1fr' },
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

  it('applies spacing between items while still refusing the flex and grid properties', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('spacing-target');
    harness.freeze(true);
    harness.mark(target);

    const results = harness.apply('bind-1', 'tx-gap', [
      {
        anchor: testIdAnchor('spacing-target'),
        declarations: { gap: '12px', 'row-gap': '8px', 'column-gap': '16px' },
      },
    ]);
    expect(results[0]?.payload['status']).toBe('applied');
    const css = previewStyleLayers().map((sheet) => sheet.textContent ?? '').join('\n');
    expect(css).toContain('gap:12px');
    expect(css).toContain('row-gap:8px');
    expect(css).toContain('column-gap:16px');

    // The neighbours of gap stay forbidden: allowlisting spacing must not open
    // the door to restructuring the layout.
    for (const declarations of [{ 'flex-direction': 'column' }, { 'grid-gap': '12px' }]) {
      const rejected = harness.apply('bind-1', 'tx-layout', [
        { anchor: testIdAnchor('spacing-target'), declarations },
      ]);
      expect(rejected[0]?.payload['status']).toBe('rejected');
    }
    expect(harness.contractFailures()).toEqual([]);
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
    // The decisive one. Each harness captures its own postMessage, so the
    // assertion above cannot fail just from sharing a spy — what actually
    // proves the first Bridge was torn down is that it went SILENT: a live
    // duplicate would still be listening on the same window events.
    const firstCountAfterReplace = first.sent().length;
    second.dispatch('VERA_INSPECTOR_PING', {}, nextRequestId('second-ping'));
    second.freeze(false);
    window.history.pushState({}, '', '/singleton-2');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(first.sent()).toHaveLength(firstCountAfterReplace);
  });
});

describe('style facts on the wire', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // jsdom ships no FontFaceSet, so a stub left behind here would decide the
    // next test's fontLoad instead of the next test.
    Reflect.deleteProperty(document, 'fonts');
  });

  it('carries a derived contrast verdict on the wire, and the app side accepts it', () => {
    // The probe button: near-black on the brand blue at 14px/600, which is
    // normal text, so the AA minimum is 4.5. Luminances 0.0130 and 0.2456 give
    // 0.2956 / 0.0630 = 4.69.
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (property: string) =>
            ({
              color: 'rgb(30, 30, 30)',
              'background-color': 'rgb(56, 132, 255)',
              'font-size': '14px',
              'font-weight': '600',
              display: 'inline-flex',
            })[property] ?? '',
        }) as unknown as CSSStyleDeclaration,
    );
    const harness = createHarness();
    harness.hello();
    // Freeze before the mark: the shield is what routes the click to a selection.
    harness.freeze(true);
    harness.mark(mountElement('probe', 'button'));
    const record = harness.typed('VERA_INSPECTOR_SELECTION').at(-1)?.payload['record'] as
      | Record<string, unknown>
      | undefined;
    const styleFacts = record?.['styleFacts'] as StyleFacts | undefined;
    expect(styleFacts?.derived?.contrast).toEqual({
      ratio: 4.69,
      min: 4.5,
      pass: true,
      large: false,
      background: '#3884ff',
    });
    // The decisive assertion. validate.ts is a second, stricter reader of the
    // same payload: a ratio outside 1..21, a `truncated: false`, a bare
    // `derived: {}` or a contrast with a key riding along would all be dropped
    // there, and the Bridge's own liveness gate would not notice. This proves
    // the new key survives the reader that actually has to accept it.
    expect(harness.contractFailures()).toEqual([]);
  });

  it('carries unmeasurable, truncated and fontLoad through the validator as well', () => {
    // The three shapes validate.ts treats differently from a verdict: the
    // unmeasurable marker has its own key set, `truncated` is true-only, and
    // fontLoad is a closed vocabulary. A record exercising all three at once is
    // the cheapest way to keep the three branches honest.
    Object.defineProperty(document, 'fonts', {
      value: Object.assign([{ family: 'Pretendard' }], { check: () => false }),
      configurable: true,
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (property: string) =>
            ({
              color: 'rgb(255, 255, 255)',
              'background-image': 'linear-gradient(rgb(30, 30, 30), rgb(56, 132, 255))',
              'font-family': 'Pretendard',
              'font-weight': '600',
              'font-size': '14px',
            })[property] ?? '',
        }) as unknown as CSSStyleDeclaration,
    );
    const harness = createHarness();
    harness.hello();
    harness.freeze(true);
    const button = mountElement('gradient-label', 'button');
    // jsdom has no layout, so the overflow the Bridge looks for has to exist.
    for (const [name, value] of Object.entries({
      clientWidth: 88,
      clientHeight: 32,
      scrollWidth: 240,
      scrollHeight: 32,
    })) {
      Object.defineProperty(button, name, { value, configurable: true });
    }
    harness.mark(button);
    const record = harness.typed('VERA_INSPECTOR_SELECTION').at(-1)?.payload['record'] as
      | Record<string, unknown>
      | undefined;
    const styleFacts = record?.['styleFacts'] as StyleFacts | undefined;
    expect(styleFacts?.derived).toEqual({
      contrast: { unmeasurable: true },
      truncated: true,
      fontLoad: 'fallback',
    });
    expect(harness.contractFailures()).toEqual([]);
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

function overlayHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-vera-inspector="overlay-host"]');
}

function shieldElement(): HTMLElement | null {
  return overlayHost()?.shadowRoot?.querySelector<HTMLElement>('[data-vera-inspector="freeze-shield"]') ?? null;
}

function freezeStyleSheets(): HTMLStyleElement[] {
  return [...document.querySelectorAll<HTMLStyleElement>('style[data-vera-inspector="freeze-style"]')];
}

function freezeState(harness: Harness): unknown {
  harness.dispatch('VERA_INSPECTOR_REQUEST_SNAPSHOT', {}, nextRequestId('frozen-state'));
  return harness.typed('VERA_INSPECTOR_SNAPSHOT').at(-1)?.payload['inspectorFrozen'];
}

function flushFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe('freeze inert state', () => {
  it('arms a pointer shield and a frozen stylesheet, and takes both down on unfreeze', () => {
    const harness = createHarness();
    harness.hello();
    expect(shieldElement()).not.toBeNull();
    expect(shieldElement()?.style.pointerEvents).toBe('none');
    expect(freezeStyleSheets()).toHaveLength(0);

    harness.freeze(true);
    // The shield sits inside the pointer-events:none host and opts only itself
    // back in, so the page stops receiving pointer events entirely.
    expect(shieldElement()?.style.pointerEvents).toBe('auto');
    expect(freezeState(harness)).toBe(true);
    const sheets = freezeStyleSheets();
    expect(sheets).toHaveLength(1);
    const css = sheets[0]?.textContent ?? '';
    expect(css).toContain('animation-play-state: paused');
    expect(css).toContain('transition: none');
    expect(css).toContain('caret-color: transparent');

    harness.freeze(false);
    expect(shieldElement()?.style.pointerEvents).toBe('none');
    expect(freezeState(harness)).toBe(false);
    expect(freezeStyleSheets()).toHaveLength(0);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('keeps the page from receiving clicks while frozen and hands them back on unfreeze', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('click-target');
    const onClick = vi.fn();
    target.addEventListener('click', onClick);

    harness.freeze(true);
    target.click();
    target.click();
    expect(onClick).not.toHaveBeenCalled();

    harness.freeze(false);
    target.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('blocks typing, editing and paste but keeps the freeze shortcut and Escape live', () => {
    const harness = createHarness();
    harness.hello();
    harness.freeze(true);
    const field = mountElement('text-field', 'input') as HTMLInputElement;
    const onKeyDown = vi.fn();
    const onInput = vi.fn();
    const onPaste = vi.fn();
    const onFocusIn = vi.fn();
    field.addEventListener('keydown', onKeyDown);
    field.addEventListener('input', onInput);
    field.addEventListener('paste', onPaste);
    field.addEventListener('focusin', onFocusIn);

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('paste', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
    expect(onFocusIn).not.toHaveBeenCalled();

    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F', shiftKey: true, ctrlKey: true, bubbles: true }),
    );
    expect(freezeState(harness)).toBe(false);
    expect(freezeStyleSheets()).toHaveLength(0);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('blurs whatever held focus when the freeze arms', () => {
    const harness = createHarness();
    harness.hello();
    const field = mountElement('focus-target', 'input') as HTMLInputElement;
    field.focus();
    expect(document.activeElement).toBe(field);

    harness.freeze(true);
    expect(document.activeElement).not.toBe(field);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('leaves scrolling alone so off-screen components stay reachable', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('scroll-target');
    const onWheel = vi.fn();
    target.addEventListener('wheel', onWheel);
    const onScroll = vi.fn();
    window.addEventListener('scroll', onScroll);

    harness.freeze(true);
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
    window.dispatchEvent(new Event('scroll'));
    expect(onWheel).toHaveBeenCalledTimes(1);
    expect(onScroll).toHaveBeenCalledTimes(1);
    window.removeEventListener('scroll', onScroll);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('still hovers and selects through the shield instead of losing the pointer', async () => {
    const harness = createHarness();
    harness.hello();
    harness.freeze(true);
    const target = mountElement('shielded-target', 'section');
    // jsdom reports an all-zero rect, and the bridge skips zero-size overlays.
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      left: 12,
      top: 34,
      width: 120,
      height: 40,
    } as DOMRect);

    // Regression guard for the hit-test rewrite: the shield retargets events to
    // the host, so hover must resolve the real element by coordinates.
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 34 }));
    await flushFrames();
    const hoverBox = overlayHost()?.shadowRoot?.querySelector<HTMLElement>('.vi-hover');
    expect(hoverBox).not.toBeNull();
    // The box carries the hovered element's own geometry, which only holds if
    // the hit test resolved `target` and not the shield or the host.
    expect(hoverBox?.style.width).toBe('120px');
    expect(hoverBox?.style.left).toBe('12px');

    harness.mark(target);
    const record = harness.typed('VERA_INSPECTOR_SELECTION').at(-1)?.payload['record'] as
      | Record<string, unknown>
      | undefined;
    expect(record?.['elementKey']).toBe('html:testid:shielded-target');
    expect(harness.contractFailures()).toEqual([]);
  });

  it('drops the shield and the stylesheet on session reset and on destroy', () => {
    const harness = createHarness();
    harness.hello();
    harness.freeze(true);
    expect(freezeStyleSheets()).toHaveLength(1);

    harness.dispatch('VERA_INSPECTOR_SESSION_RESET', {}, nextRequestId('reset-frozen'));
    expect(freezeStyleSheets()).toHaveLength(0);
    expect(shieldElement()?.style.pointerEvents).toBe('none');

    harness.freeze(true);
    expect(freezeStyleSheets()).toHaveLength(1);
    harness.bridge.destroy();
    // Destroy unmounts the host outright, so the shield goes with it.
    expect(freezeStyleSheets()).toHaveLength(0);
    expect(overlayHost()).toBeNull();
    expect(harness.contractFailures()).toEqual([]);
  });

  it('does not install the frozen stylesheet twice across repeated freeze toggles', () => {
    const harness = createHarness();
    harness.hello();
    for (let i = 0; i < 3; i += 1) {
      harness.freeze(true);
      expect(freezeStyleSheets()).toHaveLength(1);
      harness.freeze(true);
      expect(freezeStyleSheets()).toHaveLength(1);
      harness.freeze(false);
      expect(freezeStyleSheets()).toHaveLength(0);
    }
    expect(harness.contractFailures()).toEqual([]);
  });
});

/** Child node types plus their text, so a rollback can be compared exactly. */
function domShape(element: Element): string {
  return [...element.childNodes]
    .map((node) => (node.nodeType === 3 ? `text(${JSON.stringify(node.nodeValue ?? '')})` : node.nodeName))
    .join(',');
}

function textChildNodes(element: Element): string[] {
  return [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.nodeValue ?? '');
}

function mountRich(testId: string, parts: Array<string | HTMLElement>): HTMLElement {
  const element = document.createElement('p');
  element.setAttribute('data-testid', testId);
  for (const part of parts) {
    element.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
  }
  document.body.appendChild(element);
  return element;
}

function inlineNode(tag: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

/** Page-owned body children only: the bridge keeps its own overlay host there. */
function pageChildren(): Element[] {
  return [...document.body.children].filter(
    (element) => element.getAttribute('data-vera-inspector') === null,
  );
}

describe('preview v2 text and element operations', () => {
  it('clears only the direct text children, leaves child elements alone, and restores both on undo', () => {
    const harness = createHarness();
    harness.hello();
    const bold = inlineNode('b', 'bold');
    const target = mountRich('clear-target', ['Hello ', bold, ' world']);
    const before = domShape(target);
    expect(textChildNodes(target)).toEqual(['Hello ', ' world']);

    const results = harness.apply('bind-1', 'tx-clear', [
      { anchor: testIdAnchor('clear-target'), declarations: {}, text: 'clear' },
    ]);

    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    expect(results[0]?.payload['anchors']).toEqual([
      { elementKey: 'html:testid:clear-target', status: 'applied', matchCount: 1 },
    ]);
    expect(textChildNodes(target)).toEqual([]);
    expect(target.childNodes).toHaveLength(1);
    expect(target.firstChild).toBe(bold);
    expect(target.textContent).toBe('bold');
    // Nothing to scope, so a text-only change must not leave a style layer.
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);

    expect(harness.undo('bind-1', 'tx-clear')[0]?.payload).toMatchObject({ status: 'undone' });
    expect(domShape(target)).toBe(before);
    expect(target.textContent).toBe('Hello bold world');
    expect(target.firstChild).not.toBe(bold);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('restores interleaved text runs in their original order', () => {
    const harness = createHarness();
    harness.hello();
    const first = inlineNode('b', 'one');
    const second = inlineNode('i', 'two');
    const target = mountRich('order-target', ['a', first, 'b', second, 'c']);
    const before = domShape(target);

    harness.apply('bind-1', 'tx-order', [
      { anchor: testIdAnchor('order-target'), declarations: {}, text: 'clear' },
    ]);
    expect(domShape(target)).toBe('B,I');

    harness.undo('bind-1', 'tx-order');
    expect(domShape(target)).toBe(before);
    expect(target.textContent).toBe('aonebtwoc');
  });

  it('replaces the text and gives the original string back on undo', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('replace-target', ['Original copy']);
    const before = domShape(target);

    const results = harness.apply('bind-1', 'tx-replace', [
      { anchor: testIdAnchor('replace-target'), declarations: {}, replaceText: 'Replacement copy' },
    ]);

    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    expect(textChildNodes(target)).toEqual(['Replacement copy']);

    harness.undo('bind-1', 'tx-replace');
    expect(domShape(target)).toBe(before);
    expect(target.textContent).toBe('Original copy');
    expect(harness.contractFailures()).toEqual([]);
  });

  it('replaces text around a child element and rebuilds the exact original run', () => {
    const harness = createHarness();
    harness.hello();
    const bold = inlineNode('b', 'bold');
    const target = mountRich('replace-inline-target', ['before ', bold, ' after']);
    const before = domShape(target);

    harness.apply('bind-1', 'tx-replace-inline', [
      { anchor: testIdAnchor('replace-inline-target'), declarations: {}, replaceText: 'new' },
    ]);
    expect(target.textContent).toBe('newbold');

    harness.undo('bind-1', 'tx-replace-inline');
    expect(domShape(target)).toBe(before);
    expect(target.textContent).toBe('before bold after');
  });

  it('creates a text node when the element has no text of its own to replace', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('replace-empty-target', [inlineNode('span', 'kept')]);
    const before = domShape(target);

    const results = harness.apply('bind-1', 'tx-replace-empty', [
      { anchor: testIdAnchor('replace-empty-target'), declarations: {}, replaceText: 'added' },
    ]);

    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    expect(target.textContent).toBe('keptadded');

    harness.undo('bind-1', 'tx-replace-empty');
    expect(domShape(target)).toBe(before);
    expect(target.textContent).toBe('kept');
  });

  it('hides through the layer rule and takes the element itself back on undo', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountElement('hide-target');
    const before = domShape(target);

    const results = harness.apply('bind-1', 'tx-hide', [
      { anchor: testIdAnchor('hide-target'), declarations: {}, element: 'hide' },
    ]);

    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    // 'hide' must not detach anything: the layer is what reverses it.
    expect(target.isConnected).toBe(true);
    expect(domShape(target)).toBe(before);
    const attributes = previewAttributes(target);
    expect(attributes).toHaveLength(1);
    const layers = previewStyleLayers();
    expect(layers).toHaveLength(1);
    const css = layers[0]?.textContent ?? '';
    expect(css).toContain('display:none');
    expect(css).toContain(`${attributes[0]}="${target.getAttribute(attributes[0] ?? '')}"`);
    expect(window.getComputedStyle(target).display).toBe('none');

    harness.undo('bind-1', 'tx-hide');
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);
    expect(window.getComputedStyle(target).display).not.toBe('none');
  });

  it('keeps the display denylist closed to free-form declarations', () => {
    const harness = createHarness();
    harness.hello();
    mountElement('deny-target');
    const results = harness.apply('bind-1', 'tx-deny', [
      { anchor: testIdAnchor('deny-target'), declarations: { display: 'none' } },
    ]);
    expect(results[0]?.payload['status']).toBe('rejected');
    expect(previewStyleLayers()).toHaveLength(0);
  });

  it('detaches the element and re-inserts it at its original position on undo', () => {
    const harness = createHarness();
    harness.hello();
    const before = mountElement('remove-before');
    const target = mountElement('remove-target');
    const after = mountElement('remove-after');
    const siblings = pageChildren;

    const results = harness.apply('bind-1', 'tx-remove', [
      { anchor: testIdAnchor('remove-target'), declarations: {}, element: 'remove' },
    ]);

    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    expect(target.isConnected).toBe(false);
    expect(siblings()).toEqual([before, after]);
    const placeholder = after.previousSibling;
    expect(placeholder?.nodeType).toBe(8);

    harness.undo('bind-1', 'tx-remove');
    expect(siblings()).toEqual([before, target, after]);
    expect(target.isConnected).toBe(true);
    expect(target.parentElement).toBe(document.body);
    expect(after.previousSibling).toBe(target);
    expect(placeholder?.parentNode).toBeNull();
    expect(harness.contractFailures()).toEqual([]);
  });

  it('applies text and element operations alongside declarations in one change', () => {
    const harness = createHarness();
    harness.hello();
    const bold = inlineNode('b', 'bold');
    const target = mountRich('combined-target', ['copy ', bold]);
    const before = domShape(target);

    const results = harness.apply('bind-1', 'tx-combined', [
      {
        anchor: testIdAnchor('combined-target'),
        declarations: { color: 'red' },
        text: 'clear',
        element: 'hide',
      },
    ]);

    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    expect(textChildNodes(target)).toEqual([]);
    const css = previewStyleLayers()[0]?.textContent ?? '';
    expect(css).toContain('color:red');
    expect(css).toContain('display:none');

    harness.undo('bind-1', 'tx-combined');
    expect(domShape(target)).toBe(before);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);
  });

  it('is stable when the same transaction is applied twice and undone twice', () => {
    const harness = createHarness();
    harness.hello();
    const before = mountElement('stable-before');
    const target = mountRich('stable-target', ['keep ', inlineNode('b', 'bold')]);
    const after = mountElement('stable-after');
    const shape = domShape(target);
    const siblings = pageChildren;

    for (const replace of ['first', 'second']) {
      const results = harness.apply('bind-1', 'tx-stable', [
        { anchor: testIdAnchor('stable-target'), declarations: { color: 'red' }, replaceText: replace },
      ]);
      expect(results[0]?.payload['status']).toBe('applied');
      expect(target.textContent).toBe(`${replace}bold`);
      // The previous round's records are gone with its layer, so a second apply
      // cannot leave a stack of stale text nodes behind it.
      expect(previewStyleLayers()).toHaveLength(1);
      expect(previewAttributes(target)).toHaveLength(1);
    }
    expect(siblings()).toEqual([before, target, after]);

    expect(harness.undo('bind-1', 'tx-stable')[0]?.payload).toMatchObject({ status: 'undone' });
    expect(domShape(target)).toBe(shape);
    expect(siblings()).toEqual([before, target, after]);
    expect(harness.undo('bind-1', 'tx-stable')[0]?.payload).toMatchObject({ status: 'no-op' });
    expect(domShape(target)).toBe(shape);
    expect(siblings()).toEqual([before, target, after]);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('survives a re-apply of a remove without leaving orphan placeholders', () => {
    const harness = createHarness();
    harness.hello();
    const before = mountElement('reapply-remove-before');
    const target = mountElement('reapply-remove-target');
    const after = mountElement('reapply-remove-after');
    const placeholders = (): number =>
      [...document.body.childNodes].filter((node) => node.nodeType === 8).length;

    harness.apply('bind-1', 'tx-reapply-remove', [
      { anchor: testIdAnchor('reapply-remove-target'), declarations: {}, element: 'remove' },
    ]);
    expect(placeholders()).toBe(1);
    // The re-apply cannot resolve the element it detached last time, so this
    // round is unbound and the first round's placeholder is still in place.
    const second = harness.apply('bind-1', 'tx-reapply-remove', [
      { anchor: testIdAnchor('reapply-remove-target'), declarations: {}, element: 'remove' },
    ]);
    expect(second[0]?.payload['status']).toBe('unbound');
    expect(placeholders()).toBe(1);

    harness.undo('bind-1', 'tx-reapply-remove');
    expect(placeholders()).toBe(0);
    expect(pageChildren()).toEqual([before, target, after]);
  });

  it('rejects every invalid value for the new keys and leaves the page untouched', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('invalid-op-target', ['copy']);
    const before = domShape(target);
    const rejected: PreviewChangeInput[] = [
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, text: 'wipe' },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, text: true },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, text: null },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, replaceText: 42 },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, replaceText: 'x'.repeat(201) },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, element: 'collapse' },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, element: 'hidden' },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, element: true },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, text: 'clear', replaceText: 'both' },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {}, extra: 'invented' },
      { anchor: testIdAnchor('invalid-op-target'), declarations: {} },
      { anchor: testIdAnchor('invalid-op-target') },
      { anchor: testIdAnchor('invalid-op-target'), declarations: 'color: red' },
    ];
    for (const change of rejected) {
      const results = harness.apply('bind-1', 'tx-invalid-op', [change]);
      expect(results).toHaveLength(1);
      expect(results[0]?.payload['status']).toBe('rejected');
      expect(domShape(target)).toBe(before);
      expect(target.isConnected).toBe(true);
    }
    expect(previewStyleLayers()).toHaveLength(0);
    expect(markedElements()).toEqual([]);
    expect(harness.undo('bind-1', 'tx-invalid-op')[0]?.payload).toMatchObject({ status: 'no-op' });
    expect(domShape(target)).toBe(before);
  });

  it('accepts a replaceText of exactly the bound and rejects nothing else', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('bound-target', ['copy']);
    const results = harness.apply('bind-1', 'tx-bound', [
      { anchor: testIdAnchor('bound-target'), declarations: {}, replaceText: 'y'.repeat(200) },
    ]);
    expect(results[0]?.payload['status']).toBe('applied');
    expect(target.textContent).toBe('y'.repeat(200));
  });

  it('rebuilds a run of adjacent text nodes that has no element between it', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('adjacent-target', ['one ', 'two ', 'three']);
    const before = domShape(target);

    harness.apply('bind-1', 'tx-adjacent', [
      { anchor: testIdAnchor('adjacent-target'), declarations: {}, text: 'clear' },
    ]);
    expect(domShape(target)).toBe('');

    harness.undo('bind-1', 'tx-adjacent');
    expect(domShape(target)).toBe(before);
    expect(target.textContent).toBe('one two three');
  });

  it('reports an element with no text of its own as an unchanged but applied clear', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('no-text-target', [inlineNode('span', 'kept')]);
    const before = domShape(target);

    const results = harness.apply('bind-1', 'tx-no-text', [
      { anchor: testIdAnchor('no-text-target'), declarations: {}, text: 'clear' },
    ]);

    expect(results[0]?.payload).toMatchObject({ status: 'applied' });
    expect(domShape(target)).toBe(before);
    harness.undo('bind-1', 'tx-no-text');
    expect(domShape(target)).toBe(before);
  });

  it('rejects a text clear past the node bound rather than clearing part of it', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('bounded-target', []);
    for (let i = 0; i < 65; i += 1) target.appendChild(document.createTextNode(`t${i}`));
    const before = domShape(target);

    const results = harness.apply('bind-1', 'tx-bounded', [
      { anchor: testIdAnchor('bounded-target'), declarations: {}, text: 'clear' },
    ]);

    expect(results[0]?.payload['status']).toBe('rejected');
    expect(results[0]?.payload['anchors']).toEqual([
      { elementKey: 'html:testid:bounded-target', status: 'rejected', matchCount: 1 },
    ]);
    expect(domShape(target)).toBe(before);
    harness.undo('bind-1', 'tx-bounded');
    expect(domShape(target)).toBe(before);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('marks only the failing anchor rejected when one operation in a transaction fails', () => {
    const harness = createHarness();
    harness.hello();
    const styled = mountElement('partial-styled');
    const doomed = mountRich('partial-doomed', []);
    for (let i = 0; i < 65; i += 1) doomed.appendChild(document.createTextNode(`t${i}`));
    const before = domShape(doomed);

    const results = harness.apply('bind-1', 'tx-partial', [
      { anchor: testIdAnchor('partial-styled'), declarations: { color: 'red' } },
      { anchor: testIdAnchor('partial-doomed'), declarations: {}, text: 'clear' },
    ]);

    expect(results[0]?.payload['status']).toBe('rejected');
    expect(results[0]?.payload['anchors']).toEqual([
      { elementKey: 'html:testid:partial-styled', status: 'applied', matchCount: 1 },
      { elementKey: 'html:testid:partial-doomed', status: 'rejected', matchCount: 1 },
    ]);
    expect(domShape(doomed)).toBe(before);
    expect(previewStyleLayers()[0]?.textContent).toContain('color:red');
    // The half that did apply is still reversible.
    harness.undo('bind-1', 'tx-partial');
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(styled)).toEqual([]);
    expect(domShape(doomed)).toBe(before);
    expect(harness.contractFailures()).toEqual([]);
  });

  it('rejects a transaction that targets the same element twice', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('duplicate-op-target', ['copy']);
    const before = domShape(target);

    const results = harness.apply('bind-1', 'tx-duplicate-op', [
      { anchor: testIdAnchor('duplicate-op-target'), declarations: {}, text: 'clear' },
      { anchor: testIdAnchor('duplicate-op-target'), declarations: { color: 'red' } },
    ]);

    expect(results[0]?.payload['status']).toBe('rejected');
    expect(domShape(target)).toBe(before);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);
  });

  it('rejects a transaction that reaches one element through two different anchors', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('double-anchored', ['copy']);

    const results = harness.apply('bind-1', 'tx-double-anchored', [
      { anchor: testIdAnchor('double-anchored'), declarations: { color: 'red' } },
      {
        // A cross-route anchor with a strong hint rebinds onto the same element
        // under a different elementKey, so these two changes collide on one node
        // without ever sharing an anchor.
        anchor: testIdAnchor('double-anchored', {
          elementKey: 'html:path:html/body/9',
          routeKey: '/some-other-route',
          tagName: 'p',
        }),
        declarations: { color: 'blue' },
      },
    ]);

    expect(results[0]?.payload['status']).toBe('rejected');
    expect(previewStyleLayers()).toHaveLength(0);
    expect(previewAttributes(target)).toEqual([]);
  });

  it('does not resurrect text whose parent the page detached', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('orphaned-text-target', ['copy ', inlineNode('b', 'bold')]);

    harness.apply('bind-1', 'tx-orphaned-text', [
      { anchor: testIdAnchor('orphaned-text-target'), declarations: {}, text: 'clear' },
    ]);
    expect(textChildNodes(target)).toEqual([]);
    target.remove();

    expect(() => harness.undo('bind-1', 'tx-orphaned-text')).not.toThrow();
    expect(domShape(target)).toBe('B');
    expect(document.body.textContent).not.toContain('copy');
    expect(harness.undo('bind-1', 'tx-orphaned-text')[0]?.payload).toMatchObject({ status: 'no-op' });
  });

  it('does not resurrect an element whose placeholder the page removed', () => {
    const harness = createHarness();
    harness.hello();
    const before = mountElement('gone-placeholder-before');
    const target = mountElement('gone-placeholder-target');
    const after = mountElement('gone-placeholder-after');

    harness.apply('bind-1', 'tx-gone-placeholder', [
      { anchor: testIdAnchor('gone-placeholder-target'), declarations: {}, element: 'remove' },
    ]);
    const placeholder = after.previousSibling;
    placeholder?.parentNode?.removeChild(placeholder);

    expect(() => harness.undo('bind-1', 'tx-gone-placeholder')).not.toThrow();
    expect(pageChildren()).toEqual([before, after]);
    expect(target.isConnected).toBe(false);
  });

  it('replays every operation on a session reset, not just on an undo', () => {
    const harness = createHarness();
    harness.hello();
    const target = mountRich('reset-restore', ['copy ', inlineNode('b', 'bold')]);
    const card = mountElement('reset-restore-card');
    const shape = domShape(target);

    harness.apply('bind-1', 'tx-reset-restore', [
      { anchor: testIdAnchor('reset-restore'), declarations: {}, replaceText: 'new' },
      { anchor: testIdAnchor('reset-restore-card'), declarations: {}, element: 'remove' },
    ]);
    expect(target.textContent).toBe('newbold');
    expect(card.isConnected).toBe(false);

    harness.dispatch('VERA_INSPECTOR_SESSION_RESET', {}, nextRequestId('reset-restores'));
    expect(domShape(target)).toBe(shape);
    expect(card.isConnected).toBe(true);
    expect(previewStyleLayers()).toHaveLength(0);
    expect(pageChildren()).toContain(card);
  });

  it('restores a detached subtree before the text inside it', () => {
    const harness = createHarness();
    harness.hello();
    const card = mountElement('nested-remove-card');
    const inner = inlineNode('span', 'inner copy');
    inner.setAttribute('data-testid', 'nested-remove-card-inner');
    card.appendChild(inner);
    const shape = domShape(card);

    const results = harness.apply('bind-1', 'tx-nested-remove', [
      { anchor: testIdAnchor('nested-remove-card'), declarations: {}, element: 'remove' },
      { anchor: testIdAnchor('nested-remove-card-inner'), declarations: {}, text: 'clear' },
    ]);

    expect(results[0]?.payload['status']).toBe('applied');
    expect(card.isConnected).toBe(false);
    expect(inner.textContent).toBe('');

    // The card has to be back in the document before its descendant counts as a
    // live parent, or the text restore would be skipped as an orphan.
    harness.undo('bind-1', 'tx-nested-remove');
    expect(card.isConnected).toBe(true);
    expect(domShape(card)).toBe(shape);
    expect(card.textContent).toBe('inner copy');
    expect(harness.contractFailures()).toEqual([]);
  });
});

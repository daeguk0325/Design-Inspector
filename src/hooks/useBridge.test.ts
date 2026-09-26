import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PreviewAnchorChange,
  PreviewAnchorResult,
  PreviewResultPayload,
} from '../protocol/types.ts';
import type { BridgeApi } from './useBridge.ts';
import { useBridge } from './useBridge.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET_URL = 'http://target.test/app';
const FRAME_URL = 'http://127.0.0.1:41234/app';
const FRAME_ORIGIN = 'http://127.0.0.1:41234';
const CONN = 'c1';
const GEN = 'd1';

interface Posted {
  type: string;
  connectionId: string;
  documentGeneration: string;
  requestId: string;
  sequence: number;
  payload: Record<string, unknown>;
}

interface Incoming {
  type: string;
  payload: Record<string, unknown>;
  requestId?: string;
  connectionId?: string;
  documentGeneration?: string;
  sequence?: number;
  origin?: string;
  source?: MessageEventSource;
  protocolVersion?: number;
}

interface Harness {
  readonly api: BridgeApi;
  invoke: <T>(run: () => T) => T;
  posted: () => Posted[];
  of: (type: string) => Posted[];
  last: (type: string) => Posted | undefined;
  deliver: (message: Incoming) => void;
  connect: (over?: { connectionId?: string; documentGeneration?: string; routeEpoch?: number }) => void;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.useRealTimers();
});

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

const CHANGE: PreviewAnchorChange = {
  anchor: anchor() as PreviewAnchorChange['anchor'],
  declarations: { 'background-color': '#0ea5e9' },
};

const APPLIED_ANCHOR: PreviewAnchorResult = {
  elementKey: 'html:testid:cta',
  status: 'applied',
  matchCount: 1,
};

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
    connectionId: CONN,
    documentGeneration: GEN,
    inspectorFrozen: false,
    mode: 'html',
    selections: [record()],
    activeOrder: ['sel-1'],
    routeKey: '/checkout',
    routeEpoch: 2,
    ...over,
  };
}

function previewPayload(over: Record<string, unknown> = {}) {
  return {
    bindingId: 'bind-1',
    transactionId: 'tx-1',
    operation: 'apply',
    status: 'applied',
    anchors: [APPLIED_ANCHOR],
    routeKey: '/checkout',
    routeEpoch: 2,
    ...over,
  };
}

const CAPTURE_RESULT = {
  selectionId: 'sel-1',
  mimeType: 'image/png',
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==',
  width: 1,
  height: 1,
  byteLength: 67,
};

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const iframe = document.createElement('iframe');
  container.appendChild(iframe);
  const frameWindow = iframe.contentWindow as Window;
  const spy = vi
    .spyOn(frameWindow, 'postMessage')
    .mockImplementation(() => undefined);
  const root = createRoot(container);
  let current: BridgeApi | null = null;
  function Probe() {
    current = useBridge(TARGET_URL);
    return null;
  }
  act(() => root.render(createElement(Probe)));
  mounted.push({ root, container });
  act(() => {
    const first = current as unknown as BridgeApi;
    first.iframeRef.current = iframe;
    first.loadTarget(TARGET_URL, FRAME_URL);
  });
  // A real frame fires load once it has navigated, and posting before that is a
  // refused origin check rather than a silent no-op. The harness models the
  // event, so the hook's own guard is exercised the way the browser drives it.
  act(() => {
    (current as unknown as BridgeApi).reconnect();
  });
  let sequence = 0;
  const posted = (): Posted[] =>
    spy.mock.calls.map((call) => call[0] as Posted);
  const of = (type: string): Posted[] => posted().filter((message) => message.type === type);
  const deliver = (message: Incoming) => {
    sequence += 1;
    const envelope = {
      protocolVersion: message.protocolVersion ?? 1,
      type: message.type,
      connectionId: message.connectionId ?? CONN,
      documentGeneration: message.documentGeneration ?? GEN,
      requestId: message.requestId ?? `r${sequence}`,
      sequence: message.sequence ?? sequence,
      payload: message.payload,
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: envelope,
          origin: message.origin ?? FRAME_ORIGIN,
          source: message.source ?? frameWindow,
        }),
      );
    });
  };
  const connect: Harness['connect'] = (over = {}) => {
    const connectionId = over.connectionId ?? CONN;
    const documentGeneration = over.documentGeneration ?? GEN;
    const routeEpoch = over.routeEpoch ?? 2;
    const hello = of('VERA_INSPECTOR_HELLO').at(-1);
    deliver({
      type: 'VERA_INSPECTOR_HELLO_ACK',
      requestId: hello?.requestId ?? 'hello',
      connectionId,
      documentGeneration,
      sequence: 0,
      payload: {
        bridgeConnectionId: connectionId,
        documentGeneration,
        veraUrl: TARGET_URL,
        routeKey: '/checkout',
        routeEpoch,
      },
    });
    deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      connectionId,
      documentGeneration,
      payload: snapshotPayload({ connectionId, documentGeneration, routeEpoch }),
    });
  };
  return {
    get api(): BridgeApi {
      return current as unknown as BridgeApi;
    },
    invoke: <T,>(run: () => T): T => {
      let result!: T;
      act(() => {
        result = run();
      });
      return result;
    },
    posted,
    of,
    last: (type) => of(type).at(-1),
    deliver,
    connect,
  };
}

describe('useBridge frame load gate', () => {
  it('posts nothing while the frame is still on its previous document', () => {
    // A frame that has not navigated is on about:blank, which inherits the app's
    // own origin, so a post aimed at the target origin is refused by the browser
    // and logged. The handshake used to rely on its own retry to cover this.
    const bridge = mount();
    const before = bridge.posted().length;
    bridge.api.loadTarget('https://other.example', 'https://other.example/');
    // loadTarget clears the flag, so nothing new may go out until the frame loads.
    expect(bridge.posted().length).toBe(before);
    bridge.api.reconnect();
    expect(bridge.posted().length).toBeGreaterThan(before);
  });
});

describe('useBridge confirmed deselect', () => {
  it('resolves true once the target snapshot no longer holds the selection', async () => {
    const bridge = mount();
    bridge.connect();
    const pending = bridge.invoke(() => bridge.api.clearSelectionConfirmed('sel-1', 2000));
    expect(bridge.last('VERA_INSPECTOR_CLEAR_SELECTION')?.payload).toEqual({ selectionId: 'sel-1' });

    let settled: boolean | null = null;
    void pending.then((value) => {
      settled = value;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBeNull();

    await act(async () => {
      bridge.deliver({
        type: 'VERA_INSPECTOR_SNAPSHOT',
        sequence: 99,
        payload: snapshotPayload({ selections: [], activeOrder: [], routeKey: '/next' }),
      });
    });
    expect(bridge.api.snapshot?.routeKey).toBe('/next');
    expect(settled).toBe(true);
  });

  it('resolves false when the target keeps the selection active', async () => {
    const bridge = mount();
    bridge.connect();
    const pending = bridge.invoke(() => bridge.api.clearSelectionConfirmed('sel-1', 2000));

    let settled: boolean | null = null;
    void pending.then((value) => {
      settled = value;
    });
    await act(async () => {
      bridge.deliver({
        type: 'VERA_INSPECTOR_SNAPSHOT',
        sequence: 99,
        payload: snapshotPayload(),
      });
    });
    expect(settled).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });
    expect(settled).toBe(false);
  });

  it('resolves false immediately when the bridge is not ready', async () => {
    const bridge = mount();
    await expect(bridge.invoke(() => bridge.api.clearSelectionConfirmed('sel-1'))).resolves.toBe(false);
  });
});

describe('useBridge reselect', () => {
  it('asks the target to re-activate the same id and waits for its record', async () => {
    const bridge = mount();
    bridge.connect();
    const record = {
      selectionId: 'sel-1',
      elementKey: 'html:testid:cta',
      component: 'Button',
      file: 'src/App.tsx',
      line: 12,
      mode: 'html',
      state: 'active',
      order: 0,
    };
    await act(async () => {
      bridge.deliver({
        type: 'VERA_INSPECTOR_SNAPSHOT',
        sequence: 90,
        payload: snapshotPayload({ selections: [], activeOrder: [] }),
      });
    });
    expect(bridge.api.snapshot?.selections).toEqual([]);

    await act(async () => {
      bridge.api.reselectSelection('sel-1');
    });
    expect(bridge.last('VERA_INSPECTOR_RESELECT_SELECTION')?.payload).toEqual({ selectionId: 'sel-1' });
    // The app has no record of its own to re-add, so the tray waits for the echo.
    expect(bridge.api.snapshot?.selections).toEqual([]);

    await act(async () => {
      bridge.deliver({
        type: 'VERA_INSPECTOR_SELECTION',
        sequence: 91,
        payload: { record, activeOrder: ['sel-1'] },
      });
    });
    expect(bridge.api.snapshot?.selections).toEqual([record]);
    expect(bridge.api.snapshot?.activeOrder).toEqual(['sel-1']);
  });
});

describe('useBridge session binding', () => {
  it('resets the binding immediately when the same session is bound again', async () => {
    const bridge = mount();
    bridge.connect();
    expect(bridge.api.ready).toBe(true);
    expect(bridge.api.sessionBindingId).toBeNull();

    const capture = bridge.invoke(() => bridge.api.captureSelection('sel-1'));
    const preview = bridge.api.applyPreview('bind-1', 'tx-1', [CHANGE]);
    const captureRejection = expect(capture).rejects.toThrow('The target session was reset.');
    const previewRejection = expect(preview).rejects.toThrow('The target session was reset.');

    act(() => bridge.api.bindSession('sess-a'));
    expect(bridge.api.sessionBindingId).toBe('sess-a');
    expect(bridge.api.reconciling).toBe(true);
    expect(bridge.api.ready).toBe(false);
    expect(bridge.api.snapshot).toBeNull();
    expect(bridge.api.captures).toEqual({});
    const reset = bridge.last('VERA_INSPECTOR_SESSION_RESET');
    expect(reset).toBeDefined();
    expect(reset?.connectionId).toBe(CONN);
    expect(reset?.documentGeneration).toBe(GEN);
    expect(bridge.of('VERA_INSPECTOR_HELLO')).toHaveLength(1);

    await captureRejection;
    await previewRejection;

    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload(),
    });
    expect(bridge.api.ready).toBe(true);
    expect(bridge.api.reconciling).toBe(false);

    act(() => bridge.api.bindSession('sess-a'));
    expect(bridge.api.sessionBindingId).toBe('sess-a');
    expect(bridge.api.ready).toBe(false);
    expect(bridge.api.reconciling).toBe(true);
    expect(bridge.api.snapshot).toBeNull();
    expect(bridge.of('VERA_INSPECTOR_SESSION_RESET')).toHaveLength(2);
    expect(bridge.of('VERA_INSPECTOR_HELLO')).toHaveLength(1);
  });

  it('stays not-ready until a fresh snapshot arrives for the new binding', () => {
    const bridge = mount();
    bridge.connect();
    expect(bridge.api.ready).toBe(true);

    act(() => bridge.api.bindSession('sess-b'));
    expect(bridge.api.ready).toBe(false);
    expect(bridge.api.reconciling).toBe(true);
    expect(bridge.api.status).toBe('connected');

    const reset = bridge.last('VERA_INSPECTOR_SESSION_RESET');
    bridge.deliver({
      type: 'VERA_INSPECTOR_SESSION_RESET_ACK',
      requestId: reset?.requestId ?? 'none',
      payload: { routeKey: '/checkout', routeEpoch: 2 },
    });
    expect(bridge.api.ready).toBe(false);
    expect(bridge.api.snapshot).toBeNull();
    expect(bridge.api.reconciling).toBe(true);

    bridge.deliver({
      type: 'VERA_INSPECTOR_SESSION_RESET_ACK',
      requestId: 'stale-ack',
      payload: { routeKey: '/checkout', routeEpoch: 9 },
    });
    expect(bridge.api.routeEpoch).toBe(2);
    expect(bridge.api.ready).toBe(false);

    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload(),
    });
    expect(bridge.api.ready).toBe(true);
    expect(bridge.api.reconciling).toBe(false);
    expect(bridge.api.sessionBindingId).toBe('sess-b');
  });

  it('rejects late capture and preview results from a prior binding, connection, generation, and route', async () => {
    const bridge = mount();
    bridge.connect();

    const capture = bridge.invoke(() => bridge.api.captureSelection('sel-1'));
    const preview = bridge.api.applyPreview('bind-1', 'tx-1', [CHANGE]);
    const captureRequest = bridge.last('VERA_INSPECTOR_CAPTURE_SELECTION')?.requestId;
    const previewRequest = bridge.last('VERA_INSPECTOR_PREVIEW_APPLY')?.requestId;
    const captureRejection = expect(capture).rejects.toThrow('The target session was reset.');
    const previewRejection = expect(preview).rejects.toThrow('The target session was reset.');

    act(() => bridge.api.bindSession('sess-c'));
    await captureRejection;
    await previewRejection;

    bridge.deliver({
      type: 'VERA_INSPECTOR_CAPTURE_RESULT',
      requestId: captureRequest ?? '',
      payload: { ...CAPTURE_RESULT },
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: previewRequest ?? '',
      payload: previewPayload(),
    });
    expect(bridge.api.captures).toEqual({});
    expect(bridge.api.snapshot).toBeNull();

    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload(),
    });
    expect(bridge.api.ready).toBe(true);

    const lateCapture = bridge.invoke(() => bridge.api.captureSelection('sel-1'));
    const lateCaptureRequest = bridge.last('VERA_INSPECTOR_CAPTURE_SELECTION')?.requestId;
    const lateRejection = expect(lateCapture).rejects.toThrow('The target session was reset.');

    bridge.deliver({
      type: 'VERA_INSPECTOR_CAPTURE_RESULT',
      requestId: lateCaptureRequest ?? '',
      connectionId: 'c-old',
      payload: { ...CAPTURE_RESULT },
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_CAPTURE_RESULT',
      requestId: lateCaptureRequest ?? '',
      documentGeneration: 'd-old',
      payload: { ...CAPTURE_RESULT },
    });
    expect(bridge.api.captures['sel-1']?.status).toBe('capturing');
    act(() => bridge.api.bindSession('sess-d'));
    await lateRejection;

    const staleRoutePreview = bridge.api.applyPreview('bind-1', 'tx-2', [CHANGE]);
    const staleRouteRejection = expect(staleRoutePreview).rejects.toThrow('The target route changed.');
    const staleRouteRequest = bridge.last('VERA_INSPECTOR_PREVIEW_APPLY')?.requestId;
    bridge.deliver({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/cart', routeEpoch: 5 },
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({ routeKey: '/cart', routeEpoch: 5 }),
    });
    expect(bridge.api.routeEpoch).toBe(5);
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: staleRouteRequest ?? '',
      payload: previewPayload({ routeEpoch: 2, transactionId: 'tx-2' }),
    });
    expect(bridge.api.ready).toBe(true);
    await staleRouteRejection;
  });
});

describe('useBridge preview requests', () => {
  it('correlates preview apply, undo, and reset results by request id', async () => {
    const bridge = mount();
    bridge.connect();

    const applied = bridge.api.applyPreview('bind-1', 'tx-1', [CHANGE]);
    const applyMessage = bridge.last('VERA_INSPECTOR_PREVIEW_APPLY');
    expect(applyMessage?.payload).toEqual({
      bindingId: 'bind-1',
      transactionId: 'tx-1',
      changes: [CHANGE],
    });

    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: applyMessage?.requestId ?? '',
      payload: previewPayload({ transactionId: 'tx-other' }),
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: 'unrelated-request',
      payload: previewPayload(),
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: applyMessage?.requestId ?? '',
      payload: previewPayload({ bindingId: 'bind-other' }),
    });

    const resolved: string[] = [];
    const assertion = applied.then((result: PreviewResultPayload) => {
      resolved.push(result.status);
      return result;
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: applyMessage?.requestId ?? '',
      payload: previewPayload(),
    });
    const result = await assertion;
    expect(resolved).toEqual(['applied']);
    expect(result.operation).toBe('apply');
    expect(result.anchors).toEqual([APPLIED_ANCHOR]);

    const undone = bridge.api.undoPreview('bind-1', 'tx-1');
    const undoMessage = bridge.last('VERA_INSPECTOR_PREVIEW_UNDO');
    expect(undoMessage?.payload).toEqual({ bindingId: 'bind-1', transactionId: 'tx-1' });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: undoMessage?.requestId ?? '',
      payload: previewPayload({ operation: 'undo', status: 'undone', anchors: [], transactionId: 'tx-1' }),
    });
    expect((await undone).status).toBe('undone');

    const resetAll = bridge.api.resetPreviews('bind-1');
    const resetAllMessage = bridge.last('VERA_INSPECTOR_PREVIEW_RESET');
    expect(resetAllMessage?.payload).toEqual({ bindingId: 'bind-1' });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: resetAllMessage?.requestId ?? '',
      payload: previewPayload({ operation: 'reset', status: 'reset', anchors: [], transactionId: '*' }),
    });
    expect((await resetAll).operation).toBe('reset');

    const resetSome = bridge.api.resetPreviews('bind-1', ['tx-1', 'tx-2']);
    const resetSomeMessage = bridge.last('VERA_INSPECTOR_PREVIEW_RESET');
    expect(resetSomeMessage?.payload).toEqual({ bindingId: 'bind-1', transactionIds: ['tx-1', 'tx-2'] });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: resetSomeMessage?.requestId ?? '',
      payload: previewPayload({ operation: 'reset', status: 'no-op', anchors: [], transactionId: '*' }),
    });
    expect((await resetSome).status).toBe('no-op');
  });

  it('rejects preview requests that time out and bounds the pending map', async () => {
    vi.useFakeTimers();
    const bridge = mount();
    bridge.connect();

    const timedOut = bridge.api.applyPreview('bind-1', 'tx-timeout', [CHANGE]);
    const timedOutAssertion = expect(timedOut).rejects.toThrow('Preview request timed out.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await timedOutAssertion;

    const pending: Array<Promise<PreviewResultPayload>> = [];
    for (let index = 0; index < 8; index += 1) {
      pending.push(bridge.api.applyPreview('bind-1', `tx-${index}`, [CHANGE]));
    }
    const evicted = expect(pending[0]).rejects.toThrow('Too many pending preview requests.');
    const overflow = bridge.api.applyPreview('bind-1', 'tx-overflow', [CHANGE]);
    const overflowRequest = bridge.of('VERA_INSPECTOR_PREVIEW_APPLY').at(-1)?.requestId;
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: overflowRequest ?? '',
      payload: previewPayload({ transactionId: 'tx-overflow' }),
    });
    expect((await overflow).transactionId).toBe('tx-overflow');
    await evicted;

    const first = bridge.last('VERA_INSPECTOR_PREVIEW_APPLY');
    expect(first).toBeDefined();
    const unsettled = pending.slice(1).map((entry) => expect(entry).rejects.toThrow('The target session was reset.'));
    act(() => bridge.api.resetSession());
    for (const entry of unsettled) await entry;
  });

  it('rejects preview requests on bridge error, target change, and route change', async () => {
    const bridge = mount();
    bridge.connect();

    const onError = bridge.api.applyPreview('bind-1', 'tx-err', [CHANGE]);
    const onErrorRequest = bridge.last('VERA_INSPECTOR_PREVIEW_APPLY')?.requestId;
    const errorAssertion = expect(onError).rejects.toThrow('Preview apply rejected by the target.');
    bridge.deliver({
      type: 'VERA_INSPECTOR_ERROR',
      requestId: onErrorRequest ?? '',
      payload: { code: 'invalid-preview-command', message: 'Preview apply rejected by the target.' },
    });
    await errorAssertion;

    const onRoute = bridge.api.applyPreview('bind-1', 'tx-route', [CHANGE]);
    const onRouteRequest = bridge.last('VERA_INSPECTOR_PREVIEW_APPLY')?.requestId;
    const routeAssertion = expect(onRoute).rejects.toThrow('The target route changed.');
    bridge.deliver({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/cart', routeEpoch: 3 },
    });
    expect(bridge.api.routeEpoch).toBe(3);
    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({ routeKey: '/cart', routeEpoch: 3 }),
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_PREVIEW_RESULT',
      requestId: onRouteRequest ?? '',
      payload: previewPayload({ transactionId: 'tx-route', routeEpoch: 3 }),
    });
    await routeAssertion;
    expect(bridge.api.ready).toBe(true);

    const onTarget = bridge.api.applyPreview('bind-1', 'tx-target', [CHANGE]);
    const targetAssertion = expect(onTarget).rejects.toThrow('The target changed.');
    act(() => bridge.api.loadTarget('http://other.test/app', 'http://127.0.0.1:51999/app'));
    await targetAssertion;
    expect(bridge.api.routeEpoch).toBeNull();
    expect(bridge.api.ready).toBe(false);
  });
});

describe('useBridge route epoch and session reset', () => {
  it('tracks route epoch from handshakes, snapshots, and route changes', () => {
    const bridge = mount();
    expect(bridge.api.routeEpoch).toBeNull();
    bridge.connect({ routeEpoch: 2 });
    expect(bridge.api.routeEpoch).toBe(2);
    expect(bridge.api.ready).toBe(true);

    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({ routeEpoch: 4 }),
    });
    expect(bridge.api.routeEpoch).toBe(4);

    const before = bridge.of('VERA_INSPECTOR_REQUEST_SNAPSHOT').length;
    bridge.deliver({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/cart', routeEpoch: 5 },
    });
    expect(bridge.api.routeEpoch).toBe(5);
    expect(bridge.api.reconciling).toBe(true);
    expect(bridge.api.ready).toBe(false);
    expect(bridge.api.snapshot).toBeNull();
    expect(bridge.of('VERA_INSPECTOR_REQUEST_SNAPSHOT').length).toBe(before + 1);

    bridge.deliver({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/checkout', routeEpoch: 4 },
    });
    expect(bridge.api.routeEpoch).toBe(5);

    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({ routeKey: '/cart', routeEpoch: 5 }),
    });
    expect(bridge.api.routeEpoch).toBe(5);
    expect(bridge.api.ready).toBe(true);
  });

  it('clears local captures on a route change and ignores pre-snapshot selections', async () => {
    const bridge = mount();
    bridge.connect();
    const capture = bridge.invoke(() => bridge.api.captureSelection('sel-1'));
    bridge.deliver({
      type: 'VERA_INSPECTOR_CAPTURE_RESULT',
      requestId: bridge.last('VERA_INSPECTOR_CAPTURE_SELECTION')?.requestId ?? '',
      payload: { ...CAPTURE_RESULT },
    });
    expect(bridge.api.captures['sel-1']?.status).toBe('ready');
    expect((await capture).selectionId).toBe('sel-1');

    const replacement = bridge.invoke(() => bridge.api.captureSelection('sel-1'));
    const replacementAssertion = expect(replacement).rejects.toThrow('Capture cancelled.');
    bridge.deliver({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      payload: { routeKey: '/cart', routeEpoch: 6 },
    });
    expect(bridge.api.captures).toEqual({});
    expect(bridge.api.reconciling).toBe(true);
    bridge.deliver({
      type: 'VERA_INSPECTOR_SELECTION',
      payload: { record: record({ selectionId: 'sel-9' }), activeOrder: ['sel-9'] },
    });
    expect(bridge.api.snapshot).toBeNull();
    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({ routeKey: '/cart', routeEpoch: 6 }),
    });
    expect(bridge.api.snapshot?.selections.map((item) => item.selectionId)).toEqual(['sel-1']);
    await replacementAssertion;
  });

  it('correlates one session reset acknowledgement and clears its correlation on error', () => {
    const bridge = mount();
    bridge.connect();

    act(() => bridge.api.resetSession());
    const first = bridge.last('VERA_INSPECTOR_SESSION_RESET');
    expect(first?.payload).toEqual({});
    const requested = bridge.of('VERA_INSPECTOR_REQUEST_SNAPSHOT').length;
    bridge.deliver({
      type: 'VERA_INSPECTOR_SESSION_RESET_ACK',
      requestId: first?.requestId ?? '',
      payload: { routeKey: '/checkout', routeEpoch: 7 },
    });
    expect(bridge.of('VERA_INSPECTOR_REQUEST_SNAPSHOT').length).toBe(requested + 1);
    expect(bridge.api.routeEpoch).toBe(7);
    expect(bridge.api.reconciling).toBe(true);

    bridge.deliver({
      type: 'VERA_INSPECTOR_SESSION_RESET_ACK',
      requestId: first?.requestId ?? '',
      payload: { routeKey: '/checkout', routeEpoch: 8 },
    });
    expect(bridge.of('VERA_INSPECTOR_REQUEST_SNAPSHOT').length).toBe(requested + 1);
    expect(bridge.api.routeEpoch).toBe(7);

    act(() => bridge.api.resetSession());
    const second = bridge.last('VERA_INSPECTOR_SESSION_RESET');
    expect(second?.requestId).not.toBe(first?.requestId);
    bridge.deliver({
      type: 'VERA_INSPECTOR_ERROR',
      requestId: second?.requestId ?? '',
      payload: { code: 'session-reset-failed', message: 'reset failed' },
    });
    expect(bridge.api.lastError).toBeNull();
    bridge.deliver({
      type: 'VERA_INSPECTOR_SNAPSHOT',
      payload: snapshotPayload({ routeEpoch: 7 }),
    });
    expect(bridge.api.ready).toBe(true);

    act(() => bridge.api.loadTarget(TARGET_URL, FRAME_URL));
    act(() => bridge.api.resetSession());
    expect(bridge.of('VERA_INSPECTOR_SESSION_RESET').length).toBe(2);
  });
});

describe('useBridge bridge presence recovery', () => {
  it('recovers with a fresh correlated handshake without adopting the announcement', () => {
    const bridge = mount();
    bridge.connect();
    expect(bridge.api.ready).toBe(true);
    const helloCount = bridge.of('VERA_INSPECTOR_HELLO').length;

    bridge.deliver({
      type: 'VERA_INSPECTOR_BRIDGE_PRESENT',
      connectionId: 'c2',
      documentGeneration: 'd2',
      sequence: 0,
      payload: {
        bridgeConnectionId: 'c2',
        documentGeneration: 'd2',
        routeKey: '/cart',
        routeEpoch: 1,
      },
    });
    expect(bridge.api.status).toBe('connecting');
    expect(bridge.api.ready).toBe(false);
    expect(bridge.api.snapshot).toBeNull();
    expect(bridge.api.routeEpoch).toBeNull();
    expect(bridge.of('VERA_INSPECTOR_HELLO').length).toBe(helloCount + 1);
    const hello = bridge.last('VERA_INSPECTOR_HELLO');
    expect(hello?.connectionId).toBe('app-pending');

    bridge.connect({ connectionId: 'c2', documentGeneration: 'd2', routeEpoch: 1 });
    expect(bridge.api.ready).toBe(true);
    expect(bridge.api.snapshot?.connectionId).toBe('c2');
    expect(bridge.api.routeEpoch).toBe(1);

    const before = bridge.of('VERA_INSPECTOR_HELLO').length;
    bridge.deliver({
      type: 'VERA_INSPECTOR_BRIDGE_PRESENT',
      connectionId: 'c2',
      documentGeneration: 'd2',
      sequence: 0,
      payload: { bridgeConnectionId: 'c2', documentGeneration: 'd2' },
    });
    expect(bridge.of('VERA_INSPECTOR_HELLO').length).toBe(before);
    expect(bridge.api.ready).toBe(true);
  });

  it('ignores bridge presence from another source, origin, or with mismatched identity', () => {
    const bridge = mount();
    bridge.connect();
    const helloCount = bridge.of('VERA_INSPECTOR_HELLO').length;
    const presence: Incoming = {
      type: 'VERA_INSPECTOR_BRIDGE_PRESENT',
      connectionId: 'c2',
      documentGeneration: 'd2',
      sequence: 0,
      payload: { bridgeConnectionId: 'c2', documentGeneration: 'd2' },
    };
    bridge.deliver({ ...presence, source: window as unknown as MessageEventSource });
    bridge.deliver({ ...presence, origin: 'http://evil.test' });
    bridge.deliver({
      ...presence,
      payload: { bridgeConnectionId: 'c3', documentGeneration: 'd2' },
    });
    bridge.deliver({
      ...presence,
      payload: { bridgeConnectionId: 'c2', documentGeneration: 'd3' },
    });
    bridge.deliver({ ...presence, protocolVersion: 99 });
    expect(bridge.of('VERA_INSPECTOR_HELLO').length).toBe(helloCount);
    expect(bridge.api.ready).toBe(true);
    expect(bridge.api.snapshot?.connectionId).toBe(CONN);
  });

  it('keeps exact origin and source checks for regular bridge messages', () => {
    const bridge = mount();
    bridge.connect();
    const before = bridge.of('VERA_INSPECTOR_REQUEST_SNAPSHOT').length;
    bridge.deliver({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      origin: 'http://evil.test',
      payload: { routeKey: '/cart', routeEpoch: 9 },
    });
    bridge.deliver({
      type: 'VERA_INSPECTOR_ROUTE_CHANGED',
      source: window as unknown as MessageEventSource,
      payload: { routeKey: '/cart', routeEpoch: 9 },
    });
    expect(bridge.api.routeEpoch).toBe(2);
    expect(bridge.of('VERA_INSPECTOR_REQUEST_SNAPSHOT').length).toBe(before);
    expect(bridge.api.ready).toBe(true);
  });
});

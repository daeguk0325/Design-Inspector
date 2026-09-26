import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeApi } from '../hooks/useBridge.ts';
import type { ChatCompletion } from '../hooks/useChat.ts';
import type {
  InspectorAnchor,
  LiveSnapshot,
  PreviewAnchorChange,
  PreviewOperation,
  PreviewResultPayload,
  PreviewResultStatus,
} from '../protocol/types.ts';
import type { ChatMessage, CitationSnapshot, InspectorSession } from '../state/models.ts';
import { MAX_PREVIEW_RULES, MAX_PREVIEW_TARGET } from './contract.ts';
import type { DesignDecision, PreviewTransaction } from './transaction.ts';
import { usePreviewController, type PreviewController } from './controller.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROUTE_KEY = '/orders';

interface ProbeProps {
  bridge: BridgeApi;
  session: InspectorSession | null;
  updateSession: (id: string, patch: (session: InspectorSession) => InspectorSession) => void;
  autoEnabled: boolean;
}

interface ApplyCall {
  bindingId: string;
  transactionId: string;
  changes: readonly PreviewAnchorChange[];
}

interface UndoCall {
  bindingId: string;
  transactionId: string;
}

interface ResetCall {
  bindingId: string;
  transactionIds: readonly string[] | undefined;
}

interface BridgeState {
  ready: boolean;
  cssPreview: boolean;
  sessionBindingId: string | null;
  routeEpoch: number | null;
  documentGeneration: string;
  routeKey: string | undefined;
  applyStatus: PreviewResultStatus;
  undoStatus: PreviewResultStatus;
  resetStatus: PreviewResultStatus;
  applyResponder: (call: ApplyCall) => Promise<PreviewResultPayload>;
  undoResponder: (call: UndoCall) => Promise<PreviewResultPayload>;
  resetResponder: (call: ResetCall) => Promise<PreviewResultPayload>;
}

interface BridgeMock {
  state: BridgeState;
  applyPreview: ReturnType<typeof vi.fn>;
  undoPreview: ReturnType<typeof vi.fn>;
  resetPreviews: ReturnType<typeof vi.fn>;
  api: () => BridgeApi;
}

interface Store {
  list: Map<string, InspectorSession>;
  currentId: string | null;
  updateSession: ReturnType<typeof vi.fn>;
  session: (id: string) => InspectorSession | null;
  current: () => InspectorSession | null;
  switchTo: (id: string | null) => void;
}

interface Harness {
  store: Store;
  bridge: BridgeMock;
  render: (options?: { autoEnabled?: boolean }) => void;
  controller: () => PreviewController;
  settle: (rounds?: number) => Promise<void>;
  transaction: (assistantId: string, sessionId?: string) => PreviewTransaction;
  message: (id: string) => ChatMessage;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function previewResult(
  operation: PreviewOperation,
  status: PreviewResultStatus,
  call: { bindingId: string; transactionId?: string },
): PreviewResultPayload {
  return {
    bindingId: call.bindingId,
    transactionId: call.transactionId ?? '',
    operation,
    status,
    anchors: [],
    routeKey: ROUTE_KEY,
    routeEpoch: 1,
  };
}

function createBridge(): BridgeMock {
  const state: BridgeState = {
    ready: true,
    cssPreview: true,
    sessionBindingId: 's-a',
    routeEpoch: 3,
    documentGeneration: 'doc-1',
    routeKey: ROUTE_KEY,
    applyStatus: 'applied',
    undoStatus: 'undone',
    resetStatus: 'reset',
    applyResponder: (call) => Promise.resolve(previewResult('apply', state.applyStatus, call)),
    undoResponder: (call) => Promise.resolve(previewResult('undo', state.undoStatus, call)),
    resetResponder: (call) => Promise.resolve(previewResult('reset', state.resetStatus, call)),
  };
  const applyPreview = vi.fn((bindingId: string, transactionId: string, changes: readonly PreviewAnchorChange[]) =>
    state.applyResponder({ bindingId, transactionId, changes }),
  );
  const undoPreview = vi.fn((bindingId: string, transactionId: string) =>
    state.undoResponder({ bindingId, transactionId }),
  );
  const resetPreviews = vi.fn((bindingId: string, transactionIds?: readonly string[]) =>
    state.resetResponder({ bindingId, transactionIds }),
  );
  const api = (): BridgeApi => {
    const snapshot: LiveSnapshot = {
      connectionId: 'conn-1',
      documentGeneration: state.documentGeneration,
      inspectorFrozen: false,
      mode: 'html',
      selections: [],
      activeOrder: [],
      capabilities: {
        selectionCrop: true,
        maxSelectionImages: 4,
        maxImageBytes: 4_194_304,
        maxImageDimension: 2_048,
        maxImagePixels: 2_097_152,
        cssPreview: state.cssPreview,
        maxPreviewChanges: MAX_PREVIEW_RULES,
      },
      ...(state.routeKey === undefined ? {} : { routeKey: state.routeKey }),
    };
    return {
      status: 'connected',
      ready: state.ready,
      reconciling: false,
      snapshot: state.ready ? snapshot : null,
      captures: {},
      frozen: false,
      mode: 'html',
      sessionBindingId: state.sessionBindingId,
      routeEpoch: state.routeEpoch,
      iframeRef: { current: null },
      targetUrl: 'http://127.0.0.1:4173/app',
      setTargetUrl: vi.fn(),
      loadTarget: vi.fn(),
      reconnect: vi.fn(),
      bindSession: vi.fn(),
      resetSession: vi.fn(),
      setFrozen: vi.fn(),
      setMode: vi.fn(),
      clearSelection: vi.fn(),
    clearSelectionConfirmed: vi.fn(async () => true),
    reselectSelection: vi.fn(),
    clearAll: vi.fn(),
      captureSelection: vi.fn(),
      pruneCaptures: vi.fn(),
      applyPreview,
      undoPreview,
      resetPreviews,
      lastError: null,
    };
  };
  return { state, applyPreview, undoPreview, resetPreviews, api };
}

function createStore(sessions: InspectorSession[], currentId: string | null): Store {
  const list = new Map(sessions.map((session) => [session.id, session]));
  const store: Store = {
    list,
    currentId,
    updateSession: vi.fn((id: string, patch: (session: InspectorSession) => InspectorSession) => {
      const existing = list.get(id);
      if (!existing) return;
      list.set(id, patch(existing));
    }),
    session: (id) => list.get(id) ?? null,
    current: () => (store.currentId === null ? null : list.get(store.currentId) ?? null),
    switchTo: (id) => {
      store.currentId = id;
    },
  };
  return store;
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(store: Store, bridge: BridgeMock): Harness {
  const holder: { current: PreviewController | null } = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let autoEnabled = true;
  function Probe(props: ProbeProps) {
    holder.current = usePreviewController(props);
    return null;
  }
  const harness: Harness = {
    store,
    bridge,
    render: (options = {}) => {
      if (options.autoEnabled !== undefined) autoEnabled = options.autoEnabled;
      act(() => {
        root.render(
          <Probe
            bridge={bridge.api()}
            session={store.current()}
            updateSession={store.updateSession}
            autoEnabled={autoEnabled}
          />,
        );
      });
    },
    controller: () => {
      if (holder.current === null) throw new Error('the preview controller was not mounted');
      return holder.current;
    },
    settle,
    transaction: (assistantId, sessionId) => {
      const target = sessionId === undefined ? store.current() : store.session(sessionId);
      const found = target?.previewTransactions.find((item) => item.assistantId === assistantId);
      if (!found) throw new Error(`no transaction is tracked for ${assistantId}`);
      return found;
    },
    message: (id) => {
      const found = store.current()?.messages.find((item) => item.id === id);
      if (!found) throw new Error(`no message ${id} in the current session`);
      return found;
    },
  };
  harness.render();
  return harness;
}

function anchor(overrides: Partial<InspectorAnchor> = {}): InspectorAnchor {
  return {
    elementKey: 'button.primary',
    routeKey: ROUTE_KEY,
    mode: 'html',
    tagName: 'button',
    id: 'primary',
    testId: 'primary-button',
    path: '/app/orders',
    ...overrides,
  };
}

function citation(displayNumber: number, withAnchor = true): CitationSnapshot {
  return {
    selectionId: `s${displayNumber}`,
    elementKey: `card.item-${displayNumber}`,
    component: 'OrderCard',
    file: 'src/ui/OrderCard.tsx',
    line: 10 + displayNumber,
    mode: 'html',
    displayNumber,
    ...(withAnchor ? { anchor: anchor({ elementKey: `card.item-${displayNumber}` }) } : {}),
  };
}

function userMessage(id: string, citations: CitationSnapshot[]): ChatMessage {
  return {
    id,
    role: 'user',
    content: '대비를 높여주세요',
    citations,
    pinned: false,
    pinnedAt: null,
    createdAt: 1_000,
  };
}

function assistantMessage(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '## 디자이너 전달문\n\n대비를 높였습니다 [1]\n',
    citations: [],
    pinned: false,
    pinnedAt: null,
    status: 'completed',
    createdAt: 2_000,
  };
}

function session(
  id: string,
  overrides: Partial<InspectorSession> = {},
): InspectorSession {
  return {
    id,
    title: `Session ${id}`,
    targetUrl: 'http://127.0.0.1:4173/app',
    model: 'vision-model',
    messages: [userMessage('u1', [citation(1)]), assistantMessage('a1')],
    previewTransactions: [],
    persistedActiveSelectionIds: ['s1'],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function candidate(rules: Array<{ target: number; declarations?: Record<string, string> }>) {
  return {
    version: 1 as const,
    rules: rules.map((rule) => ({
      target: rule.target,
      declarations: rule.declarations ?? { color: '#111111' },
    })),
  };
}

function completion(overrides: Partial<ChatCompletion> = {}): ChatCompletion {
  return {
    sessionId: 's-a',
    assistantId: 'a1',
    userMessageId: 'u1',
    candidate: candidate([{ target: 1, declarations: { 'border-radius': '10px' } }]),
    citations: [citation(1)],
    content: '## 디자이너 전달문\n\n대비를 높였습니다 [1]\n',
    truncated: false,
    errored: false,
    ...overrides,
  };
}

const PAIR: CitationSnapshot[] = [citation(1), citation(2)];

function pairSession(id: string): InspectorSession {
  return session(id, {
    messages: [userMessage('u1', PAIR), assistantMessage('a1'), assistantMessage('a2')],
  });
}

function pairCompletion(assistantId: 'a1' | 'a2'): ChatCompletion {
  return completion({
    assistantId,
    citations: PAIR,
    candidate: candidate([{ target: assistantId === 'a1' ? 1 : 2, declarations: { color: '#111111' } }]),
  });
}

function applyCalls(bridge: BridgeMock): ApplyCall[] {
  return bridge.applyPreview.mock.calls.map((call) => ({
    bindingId: call[0] as string,
    transactionId: call[1] as string,
    changes: call[2] as readonly PreviewAnchorChange[],
  }));
}

function statusOf(harness: Harness, assistantId: string): {
  status: string | undefined;
  enabled: boolean | undefined;
  changeCount: number | undefined;
  errorCode: string | undefined;
} {
  const entry = harness.controller().previews.get(assistantId);
  return {
    status: entry?.status,
    enabled: entry?.enabled,
    changeCount: entry?.changeCount,
    errorCode: entry?.errorCode,
  };
}

async function applyClean(harness: Harness, next: ChatCompletion = completion()): Promise<void> {
  await act(async () => {
    harness.controller().applyCompletion(next);
  });
  await harness.settle();
  harness.render();
}

describe('preview controller clean completion', () => {
  it('creates a transaction tied to the citation anchors and applies it once', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);

    const transaction = harness.transaction('a1');
    expect(transaction.sessionId).toBe('s-a');
    expect(transaction.assistantId).toBe('a1');
    expect(transaction.userMessageId).toBe('u1');
    expect(transaction.targetUrl).toBe('http://127.0.0.1:4173/app');
    expect(transaction.routeKey).toBe(ROUTE_KEY);
    expect(transaction.status).toBe('applied');
    expect(transaction.enabled).toBe(true);
    expect(transaction.errorCode).toBeUndefined();
    expect(transaction.changes).toHaveLength(1);
    expect(transaction.changes[0]?.target).toBe(1);
    expect(transaction.changes[0]?.anchor).toEqual(citation(1).anchor);
    expect(transaction.changes[0]?.declarations).toEqual({ 'border-radius': '10px' });
    expect(transaction.updatedAt).toBeGreaterThanOrEqual(transaction.createdAt);

    const calls = applyCalls(harness.bridge);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindingId).toBe('s-a');
    expect(calls[0]?.transactionId).toBe(transaction.id);
    expect(calls[0]?.changes).toEqual([
      { anchor: citation(1).anchor, declarations: { 'border-radius': '10px' } },
    ]);
    expect(calls[0]?.changes[0]?.anchor).not.toBe(transaction.changes[0]?.anchor);
    expect(calls[0]?.changes[0]?.declarations).not.toBe(transaction.changes[0]?.declarations);

    expect(harness.message('a1').previewTransactionId).toBe(transaction.id);
    expect(harness.message('u1').previewTransactionId).toBeUndefined();
    expect(statusOf(harness, 'a1')).toEqual({
      status: 'applied',
      enabled: true,
      changeCount: 1,
      errorCode: undefined,
    });
    expect(harness.controller().activeCount).toBe(1);
  });

  it('falls back to the anchor route key when the snapshot has none', async () => {
    const bridge = createBridge();
    bridge.state.routeKey = undefined;
    const harness = mount(createStore([session('s-a')], 's-a'), bridge);
    await applyClean(harness);
    expect(harness.transaction('a1').routeKey).toBe(ROUTE_KEY);
    expect(bridge.applyPreview).toHaveBeenCalledTimes(1);
  });

  it('falls back to an empty route key when neither source has one', async () => {
    const bridge = createBridge();
    bridge.state.routeKey = undefined;
    const citations = [citation(1, false)];
    const harness = mount(
      createStore([session('s-a', { messages: [userMessage('u1', citations), assistantMessage('a1')] })], 's-a'),
      bridge,
    );
    const anchored = citation(1);
    anchored.anchor = { ...anchor(), routeKey: '' };
    await applyClean(harness, completion({ citations: [anchored] }));
    expect(harness.transaction('a1').routeKey).toBe('');
  });

  it('ignores a completion without a preview candidate', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness, completion({ candidate: null }));
    expect(harness.store.current()?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
    expect(harness.controller().activeCount).toBe(0);
  });

  it('ignores a completion whose rules are empty', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness, completion({ candidate: candidate([]) }));
    expect(harness.store.current()?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
  });

  it('ignores an errored or truncated completion', async () => {
    for (const flags of [{ errored: true }, { truncated: true }]) {
      const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
      await applyClean(harness, completion(flags));
      expect({ flags, transactions: harness.store.current()?.previewTransactions }).toEqual({
        flags,
        transactions: [],
      });
      expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
    }
  });

  it('ignores a rule that targets an unknown citation', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness, completion({ candidate: candidate([{ target: 4 }]) }));
    expect(harness.store.current()?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
  });

  it('ignores a citation without an anchor', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness, completion({ citations: [citation(1, false)] }));
    expect(harness.store.current()?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
  });

  it('applies nothing when only one of several rules lacks an anchor', async () => {
    const citations = [citation(1), citation(2, false)];
    const messages = [userMessage('u1', citations), assistantMessage('a1')];
    const harness = mount(
      createStore([session('s-a', { messages })], 's-a'),
      createBridge(),
    );
    await applyClean(
      harness,
      completion({ citations, candidate: candidate([{ target: 1 }, { target: 2 }]) }),
    );
    expect(harness.store.current()?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
    expect(harness.controller().activeCount).toBe(0);
  });

  it('applies nothing while the bridge is not ready or lacks the capability', async () => {
    for (const state of [{ ready: false }, { cssPreview: false }]) {
      const bridge = createBridge();
      Object.assign(bridge.state, state);
      const harness = mount(createStore([session('s-a')], 's-a'), bridge);
      await applyClean(harness);
      expect({ state, transactions: harness.store.current()?.previewTransactions }).toEqual({
        state,
        transactions: [],
      });
      expect(bridge.applyPreview).not.toHaveBeenCalled();
    }
  });

  it('applies nothing while automatic preview is disabled', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    harness.render({ autoEnabled: false });
    await applyClean(harness);
    expect(harness.store.current()?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
  });

  it('suspends rebinding while automatic preview is disabled', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);

    harness.render({ autoEnabled: false });
    harness.bridge.state.routeEpoch = 7;
    harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);

    harness.render({ autoEnabled: true });
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(2);
    expect(harness.transaction('a1').status).toBe('applied');

    harness.bridge.state.routeEpoch = 8;
    harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(3);
    expect(harness.transaction('a1').status).toBe('applied');
  });
});

describe('preview controller caps', () => {
  it('refuses a candidate with more rules than the cap allows', async () => {
    const count = MAX_PREVIEW_RULES + 1;
    const citations = Array.from({ length: count }, (_value, index) => citation(index + 1));
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(
      harness,
      completion({
        citations,
        candidate: candidate(citations.map((_item, index) => ({ target: index + 1 }))),
      }),
    );
    expect(harness.store.current()?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
  });

  it('applies a candidate with exactly the cap number of rules', async () => {
    const count = MAX_PREVIEW_RULES;
    const citations = Array.from({ length: count }, (_value, index) => citation(index + 1));
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(
      harness,
      completion({
        citations,
        candidate: candidate(citations.map((_item, index) => ({ target: index + 1 }))),
      }),
    );
    const transaction = harness.transaction('a1');
    expect(transaction.changes).toHaveLength(MAX_PREVIEW_RULES);
    expect(applyCalls(harness.bridge)[0]?.changes).toHaveLength(MAX_PREVIEW_RULES);
    expect(transaction.status).toBe('applied');
  });

  it('refuses a target outside the citation cap', async () => {
    for (const target of [0, MAX_PREVIEW_TARGET + 1]) {
      const citations = [citation(1), citation(target)];
      const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
      await applyClean(harness, completion({ citations, candidate: candidate([{ target }]) }));
      expect({ target, transactions: harness.store.current()?.previewTransactions }).toEqual({
        target,
        transactions: [],
      });
      expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
    }
  });

  it('applies a rule that targets the highest citation number within the cap', async () => {
    const citations = [citation(1), citation(MAX_PREVIEW_TARGET)];
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness, completion({ citations, candidate: candidate([{ target: MAX_PREVIEW_TARGET }]) }));
    expect(harness.transaction('a1').status).toBe('applied');
  });
});

describe('preview controller session isolation and duplicate suppression', () => {
  it('ignores a completion that belongs to another session', async () => {
    const harness = mount(
      createStore([session('s-a'), session('s-b')], 's-a'),
      createBridge(),
    );
    await applyClean(harness, completion({ sessionId: 's-b' }));
    expect(harness.store.session('s-a')?.previewTransactions).toEqual([]);
    expect(harness.store.session('s-b')?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
  });

  it('keeps previews scoped to the current session across a switch', async () => {
    const harness = mount(
      createStore([session('s-a'), session('s-b')], 's-a'),
      createBridge(),
    );
    await applyClean(harness);
    expect(harness.controller().activeCount).toBe(1);

    harness.store.switchTo('s-b');
    harness.render();
    expect(harness.controller().previews.size).toBe(0);
    expect(harness.controller().activeCount).toBe(0);
    expect(harness.store.session('s-b')?.previewTransactions).toEqual([]);
    expect(applyCalls(harness.bridge).map((call) => call.bindingId)).toEqual(['s-a']);

    harness.store.switchTo('s-a');
    harness.render();
    expect(harness.controller().activeCount).toBe(1);
    expect(harness.transaction('a1').status).toBe('applied');
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);
  });

  it('applies a transaction of the session that becomes current later', async () => {
    const restored: PreviewTransaction = {
      id: 'pv-b',
      assistantId: 'b1',
      userMessageId: 'bu1',
      sessionId: 's-b',
      targetUrl: 'http://127.0.0.1:4173/app',
      routeKey: ROUTE_KEY,
      changes: [{ target: 1, anchor: anchor(), declarations: { color: '#111111' } }],
      enabled: true,
      status: 'pending-rebind',
      createdAt: 5,
      updatedAt: 5,
    };
    const other = session('s-b', { messages: [userMessage('bu1', [citation(1)]), assistantMessage('b1')], previewTransactions: [restored] });
    const harness = mount(createStore([session('s-a'), other], 's-a'), createBridge());
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();

    harness.bridge.state.sessionBindingId = 's-b';
    harness.store.switchTo('s-b');
    harness.render();
    await harness.settle();
    harness.render();
    expect(applyCalls(harness.bridge).map((call) => call.bindingId)).toEqual(['s-b']);
    expect(harness.store.session('s-b')?.previewTransactions[0]?.status).toBe('applied');
    expect(harness.store.session('s-a')?.previewTransactions).toEqual([]);
  });

  it('suppresses a repeated completion for the same assistant message', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    await applyClean(harness);
    expect(harness.store.current()?.previewTransactions).toHaveLength(1);
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);
  });

  it('suppresses repeated applies across re-renders in the same scope', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    for (let index = 0; index < 4; index += 1) harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);
    expect(harness.transaction('a1').status).toBe('applied');
  });

  it('suppresses an overlapping apply for the same transaction', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    let release: (result: PreviewResultPayload) => void = () => {};
    harness.bridge.state.applyResponder = (call) =>
      new Promise<PreviewResultPayload>((resolve) => {
        release = () => resolve(previewResult('apply', 'applied', call));
      });
    await act(async () => {
      harness.controller().applyCompletion(completion());
    });
    harness.bridge.state.documentGeneration = 'doc-2';
    harness.render();
    await harness.settle();
    expect(applyCalls(harness.bridge).map((call) => call.bindingId)).toEqual(['s-a']);
    release(previewResult('apply', 'applied', { bindingId: 's-a', transactionId: 'pv' }));
    await harness.settle();
    harness.render();
    expect(applyCalls(harness.bridge)).toHaveLength(1);
    expect(harness.transaction('a1').status).toBe('applied');
  });
});

describe('preview controller result mapping', () => {
  const cases: Array<[PreviewResultStatus, string, boolean, string | undefined]> = [
    ['applied', 'applied', true, undefined],
    ['unbound', 'unbound', true, undefined],
    ['ambiguous', 'ambiguous', true, undefined],
    ['rejected', 'rejected', false, 'rejected'],
    ['no-op', 'rejected', false, 'no-op'],
  ];

  for (const [resultStatus, expected, enabled, errorCode] of cases) {
    it(`maps a ${resultStatus} result to ${expected}`, async () => {
      const bridge = createBridge();
      bridge.state.applyStatus = resultStatus;
      const harness = mount(createStore([session('s-a')], 's-a'), bridge);
      await applyClean(harness);
      const transaction = harness.transaction('a1');
      expect({ status: transaction.status, enabled: transaction.enabled, errorCode: transaction.errorCode }).toEqual({
        status: expected,
        enabled,
        errorCode,
      });
      expect(statusOf(harness, 'a1')).toEqual({
        status: expected,
        enabled,
        changeCount: 1,
        errorCode,
      });
      expect(harness.controller().activeCount).toBe(enabled ? 1 : 0);
    });
  }

  it('marks a failed apply request as rejected with apply-failed', async () => {
    const bridge = createBridge();
    bridge.state.applyResponder = () => Promise.reject(new Error('Preview request timed out.'));
    const harness = mount(createStore([session('s-a')], 's-a'), bridge);
    await applyClean(harness);
    const transaction = harness.transaction('a1');
    expect({ status: transaction.status, enabled: transaction.enabled, errorCode: transaction.errorCode }).toEqual({
      status: 'rejected',
      enabled: false,
      errorCode: 'apply-failed',
    });
    expect(harness.controller().activeCount).toBe(0);
  });

  it('never reapplies a rejected transaction', async () => {
    const bridge = createBridge();
    bridge.state.applyStatus = 'rejected';
    const harness = mount(createStore([session('s-a')], 's-a'), bridge);
    await applyClean(harness);
    bridge.state.applyStatus = 'applied';
    bridge.state.routeEpoch = 9;
    harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);
    expect(harness.transaction('a1').status).toBe('rejected');
  });

  it('rebinds an unbound transaction after the route changes', async () => {
    const bridge = createBridge();
    bridge.state.applyStatus = 'unbound';
    const harness = mount(createStore([session('s-a')], 's-a'), bridge);
    await applyClean(harness);
    expect(harness.transaction('a1').status).toBe('unbound');
    bridge.state.applyStatus = 'applied';
    bridge.state.routeEpoch = 4;
    harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(2);
    expect(harness.transaction('a1').status).toBe('applied');
  });
});

describe('preview controller undo', () => {
  async function applied(): Promise<Harness> {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    return harness;
  }

  it('undoes the transaction of the addressed assistant message', async () => {
    const harness = await applied();
    const transaction = harness.transaction('a1');
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    expect(harness.bridge.undoPreview).toHaveBeenCalledWith('s-a', transaction.id);
    expect({ status: harness.transaction('a1').status, enabled: harness.transaction('a1').enabled }).toEqual({
      status: 'undone',
      enabled: false,
    });
    expect(statusOf(harness, 'a1')).toEqual({
      status: 'undone',
      enabled: false,
      changeCount: 1,
      errorCode: undefined,
    });
    expect(harness.controller().activeCount).toBe(0);
  });

  it('treats a no-op undo as undone', async () => {
    const harness = await applied();
    harness.bridge.state.undoStatus = 'no-op';
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    expect(harness.transaction('a1').status).toBe('undone');
    expect(harness.transaction('a1').enabled).toBe(false);
  });

  it('keeps the transaction applied when the bridge refuses the undo', async () => {
    const harness = await applied();
    harness.bridge.state.undoStatus = 'rejected';
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    const transaction = harness.transaction('a1');
    expect({ status: transaction.status, enabled: transaction.enabled, errorCode: transaction.errorCode }).toEqual({
      status: 'applied',
      enabled: true,
      errorCode: 'undo-failed',
    });
    expect(harness.controller().activeCount).toBe(1);
  });

  it('keeps the transaction applied when the undo request fails', async () => {
    const harness = await applied();
    harness.bridge.state.undoResponder = () => Promise.reject(new Error('The target changed.'));
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    const transaction = harness.transaction('a1');
    expect({ status: transaction.status, enabled: transaction.enabled, errorCode: transaction.errorCode }).toEqual({
      status: 'applied',
      enabled: true,
      errorCode: 'undo-failed',
    });
  });

  it('ignores an unknown message and an already undone transaction', async () => {
    const harness = await applied();
    await act(async () => {
      await harness.controller().undo('missing');
    });
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    expect(harness.bridge.undoPreview).toHaveBeenCalledTimes(1);
    expect(harness.transaction('a1').status).toBe('undone');
  });

  it('does not reapply an undone transaction after the route changes', async () => {
    const harness = await applied();
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    harness.bridge.state.routeEpoch = 12;
    harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);
    expect(harness.transaction('a1').status).toBe('undone');
  });
});

describe('preview controller reset', () => {
  function withTwoTransactions(): Harness {
    return mount(createStore([pairSession('s-a')], 's-a'), createBridge());
  }

  it('resets every enabled transaction of the current session', async () => {
    const harness = withTwoTransactions();
    await applyClean(harness, pairCompletion('a1'));
    await applyClean(harness, pairCompletion('a2'));
    const first = harness.transaction('a1');
    const second = harness.transaction('a2');
    await act(async () => {
      await harness.controller().reset();
    });
    await harness.settle();
    harness.render();
    expect(harness.bridge.resetPreviews).toHaveBeenCalledWith('s-a', [first.id, second.id]);
    for (const id of [first.id, second.id]) {
      const transaction = harness.store.current()?.previewTransactions.find((item) => item.id === id);
      expect({ status: transaction?.status, enabled: transaction?.enabled }).toEqual({
        status: 'reset',
        enabled: false,
      });
    }
    expect(harness.controller().activeCount).toBe(0);
  });

  it('resets only the transactions that are still enabled', async () => {
    const harness = withTwoTransactions();
    await applyClean(harness, pairCompletion('a1'));
    await applyClean(harness, pairCompletion('a2'));
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    const second = harness.transaction('a2');
    await act(async () => {
      await harness.controller().reset();
    });
    await harness.settle();
    harness.render();
    expect(harness.bridge.resetPreviews).toHaveBeenCalledWith('s-a', [second.id]);
    expect(harness.transaction('a1').status).toBe('undone');
    expect(harness.transaction('a2').status).toBe('reset');
  });

  it('does not reapply a reset transaction after the document generation changes', async () => {
    const harness = withTwoTransactions();
    await applyClean(harness);
    await act(async () => {
      await harness.controller().reset();
    });
    await harness.settle();
    harness.bridge.state.documentGeneration = 'doc-2';
    harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(1);
    expect(harness.transaction('a1').status).toBe('reset');
  });

  it('ignores a reset when nothing is enabled', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await act(async () => {
      await harness.controller().reset();
    });
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    await act(async () => {
      await harness.controller().reset();
    });
    await harness.settle();
    harness.render();
    expect(harness.bridge.resetPreviews).not.toHaveBeenCalled();
  });

  it('marks a no-op reset as reset', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    harness.bridge.state.resetStatus = 'no-op';
    await act(async () => {
      await harness.controller().reset();
    });
    await harness.settle();
    harness.render();
    expect(harness.transaction('a1').status).toBe('reset');
    expect(harness.transaction('a1').enabled).toBe(false);
  });

  it('keeps transactions applied when the reset is refused or fails', async () => {
    for (const failure of ['rejected', 'throw'] as const) {
      const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
      await applyClean(harness);
      if (failure === 'rejected') harness.bridge.state.resetStatus = 'rejected';
      else harness.bridge.state.resetResponder = () => Promise.reject(new Error('Preview request timed out.'));
      await act(async () => {
        await harness.controller().reset();
      });
      await harness.settle();
      harness.render();
      const transaction = harness.transaction('a1');
      expect({ failure, status: transaction.status, enabled: transaction.enabled, errorCode: transaction.errorCode }).toEqual({
        failure,
        status: 'applied',
        enabled: true,
        errorCode: 'reset-failed',
      });
      expect(harness.controller().activeCount).toBe(1);
    }
  });
});

describe('preview controller decisions and lookup', () => {
  it('records a decision on the addressed message only', async () => {
    const messages = [userMessage('u1', [citation(1)]), assistantMessage('a1'), assistantMessage('a2')];
    const harness = mount(createStore([session('s-a', { messages })], 's-a'), createBridge());
    const decisions: DesignDecision[] = ['accepted', 'needs-revision', 'rejected'];
    for (const decision of decisions) {
      await act(async () => {
        harness.controller().decide('a1', decision);
      });
      harness.render();
      expect(harness.message('a1').decision).toBe(decision);
      expect(harness.message('a2').decision).toBeUndefined();
      expect(harness.message('u1').decision).toBeUndefined();
    }
  });

  it('ignores a decision for an unknown message', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    const before = harness.store.current();
    await act(async () => {
      harness.controller().decide('nope', 'accepted');
    });
    harness.render();
    expect(harness.store.current()?.messages).toEqual(before?.messages);
  });

  it('exposes status, change count and error code per assistant message', async () => {
    const harness = mount(createStore([pairSession('s-a')], 's-a'), createBridge());
    harness.bridge.state.applyStatus = 'rejected';
    await applyClean(harness, completion({
      citations: PAIR,
      candidate: candidate([{ target: 1 }, { target: 2 }]),
    }));
    expect(statusOf(harness, 'a1')).toEqual({
      status: 'rejected',
      enabled: false,
      changeCount: 2,
      errorCode: 'rejected',
    });
    expect(harness.controller().previews.has('a2')).toBe(false);
  });

  it('counts only the enabled transactions', async () => {
    const harness = mount(createStore([pairSession('s-a')], 's-a'), createBridge());
    await applyClean(harness, pairCompletion('a1'));
    await applyClean(harness, pairCompletion('a2'));
    expect(harness.controller().activeCount).toBe(2);
    await act(async () => {
      await harness.controller().undo('a1');
    });
    await harness.settle();
    harness.render();
    expect(harness.controller().activeCount).toBe(1);
  });

  it('reports an empty lookup without a session', async () => {
    const harness = mount(createStore([session('s-a')], null), createBridge());
    expect(harness.controller().previews.size).toBe(0);
    expect(harness.controller().activeCount).toBe(0);
    await act(async () => {
      harness.controller().applyCompletion(completion());
      await harness.controller().undo('a1');
      await harness.controller().reset();
      harness.controller().decide('a1', 'accepted');
    });
    harness.render();
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
    expect(harness.bridge.undoPreview).not.toHaveBeenCalled();
    expect(harness.bridge.resetPreviews).not.toHaveBeenCalled();
    expect(harness.store.updateSession).not.toHaveBeenCalled();
    expect(harness.store.session('s-a')?.previewTransactions).toEqual([]);
    expect(harness.store.session('s-a')?.messages[1]?.decision).toBeUndefined();
  });
});

describe('preview controller route scope reapplication', () => {
  it('reapplies enabled transactions after a route epoch change', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    const transaction = harness.transaction('a1');
    harness.bridge.state.routeEpoch = 8;
    harness.render();
    await harness.settle();
    harness.render();
    const calls = applyCalls(harness.bridge);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ bindingId: 's-a', transactionId: transaction.id, changes: calls[0]?.changes });
    expect(harness.transaction('a1').status).toBe('applied');
  });

  it('reapplies enabled transactions after a document generation change', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    harness.bridge.state.documentGeneration = 'doc-2';
    harness.render();
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(2);
    expect(harness.transaction('a1').status).toBe('applied');
  });

  it('reapplies enabled transactions after the bridge binding changes', async () => {
    const harness = mount(createStore([session('s-a')], 's-a'), createBridge());
    await applyClean(harness);
    harness.bridge.state.sessionBindingId = 's-a-2';
    harness.render();
    await harness.settle();
    harness.render();
    expect(applyCalls(harness.bridge).map((call) => call.bindingId)).toEqual(['s-a', 's-a']);
    expect(harness.bridge.applyPreview).toHaveBeenCalledTimes(2);
  });

  it('reapplies every enabled transaction of the current session only', async () => {
    const harness = mount(
      createStore([pairSession('s-a'), session('s-b')], 's-a'),
      createBridge(),
    );
    await applyClean(harness, pairCompletion('a1'));
    await applyClean(harness, pairCompletion('a2'));
    const ids = [harness.transaction('a1').id, harness.transaction('a2').id];
    harness.bridge.state.routeEpoch = 21;
    harness.render();
    await harness.settle();
    harness.render();
    expect(applyCalls(harness.bridge).map((call) => call.transactionId)).toEqual([...ids, ...ids]);
    expect(harness.store.session('s-b')?.previewTransactions).toEqual([]);
  });

  it('applies a restored transaction that was persisted as pending-rebind', async () => {
    const restored: PreviewTransaction = {
      id: 'pv-restored',
      assistantId: 'a1',
      userMessageId: 'u1',
      sessionId: 's-a',
      targetUrl: 'http://127.0.0.1:4173/app',
      routeKey: ROUTE_KEY,
      changes: [{ target: 1, anchor: anchor(), declarations: { color: '#111111' } }],
      enabled: true,
      status: 'pending-rebind',
      createdAt: 5,
      updatedAt: 5,
    };
    const harness = mount(
      createStore([session('s-a', { previewTransactions: [restored] })], 's-a'),
      createBridge(),
    );
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).toHaveBeenCalledWith('s-a', 'pv-restored', [
      { anchor: anchor(), declarations: { color: '#111111' } },
    ]);
    expect(harness.transaction('a1').status).toBe('applied');
  });

  it('leaves a restored disabled transaction untouched', async () => {
    const restored: PreviewTransaction = {
      id: 'pv-restored',
      assistantId: 'a1',
      userMessageId: 'u1',
      sessionId: 's-a',
      targetUrl: 'http://127.0.0.1:4173/app',
      routeKey: ROUTE_KEY,
      changes: [{ target: 1, anchor: anchor(), declarations: { color: '#111111' } }],
      enabled: false,
      status: 'reset',
      createdAt: 5,
      updatedAt: 5,
    };
    const harness = mount(
      createStore([session('s-a', { previewTransactions: [restored] })], 's-a'),
      createBridge(),
    );
    await harness.settle();
    harness.render();
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
    expect(statusOf(harness, 'a1')).toEqual({
      status: 'reset',
      enabled: false,
      changeCount: 1,
      errorCode: undefined,
    });
    expect(harness.controller().activeCount).toBe(0);
  });
});

describe('preview controller stale closures', () => {
  it('ignores a completion delivered through a callback captured before a switch', async () => {
    const harness = mount(createStore([session('s-a'), session('s-b')], 's-a'), createBridge());
    const stale = harness.controller().applyCompletion;
    harness.store.switchTo('s-b');
    harness.bridge.state.sessionBindingId = 's-b';
    harness.render();
    await act(async () => {
      stale(completion());
    });
    await harness.settle();
    harness.render();
    expect(harness.store.session('s-a')?.previewTransactions).toEqual([]);
    expect(harness.store.session('s-b')?.previewTransactions).toEqual([]);
    expect(harness.bridge.applyPreview).not.toHaveBeenCalled();
    expect(harness.controller().activeCount).toBe(0);
  });

  it('ignores an undo requested through a callback captured before a switch', async () => {
    const harness = mount(createStore([session('s-a'), session('s-b')], 's-a'), createBridge());
    await applyClean(harness);
    const stale = harness.controller().undo;
    harness.store.switchTo('s-b');
    harness.render();
    await act(async () => {
      await stale('a1');
    });
    await harness.settle();
    harness.render();
    expect(harness.bridge.undoPreview).not.toHaveBeenCalled();
    expect(harness.transaction('a1', 's-a').status).toBe('applied');
    expect(harness.store.session('s-b')?.previewTransactions).toEqual([]);
  });

  it('ignores a decision recorded through a callback captured before a switch', async () => {
    const harness = mount(createStore([session('s-a'), session('s-b')], 's-a'), createBridge());
    const stale = harness.controller().decide;
    harness.store.switchTo('s-b');
    harness.render();
    await act(async () => {
      stale('a1', 'rejected');
    });
    harness.render();
    expect(harness.store.session('s-b')?.messages[1]?.decision).toBeUndefined();
    expect(harness.store.session('s-a')?.messages[1]?.decision).toBeUndefined();
  });

  it('ignores a reset requested through a callback captured before a switch', async () => {
    const harness = mount(createStore([session('s-a'), session('s-b')], 's-a'), createBridge());
    await applyClean(harness);
    const stale = harness.controller().reset;
    harness.store.switchTo('s-b');
    harness.render();
    await act(async () => {
      await stale();
    });
    await harness.settle();
    harness.render();
    expect(harness.bridge.resetPreviews).not.toHaveBeenCalled();
    expect(harness.transaction('a1', 's-a').status).toBe('applied');
  });

  it('patches the owning session when a result resolves after the switch', async () => {
    const harness = mount(createStore([session('s-a'), session('s-b')], 's-a'), createBridge());
    let release: (result: PreviewResultPayload) => void = () => {};
    harness.bridge.state.applyResponder = (call) =>
      new Promise<PreviewResultPayload>((resolve) => {
        release = () => resolve(previewResult('apply', 'applied', call));
      });
    await act(async () => {
      harness.controller().applyCompletion(completion());
    });
    await harness.settle();
    const owner = harness.store.session('s-a');
    const owned = owner?.previewTransactions[0];
    expect(owned?.status).toBe('pending-rebind');

    harness.store.switchTo('s-b');
    harness.render();
    release(previewResult('apply', 'applied', { bindingId: 's-a', transactionId: owned?.id ?? '' }));
    await harness.settle();
    harness.render();
    expect(applyCalls(harness.bridge).map((call) => call.bindingId)).toEqual(['s-a']);
    expect(harness.store.session('s-a')?.previewTransactions[0]?.status).toBe('applied');
    expect(harness.store.session('s-b')?.previewTransactions).toEqual([]);
    expect(harness.controller().previews.size).toBe(0);
    expect(harness.controller().activeCount).toBe(0);
  });

  it('keeps a late undo result on the owning session', async () => {
    const harness = mount(createStore([session('s-a'), session('s-b')], 's-a'), createBridge());
    await applyClean(harness);
    const owned = harness.store.session('s-a')?.previewTransactions[0];
    let release: (result: PreviewResultPayload) => void = () => {};
    harness.bridge.state.undoResponder = (call) =>
      new Promise<PreviewResultPayload>((resolve) => {
        release = () => resolve(previewResult('undo', 'undone', call));
      });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = harness.controller().undo('a1');
    });
    await harness.settle();
    harness.store.switchTo('s-b');
    harness.render();
    release(previewResult('undo', 'undone', { bindingId: 's-a', transactionId: owned?.id ?? '' }));
    await act(async () => {
      await pending;
    });
    await harness.settle();
    harness.render();
    expect(harness.store.session('s-a')?.previewTransactions[0]?.status).toBe('undone');
    expect(harness.store.session('s-b')?.previewTransactions).toEqual([]);
  });
});

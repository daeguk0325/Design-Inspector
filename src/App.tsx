// Design Inspector Tool — App A. Calm AI workspace (§§0.1, 20).
// Bridge owns live state; App A owns sessions/history/pins (§3).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Header, type ViewportPreset } from './components/Header.tsx';
import { Workspace } from './components/Workspace.tsx';
import { ChatList } from './components/ChatList.tsx';
import { Composer } from './components/Composer.tsx';
import { ComponentDetails } from './components/ComponentDetails.tsx';
import { SplitHandle } from './components/SplitHandle.tsx';
import { SessionsDrawer } from './components/SessionsDrawer.tsx';
import { SettingsDrawer } from './components/SettingsDrawer.tsx';
import { MoreDrawer } from './components/MoreDrawer.tsx';
import { useBridge } from './hooks/useBridge.ts';
import { useSessions } from './hooks/useSessions.ts';
import { useChat } from './hooks/useChat.ts';
import { reconcileActiveSelections } from './state/reconcile.ts';
import type { ChatMessage, MessagePatch } from './state/models.ts';
import { capThinking } from './state/models.ts';
import type { PreviewTransaction } from './preview/transaction.ts';
import { parseInspectorTokenFromSearch, parseTargetFromSearch, stripTargetParam } from './target/fromQuery.ts';
import { createTargetProxyRoute, validateTargetProxyInput } from './supervisor/client.ts';
import { buildAgentPrompt, buildRawTranscript } from './export/serialize.ts';
import { detectVisionCapability } from './ollama/client.ts';
import { isCloudModel } from './ollama/modelSelect.ts';
import {
  buildContactSheet,
  VISUAL_REASON_TEXT,
  type VisualContextItem,
  type VisualPreparation,
} from './ollama/visualContext.ts';import {
  CHAT_RATIO_DEFAULT,
  CHAT_RATIO_MAX,
  CHAT_RATIO_MIN,
  effectiveChatRatio,
  loadChatRatio,
  saveChatRatio,
} from './layout/split.ts';
import { usePreviewController } from './preview/controller.ts';
import { changeLogForSession } from './preview/proposal.ts';
import { ProposalPanel } from './components/ProposalPanel.tsx';
import { cancelChatScroll, chatEdges, smoothChatScroll } from './components/chatScroll.ts';

/** A jump button hides within this many pixels of its edge. */
const CHAT_EDGE_HIDE_PX = 48;

const VIEWPORT_WIDTHS: Record<ViewportPreset, number> = {
  desktop: 1280,
  tablet: 834,
  mobile: 390,
};

/** What a rewind replaced, so it can be put back with one click. */
interface RevertUndoState {
  sessionId: string;
  messages: ChatMessage[];
  previewTransactions: PreviewTransaction[];
  text: string;
}

/**
 * A one-shot instruction to refill the composer. The nonce is what makes the
 * same text seedable twice.
 */
interface ComposerSeed {
  text: string;
  nonce: number;
}

export default function App() {
  const sessions = useSessions();
  const { current } = sessions;
  const bridge = useBridge('');
  const chat = useChat();
  const stopChat = chat.stop;

  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(() => sessions.settings.ollamaBaseUrl);
  const [loadedUrl, setLoadedUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState('initial');
  const [drawer, setDrawer] = useState<'sessions' | 'settings' | 'more' | 'changelog' | null>(null);

  const [copied, setCopied] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [chatRatio, setChatRatio] = useState(loadChatRatio);
  const [splitTrackWidth, setSplitTrackWidth] = useState(0);
  const [splitDragging, setSplitDragging] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [visualNote, setVisualNote] = useState<string | null>(null);
  const [boundSessionId, setBoundSessionId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportPreset>('desktop');
  const [detailsSelectionId, setDetailsSelectionId] = useState<string | null>(null);
  /**
   * A rewind is destructive, so it is reversible rather than confirmed: the
   * state it replaced is kept here until the next send, and the composer gets
   * the original text back either way.
   */
  const [revertUndo, setRevertUndo] = useState<RevertUndoState | null>(null);
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const workRef = useRef<HTMLDivElement | null>(null);
  const targetPaneRef = useRef<HTMLElement | null>(null);
  const chatPaneRef = useRef<HTMLElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [chatJump, setChatJump] = useState({ showTop: false, showBottom: false });

  /**
   * Jump buttons appear only where there is somewhere to go: the top button
   * once the first message has scrolled away, the bottom one once the latest
   * answer is out of view. Near an edge both hide, because a button that
   * scrolls nowhere is decoration.
   */
  const updateChatJump = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const edges = chatEdges(el);
    setChatJump((prev) => {
      const next = {
        showTop: edges.top > CHAT_EDGE_HIDE_PX,
        showBottom: edges.bottom > CHAT_EDGE_HIDE_PX,
      };
      return prev.showTop === next.showTop && prev.showBottom === next.showBottom ? prev : next;
    });
  }, []);

  // Content grows under the list while streaming; the edges move with it.
  useEffect(() => {
    updateChatJump();
  });

  function jumpChatToTop() {
    const el = chatScrollRef.current;
    if (el) smoothChatScroll(el, 0);
  }

  function jumpChatToBottom() {
    const el = chatScrollRef.current;
    if (el) smoothChatScroll(el, el.scrollHeight);
  }
  const currentSessionIdRef = useRef<string | null>(current?.id ?? null);
  currentSessionIdRef.current = current?.id ?? null;
  const preview = usePreviewController({
    bridge,
    session: current,
    updateSession: sessions.updateSession,
    autoEnabled: sessions.settings.autoCssPreview,
  });
  const changeLog = useMemo(() => changeLogForSession(current), [current]);

  const pruneCaptures = bridge.pruneCaptures;
  const captureSelection = bridge.captureSelection;
  const bridgeCaptures = bridge.captures;
  const selectionCrop = bridge.snapshot?.capabilities?.selectionCrop;
  const maxSelectionImages = bridge.snapshot?.capabilities?.maxSelectionImages;

  async function copyText(t: string, done: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(t);
      done(true);
      window.setTimeout(() => done(false), 1600);
    } catch {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const selection = document.getSelection();
      const ranges = selection
        ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
        : [];
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.readOnly = true;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      ta.remove();
      active?.focus({ preventScroll: true });
      for (const range of ranges) document.getSelection()?.addRange(range);
      done(copied);
      if (copied) window.setTimeout(() => done(false), 1600);
    }
  }

  const targetRequestRef = useRef(0);
  const activateTarget = useCallback(
    async (url: string, authorizationToken?: string) => {
      const validationError = validateTargetProxyInput(url);
      if (validationError) {
        setUrlError(validationError);
        return;
      }
      const requestId = ++targetRequestRef.current;
      const sessionIdAtStart = currentSessionIdRef.current;
      setBoundSessionId(null);
      setUrlError(null);
      let canonicalUrl = url.trim();
      let frameUrl: string;
      try {
        const proxyRequestId = Date.now() * 1000 + (requestId % 1000);
        const route = await createTargetProxyRoute(
          canonicalUrl,
          proxyRequestId,
          authorizationToken,
        );
        canonicalUrl = route.targetUrl;
        frameUrl = route.proxyUrl;
      } catch (error) {
        if (requestId === targetRequestRef.current) {
          const detail = error instanceof Error ? ` ${error.message}` : '';
          setUrlError(`Inspector could not create a local proxy.${detail}`);
        }
        return;
      }
      if (requestId !== targetRequestRef.current) return;
      if (sessionIdAtStart !== null && currentSessionIdRef.current !== sessionIdAtStart) return;
      let activeSessionId = currentSessionIdRef.current;
      if (activeSessionId) sessions.retargetSession(activeSessionId, canonicalUrl);
      else activeSessionId = sessions.createSession(canonicalUrl, 'Target session');
      setLoadedUrl(frameUrl);
      bridge.setTargetUrl(canonicalUrl);
      bridge.loadTarget(canonicalUrl, frameUrl);
      bridge.bindSession(activeSessionId);
      setBoundSessionId(activeSessionId);
      setIframeKey(`${activeSessionId}-${canonicalUrl}-${Date.now()}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.id],
  );

  const initialTarget = parseTargetFromSearch(window.location.search);
  const initialToken = parseInspectorTokenFromSearch(window.location.search);
  const targetParamRef = useRef<{ target: string; token: string } | null>(
    initialTarget && initialToken ? { target: initialTarget, token: initialToken } : null,
  );
  const handoffInFlightRef = useRef(false);


  // ?target= (supervisor-opened browser): consume once, then rely on the
  // session target so reloads stay deterministic.

  // First-run auto-provision: create a session with the default Vera URL so the
  // workspace loads itself without manual setup. The sync effect below then
  // loads that URL into the iframe automatically.
  const DEFAULT_VERA_URL = 'http://127.0.0.1:3000';
  const provisionedRef = useRef(false);
  useEffect(() => {
    if (!provisionedRef.current && sessions.sessions.length === 0) {
      provisionedRef.current = true;
      sessions.createSession(DEFAULT_VERA_URL, 'Target session');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setChatError(null);
    setDetailsSelectionId(null);
    stopChat();
  }, [current?.id, stopChat]);

  // Keep bridge target in sync with current session (no cross-session leakage, §14.5).
  useEffect(() => {
    const pending = targetParamRef.current;
    if (pending && current) {
      if (handoffInFlightRef.current) return;
      handoffInFlightRef.current = true;
      targetParamRef.current = null;
      try {
        window.history.replaceState(null, '', stripTargetParam(window.location.href));
      } catch {
        // non-fatal: the param simply stays visible
      }
      void activateTarget(pending.target, pending.token).finally(() => {
        handoffInFlightRef.current = false;
      });
      return;
    }
    if (handoffInFlightRef.current) return;
    if (current && current.targetUrl && current.targetUrl !== bridge.targetUrl) {
      setBoundSessionId(null);
      void activateTarget(current.targetUrl);
    } else if (current && current.targetUrl === bridge.targetUrl && bridge.status === 'connected') {
      if (bridge.sessionBindingId !== current.id) bridge.bindSession(current.id);
      setBoundSessionId(current.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, activateTarget]);

  // Reconcile persisted intent vs live snapshot (§§3.3, 15.2).
  const reconciled = useMemo(
    () => reconcileActiveSelections(current?.persistedActiveSelectionIds ?? [], bridge.snapshot),
    [current?.persistedActiveSelectionIds, bridge.snapshot],
  );
  const targetReady =
    current !== null &&
    boundSessionId === current.id &&
    bridge.sessionBindingId === current.id &&
    !bridge.reconciling &&
    bridge.targetUrl === current.targetUrl &&
    bridge.status === 'connected' &&
    bridge.snapshot !== null;
  const orderedActive = useMemo(
    () => (targetReady ? [...reconciled.active] : []).sort(
      (a, b) =>
        (reconciled.displayNumbers.get(a.selectionId) ?? 0) -
        (reconciled.displayNumbers.get(b.selectionId) ?? 0),
    ),
    [reconciled.active, reconciled.displayNumbers, targetReady],
  );
  const detailsRecord = useMemo(
    () => orderedActive.find((record) => record.selectionId === detailsSelectionId) ?? null,
    [detailsSelectionId, orderedActive],
  );
  const liveVisualBindingRef = useRef<{
    sessionId: string;
    targetUrl: string;
    connectionId: string;
    documentGeneration: string;
    routeEpoch: number | null;
    activeOrder: string[];
  } | null>(null);
  liveVisualBindingRef.current = targetReady && current && bridge.snapshot
    ? {
        sessionId: current.id,
        targetUrl: current.targetUrl,
        connectionId: bridge.snapshot.connectionId,
        documentGeneration: bridge.snapshot.documentGeneration,
        routeEpoch: bridge.routeEpoch,
        activeOrder: [...bridge.snapshot.activeOrder],
      }
    : null;

  useEffect(() => {
    pruneCaptures(orderedActive.map((record) => record.selectionId));
  }, [orderedActive, pruneCaptures]);

  useEffect(() => {
    if (!selectionCrop) return;
    const limit = Math.min(4, maxSelectionImages ?? 0);
    for (const record of orderedActive.slice(0, limit)) {
      if (bridgeCaptures[record.selectionId]) continue;
      void captureSelection(record.selectionId).catch(() => undefined);
    }
  }, [bridgeCaptures, captureSelection, maxSelectionImages, orderedActive, selectionCrop]);

  // Adopt canonical live order into persisted intent when snapshot advances.
  useEffect(() => {
    if (!current || !bridge.snapshot || !targetReady) return;
    const live = bridge.snapshot.activeOrder;
    const prev = current.persistedActiveSelectionIds;
    const same = live.length === prev.length && live.every((id, i) => prev[i] === id);
    if (!same) {
      sessions.updateSession(current.id, (s) => ({ ...s, persistedActiveSelectionIds: [...live], updatedAt: Date.now() }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.snapshot?.activeOrder.join(','), bridge.snapshot?.selections.length, bridge.snapshot?.documentGeneration, bridge.routeEpoch, current?.id, targetReady]);

  const appendMessage = useCallback(
    (sessionId: string, m: ChatMessage) => {
      sessions.updateSession(sessionId, (s) => ({ ...s, messages: [...s.messages, m], updatedAt: Date.now() }));
    },
    [sessions],
  );

  const patchMessage = useCallback(
    (sessionId: string, id: string, patch: MessagePatch) => {
      sessions.updateSession(sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === id
            ? {
                ...m,
                ...('content' in patch ? { content: patch.content ?? m.content } : {}),
                ...(patch.appendContent !== undefined && patch.appendContent !== ''
                  ? { content: m.content + patch.appendContent }
                  : {}),
                ...('thinking' in patch ? { thinking: patch.thinking } : {}),
                ...(patch.appendThinking !== undefined && patch.appendThinking !== ''
                  ? { thinking: capThinking((m.thinking ?? '') + patch.appendThinking) }
                  : {}),
                ...(patch.status ? { status: patch.status } : {}),
                ...(patch.citations ? { citations: patch.citations } : {}),
              }
            : m,
        ),
        updatedAt: Date.now(),
      }));
    },
    [sessions],
  );

  function handleReconnectTarget() {
    const raw = bridge.targetUrl || current?.targetUrl || '';
    if (!raw) {
      setUrlError('No target session is available.');
      return;
    }
    void activateTarget(raw);
  }

  function handleCopyAgent() {
    if (!current) return;
    // Export consumes ONLY raw request + reconciled active + pins + template (§19.2). No AI call.
    const out = buildAgentPrompt({ session: current, active: orderedActive });
    void copyText(out, setCopied);
  }

  const sessionModel = current?.model || sessions.settings.globalModel || '';

  /**
   * Puts a rewound conversation back, re-applying the previews that were live
   * at the time. Replay is what makes this honest: restoring only the messages
   * would leave the page unstyled while the log claimed changes were applied.
   */
  async function undoRevert() {
    const state = revertUndo;
    if (!state) return;
    setRevertUndo(null);
    sessions.updateSession(state.sessionId, (s) => ({
      ...s,
      messages: state.messages,
      previewTransactions: state.previewTransactions,
      updatedAt: Date.now(),
    }));
    const replay = state.previewTransactions.filter(
      (transaction) => transaction.enabled && transaction.sessionId === state.sessionId,
    );
    if (replay.length === 0) return;
    try {
      await bridge.resetPreviews(
        state.sessionId,
        replay.map((transaction) => transaction.id),
      );
    } catch {
      setChatError('Previews could not be restored. The conversation was rewound back anyway.');
    }
  }

  /**
   * Named failure reasons, not a bare `undefined`. The composer blocks on this
   * call, and a silent undefined is what left the Send button reading
   * "Preparing…" with nothing to show for it.
   */
  async function prepareVisualContext(): Promise<VisualPreparation> {
    if (orderedActive.length === 0) return { ok: false, reason: 'no-selection' };
    const maxImages = Math.min(4, bridge.snapshot?.capabilities?.maxSelectionImages ?? 0);
    if (maxImages < 1) return { ok: false, reason: 'bridge-has-no-image-support' };
    if (!bridge.snapshot?.capabilities?.selectionCrop) return { ok: false, reason: 'target-cannot-capture' };
    const expectedBinding = liveVisualBindingRef.current;
    if (!expectedBinding) return { ok: false, reason: 'target-not-ready' };
    const bindingMatches = () => {
      const live = liveVisualBindingRef.current;
      return live !== null &&
        live.sessionId === expectedBinding.sessionId &&
        live.targetUrl === expectedBinding.targetUrl &&
        live.connectionId === expectedBinding.connectionId &&
        live.documentGeneration === expectedBinding.documentGeneration &&
        live.routeEpoch === expectedBinding.routeEpoch &&
        live.activeOrder.join(',') === expectedBinding.activeOrder.join(',');
    };
    let endpoint: URL;
    try {
      endpoint = new URL(ollamaBaseUrl);
    } catch {
      return { ok: false, reason: 'invalid-endpoint' };
    }
    if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
      return { ok: false, reason: 'invalid-endpoint' };
    }
    // Loopback only: screenshots of someone else's page must not be posted to
    // a remote host by a mistyped settings field.
    const loopback = endpoint.hostname === 'localhost' ||
      endpoint.hostname === '[::1]' ||
      /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(endpoint.hostname);
    if (!loopback) return { ok: false, reason: 'endpoint-not-local' };
    const cloudForwarded = isCloudModel(sessionModel);
    let vision: 'yes' | 'no' | 'unknown' = 'unknown';
    try {
      vision = await detectVisionCapability(
        ollamaBaseUrl,
        sessionModel,
        AbortSignal.timeout(8000),
      );
    } catch {
      return { ok: false, reason: 'model-lookup-failed' };
    }
    if (!bindingMatches()) return { ok: false, reason: 'selection-changed' };
    if (vision === 'no') return { ok: false, reason: 'model-cannot-see' };
    const selected = orderedActive.slice(0, maxImages);
    const settled = await Promise.allSettled(
      selected.map((record) => bridge.captureSelection(record.selectionId)),
    );
    if (!bindingMatches()) return { ok: false, reason: 'selection-changed' };
    const items: VisualContextItem[] = [];
    settled.forEach((result, index) => {
      const record = selected[index];
      if (!record || result.status !== 'fulfilled') return;
      items.push({
        selectionId: record.selectionId,
        displayNumber: reconciled.displayNumbers.get(record.selectionId) ?? index + 1,
        component: record.component,
        result: result.value,
      });
    });
    if (items.length === 0) return { ok: false, reason: 'capture-failed' };
    const included = new Set(items.map((item) => item.selectionId));
    const unavailableCitations = orderedActive
      .map((record, index) => included.has(record.selectionId) ? null : (reconciled.displayNumbers.get(record.selectionId) ?? index + 1))
      .filter((number): number is number => number !== null);
    let contactSheet: string | null = null;
    try {
      contactSheet = await buildContactSheet(items);
    } catch {
      contactSheet = null;
    }
    if (!bindingMatches()) return { ok: false, reason: 'selection-changed' };
    const images: string[] = [];
    const imageKinds: Array<'contact-sheet' | 'crop'> = [];
    const citationNumbers: Array<number | null> = [];
    if (contactSheet) {
      images.push(contactSheet);
      imageKinds.push('contact-sheet');
      citationNumbers.push(null);
    }
    for (const item of items) {
      const nextLength = images.reduce((sum, image) => sum + image.length, 0) + item.result.base64.length;
      if (nextLength > 2_800_000) {
        unavailableCitations.push(item.displayNumber);
        continue;
      }
      images.push(item.result.base64);
      imageKinds.push('crop');
      citationNumbers.push(item.displayNumber);
    }
    if (images.length === 0) return { ok: false, reason: 'image-budget-exceeded' };
    return {
      ok: true,
      transmission: {
        endpoint: ollamaBaseUrl,
        model: sessionModel,
        images,
        citationNumbers,
        imageKinds,
        unavailableCitations,
        cloudForwarded,
      },
    };
  }

  const commitChatRatio = useCallback((value: number) => {
    setChatRatio(value);
    saveChatRatio(value);
  }, []);
  const resetChatRatio = useCallback(() => commitChatRatio(CHAT_RATIO_DEFAULT), [commitChatRatio]);
  const getSplitTrackWidth = useCallback(
    () => (targetPaneRef.current?.offsetWidth ?? 0) + (chatPaneRef.current?.offsetWidth ?? 0),
    [],
  );
  const getChatWidth = useCallback(() => chatPaneRef.current?.offsetWidth ?? 0, []);
  const effectiveSplitRatio = effectiveChatRatio(chatRatio, splitTrackWidth);
  const effectiveSplitMin = effectiveChatRatio(CHAT_RATIO_MIN, splitTrackWidth);
  const effectiveSplitMax = effectiveChatRatio(CHAT_RATIO_MAX, splitTrackWidth);

  useEffect(() => {
    const work = workRef.current;
    if (!work) return;
    const update = () => {
      const targetWidth = targetPaneRef.current?.offsetWidth ?? 0;
      const chatWidth = chatPaneRef.current?.offsetWidth ?? 0;
      setSplitTrackWidth(targetWidth + chatWidth);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(work);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div className="app">
      <Header
        status={bridge.status}
        ready={bridge.ready}
        frozen={bridge.frozen}
        mode={bridge.mode}
        onModeChange={bridge.setMode}
        onToggleFreeze={() => bridge.setFrozen(!bridge.frozen)}
        onReconnect={handleReconnectTarget}
        onCopyAgent={handleCopyAgent}
        canCopyAgent={targetReady}
        copied={copied}
        onOpenSessions={() => setDrawer('sessions')}
        onOpenSettings={() => setDrawer('settings')}
        onOpenMore={() => setDrawer('more')}
        sessionCount={sessions.sessions.length}
        previewCount={preview.activeCount}
        pendingCount={preview.pendingCount}
        changeCount={changeLog.length}
        onOpenChangeLog={() => setDrawer('changelog')}
        onResetPreviews={() => void preview.reset()}

        viewport={viewport}
        onViewportChange={setViewport}
      />

      <div
        ref={workRef}
        className="work"
        data-resizing={splitDragging ? 'true' : undefined}
        style={{
          '--target-grow': 1 - effectiveSplitRatio,
          '--chat-grow': effectiveSplitRatio,
        } as CSSProperties}
      >
        <Workspace
          paneRef={targetPaneRef}
          iframeRef={bridge.iframeRef}
          loadedUrl={loadedUrl}
          urlError={urlError}
          iframeKey={iframeKey}
          onFrameLoad={bridge.reconnect}
          viewportWidth={VIEWPORT_WIDTHS[viewport]}
        />

        <SplitHandle
          value={effectiveSplitRatio}
          min={effectiveSplitMin}
          max={effectiveSplitMax}
          onPreview={setChatRatio}
          onCommit={commitChatRatio}
          onReset={resetChatRatio}
          onDraggingChange={setSplitDragging}
          getTrackWidth={getSplitTrackWidth}
          getChatWidth={getChatWidth}
        />

        <section id="chat-pane" ref={chatPaneRef} className="chat-pane" aria-label="AI conversation">
          {sessions.empty ? (
            <div className="messages">
              <div className="empty-chat">
                <div className="empty-mark" aria-hidden="true">✦</div>
                <h3>Welcome to Design Inspector</h3>
                <p>Create your first session, then freeze the target and select components.</p>
                <div className="empty-ex">
                  <button
                    type="button"
                    onClick={() => {
                      const id = sessions.createSession(bridge.targetUrl || 'http://127.0.0.1:3000');
                      void id;
                    }}
                  >
                    + New session
                  </button>
                </div>
              </div>
            </div>
          ) : current ? (
            <div
              className="chat-scroll"
              onWheelCapture={() => {
                const el = chatScrollRef.current;
                if (el) cancelChatScroll(el);
              }}
            >
              <ChatList
                messages={current.messages}
                streaming={chat.streaming}
                previews={preview.previews}
                onDecision={preview.decide}
                onUndoPreview={(messageId) => void preview.undo(messageId)}
                onCopy={(t) => void copyText(t, () => undefined)}
                onCite={bridge.reselectSelection}
                scrollRef={chatScrollRef}
                onListScroll={updateChatJump}
                onRevert={(userMsg) => {
                const text = userMsg.content;
                if (!current) return;
                void (async () => {
                  const snapshot = await preview.revertTo(userMsg.id);
                  if (!snapshot) return;
                  setRevertUndo({
                    sessionId: current.id,
                    messages: snapshot.messages,
                    previewTransactions: snapshot.previewTransactions,
                    text,
                  });
                  setComposerSeed({ text, nonce: Date.now() });
                })();
              }}
              />
              <button
                type="button"
                className="chat-jump-btn jump-top"
                data-hidden={chatJump.showTop ? 'false' : 'true'}
                tabIndex={chatJump.showTop ? 0 : -1}
                aria-label="채팅 맨 위로"
                title="맨 위로"
                onClick={jumpChatToTop}
              >
                <span className="arrow" aria-hidden="true">▲</span>
                <span>맨 위</span>
              </button>
              <button
                type="button"
                className="chat-jump-btn jump-bottom"
                data-hidden={chatJump.showBottom ? 'false' : 'true'}
                tabIndex={chatJump.showBottom ? 0 : -1}
                aria-label="채팅 맨 아래로"
                title="맨 아래로"
                onClick={jumpChatToBottom}
              >
                <span className="arrow" aria-hidden="true">▼</span>
                <span>맨 아래</span>
              </button>
            </div>
          ) : null}

          {detailsRecord && (
            <div className="details-popover">
              <button type="button" className="iconbtn details-close" aria-label="Close component details" onClick={() => setDetailsSelectionId(null)}>×</button>
              <ComponentDetails record={detailsRecord} />
            </div>
          )}

          {revertUndo && (
            <div className="revert-undo" role="status">
              <span className="revert-undo-text">Conversation rewound. The text is back in the composer.</span>
              <button type="button" className="mini" onClick={() => void undoRevert()}>
                Undo rewind
              </button>
              <button
                type="button"
                className="mini icon-btn"
                aria-label="Dismiss undo rewind"
                onClick={() => setRevertUndo(null)}
              >
                ×
              </button>
            </div>
          )}

          <Composer
            key={`${current?.id ?? 'no-session'}:${composerSeed?.nonce ?? 0}`}

            streaming={chat.streaming}
            canSend={targetReady}
            targetReady={targetReady}
            selections={orderedActive}
            displayNumbers={reconciled.displayNumbers}
            captures={bridge.captures}
            maxSelectionCount={4}
            onRemove={bridge.clearSelectionConfirmed}
            onRestore={bridge.reselectSelection}
            onRefresh={(selectionId) => {
              void bridge.captureSelection(selectionId).catch(() => undefined);
            }}
            onOpenDetails={setDetailsSelectionId}
            onClear={bridge.clearAll}
            error={chatError ?? bridge.lastError}
            visualNote={visualNote}
            seed={composerSeed}
            onSend={async (text) => {
              if (!current) return false;
              if (!sessionModel) {
                setChatError('Select an Ollama model in Settings first.');
                return false;
              }
              setChatError(null);
              setVisualNote(null);
              setRevertUndo(null);
              try {
                // Settle before the prompt is built: an undecided proposal is
                // rejected by the act of moving on, and the next request has to
                // see that decision, not a still-pending preview.
                const settled = await preview.settlePending();
                const messages = settled?.messages ?? current.messages;
                const transactions = settled?.transactions ?? current.previewTransactions;
                const prepared = await prepareVisualContext();
                if (!prepared.ok) {
                  setVisualNote(VISUAL_REASON_TEXT[prepared.reason]);
                } else if (prepared.transmission.cloudForwarded === true) {
                  setVisualNote(VISUAL_REASON_TEXT['cloud-forwarded']);
                }
                return await chat.send(
                  current.id,
                  text,
                  orderedActive,
                  reconciled.displayNumbers,
                  prepared.ok ? prepared.transmission : undefined,
                  appendMessage,
                  patchMessage,
                  messages,
                  ollamaBaseUrl,
                  sessionModel,
                  preview.applyCompletion,
                  transactions,
                  sessions.settings.generation,
                );
              } catch (error) {
                setChatError(error instanceof Error ? error.message : 'Visual context could not be prepared.');
                return false;
              }
            }}
            onStop={chat.stop}
          />
        </section>
      </div>

      <SessionsDrawer api={sessions} open={drawer === 'sessions'} onClose={() => setDrawer(null)} />
      <ProposalPanel
        open={drawer === 'changelog'}
        session={current}
        onClose={() => setDrawer(null)}
        onCopy={(text) => void copyText(text, () => undefined)}
      />

      <SettingsDrawer
        open={drawer === 'settings'}
        onClose={() => setDrawer(null)}
        baseUrl={ollamaBaseUrl}
        model={current?.model ?? ''}
        globalModel={sessions.settings.globalModel}
        autoCssPreview={sessions.settings.autoCssPreview}
        generation={sessions.settings.generation}
        onSave={(url, sessModel, gm, autoPreview, generation) => {
          setOllamaBaseUrl(url);
          sessions.setSettings({ ollamaBaseUrl: url, globalModel: gm, autoCssPreview: autoPreview, generation });
          if (current && sessModel !== current.model) {
            sessions.updateSession(current.id, (s) => ({ ...s, model: sessModel }));
          }
        }}
      />
      <MoreDrawer
        open={drawer === 'more'}
        onClose={() => setDrawer(null)}
        session={current}
        snapshot={bridge.snapshot}
        status={bridge.status}
        onCopyRaw={() => {
          if (current) void copyText(buildRawTranscript(current), setCopiedRaw);
        }}
        copiedRaw={copiedRaw}
      />
    </div>
  );
}

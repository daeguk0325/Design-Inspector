// App A bridge connection hook (§§7,8,9).
// Owns: handshake retry, heartbeat/liveness, snapshot reconciliation requests,
// explicit FREEZE set commands, selection clearing. Never invents selectionIds.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PROTOCOL_VERSION } from '../protocol/types.ts';
import type {
  BridgeKind,
  CaptureResultPayload,
  ErrorPayload,
  HelloAckPayload,
  InspectorMode,
  LiveSnapshot,
  PreviewAnchorChange,
  PreviewResultPayload,
  RouteChangedPayload,
  SelectionRecord,
  SessionResetAckPayload,
} from '../protocol/types.ts';
import {
  isExpectedSource,
  makeRequestId,
  targetOriginFor,
  validateBridgeMessage,
} from '../protocol/validate.ts';
import { matchesFreezeShortcut } from '../shortcut.ts';

export type ConnStatus = 'connecting' | 'connected' | 'unavailable' | 'stale' | 'disconnected' | 'timed_out';

const HELLO_RETRY_MS = 1200;
const HELLO_UNAVAILABLE_MS = 5000;
const HEARTBEAT_MS = 4000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const PREVIEW_TIMEOUT_MS = 10_000;
const SESSION_RESET_TIMEOUT_MS = 10_000;
const MAX_PENDING_PREVIEWS = 8;
const MAX_PENDING_SESSION_RESETS = 8;
const CAPTURE_CANCELLED = 'Capture cancelled.';

let localSeq = 0;

export interface SelectionCapture {
  selectionId: string;
  status: 'capturing' | 'ready' | 'error';
  result?: CaptureResultPayload;
  error?: string;
}

interface RequestScope {
  sessionBindingId: string | null;
  bindingGeneration: number;
  connectionId: string | null;
  documentGeneration: string | null;
  routeEpoch: number | null;
}

interface PendingCapture extends RequestScope {
  selectionId: string;
  resolve: (result: CaptureResultPayload) => void;
  reject: (error: Error) => void;
  timer: number;
}

interface PendingPreview extends RequestScope {
  bindingId: string;
  expectedTransactionId: string | null;
  resolve: (result: PreviewResultPayload) => void;
  reject: (error: Error) => void;
  timer: number;
}

export interface BridgeApi {
  status: ConnStatus;
  ready: boolean;
  reconciling: boolean;
  snapshot: LiveSnapshot | null;
  captures: Record<string, SelectionCapture>;
  frozen: boolean;
  mode: InspectorMode;
  sessionBindingId: string | null;
  routeEpoch: number | null;
  /**
   * Bumped on every `resetSession`. The Bridge tears down every preview layer
   * on reset without touching `routeEpoch`, so a consumer that keys "have I
   * already applied this?" on session + route + document alone reconstructs an
   * identical key after an A→B→A round trip and refuses to re-apply a layer the
   * Bridge no longer holds.
   *
   * This is the same counter `scopeIsCurrent` checks first; it is exposed here
   * only so the preview controller can put it in its own claim key.
   */
  bindingGeneration: number;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  targetUrl: string;
  setTargetUrl: (u: string) => void;
  loadTarget: (target: string, frameUrl?: string) => void;
  reconnect: () => void;
  bindSession: (sessionId: string) => void;
  resetSession: () => void;
  setFrozen: (active: boolean) => void;
  setMode: (m: InspectorMode) => void;
  clearSelection: (id: string) => void;
  clearSelectionConfirmed: (id: string, timeoutMs?: number) => Promise<boolean>;
  /**
   * Re-activates a previously deselected selection, keeping its id. An undo in
   * the composer restores the tag, and the target outline has to come back with
   * it. Fire and forget: the `VERA_INSPECTOR_SELECTION` event carries the
   * record, so the tray updates on the bridge's own confirmation.
   */
  reselectSelection: (id: string) => void;
  clearAll: () => void;
  captureSelection: (selectionId: string) => Promise<CaptureResultPayload>;
  pruneCaptures: (selectionIds: string[]) => void;
  applyPreview: (
    bindingId: string,
    transactionId: string,
    changes: readonly PreviewAnchorChange[],
  ) => Promise<PreviewResultPayload>;
  undoPreview: (bindingId: string, transactionId: string) => Promise<PreviewResultPayload>;
  resetPreviews: (
    bindingId: string,
    transactionIds?: readonly string[],
  ) => Promise<PreviewResultPayload>;
  lastError: string | null;
}

type PreviewCommandType =
  | 'VERA_INSPECTOR_PREVIEW_APPLY'
  | 'VERA_INSPECTOR_PREVIEW_UNDO'
  | 'VERA_INSPECTOR_PREVIEW_RESET';

function messageTypeOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const type = (raw as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : null;
}

function preValidateBridgePresent(raw: unknown): boolean {
  if (messageTypeOf(raw) !== 'VERA_INSPECTOR_BRIDGE_PRESENT') return false;
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  const connectionId = record['connectionId'];
  const documentGeneration = record['documentGeneration'];
  if (typeof connectionId !== 'string' || connectionId === '') return false;
  if (typeof documentGeneration !== 'string' || documentGeneration === '') return false;
  return validateBridgeMessage(raw, {
    expectedConnectionId: connectionId,
    expectedDocumentGeneration: documentGeneration,
    lastSequence: 0,
    expectedRouteEpoch: null,
  }).ok;
}

function isRouteEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function useBridge(initialUrl: string): BridgeApi {
  const [targetUrl, setTargetUrl] = useState(initialUrl);
  const [loadedUrl, setLoadedUrl] = useState<string>('');
  const [status, setStatus] = useState<ConnStatus>('disconnected');
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [captures, setCaptures] = useState<Record<string, SelectionCapture>>({});
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [sessionBindingId, setSessionBindingId] = useState<string | null>(null);
  const [routeEpoch, setRouteEpoch] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * Whether the frame has finished navigating to the target. A frame still on
   * its previous document sits on `about:blank` and inherits the app's origin,
   * so a post aimed at the target origin is refused and logged.
   */
  const frameLoadedRef = useRef(false);
  const pendingCapturesRef = useRef(new Map<string, PendingCapture>());
  const pendingPreviewsRef = useRef(new Map<string, PendingPreview>());
  const pendingSessionResetsRef = useRef(new Map<string, number>());
  const pendingClearsRef = useRef(new Map<string, { settle: (cleared: boolean) => void }>());
  const pendingHelloRef = useRef(new Set<string>());

  const connIdRef = useRef<string | null>(null);
  const docGenRef = useRef<string | null>(null);
  const activeBridgeKindRef = useRef<BridgeKind | null>(null);
  const helloStartedAtRef = useRef(0);
  const seqRef = useRef(0);
  const lastPongRef = useRef(0);
  const frozenRef = useRef(false);
  const modeRef = useRef<InspectorMode>('html');
  const reconcilingRef = useRef(false);
  const sessionBindingIdRef = useRef<string | null>(null);
  const bindingGenerationRef = useRef(0);
  const routeEpochRef = useRef<number | null>(null);
  const helloTimer = useRef<number | null>(null);
  const hbTimer = useRef<number | null>(null);
  const hbTimeoutTimer = useRef<number | null>(null);

  const frozen = snapshot?.inspectorFrozen ?? false;
  const mode = snapshot?.mode ?? modeRef.current;
  const ready = status === 'connected' && snapshot !== null && !reconciling;
  const readyRef = useRef(ready);
  const statusRef = useRef(status);
  useLayoutEffect(() => {
    frozenRef.current = frozen;
    readyRef.current = ready;
  }, [frozen, ready]);

  /** Resolves any in-flight deselect confirmations against a fresh snapshot. */
  const settlePendingClears = (next: LiveSnapshot | null): void => {
    if (pendingClearsRef.current.size === 0) return;
    const stillActive = new Set(
      (next?.selections ?? []).filter((s) => s.state === 'active').map((s) => s.selectionId),
    );
    for (const [id, entry] of [...pendingClearsRef.current]) {
      if (stillActive.has(id)) continue;
      entry.settle(true);
    }
  };

  useEffect(() => {
    if (lastError === null) return;
    const timer = window.setTimeout(() => setLastError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [lastError]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const post = useCallback(
    (type: string, payload: unknown) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return null;
      const origin = loadedUrl ? targetOriginFor(loadedUrl) : null;
      if (!origin) return null;
      // The target URL is set before the frame has navigated to it, and a frame
      // still on its previous document is on `about:blank`, which inherits the
      // parent's origin. Posting then is not a silent no-op: the browser refuses
      // the origin check, logs an error, and drops the message. It self-healed
      // through the load handler, which is why this was only ever console noise —
      // but the handshake was relying on a retry to cover its own race.
      if (!frameLoadedRef.current) return null;
      localSeq += 1;
      const requestId = makeRequestId();
      iframe.contentWindow.postMessage(
        {
          protocolVersion: PROTOCOL_VERSION,
          type,
          connectionId: connIdRef.current ?? 'app-pending',
          documentGeneration: docGenRef.current ?? 'app-pending',
          requestId,
          sequence: localSeq,
          payload,
        },
        origin,
      );
      return requestId;
    },
    [loadedUrl],
  );

  const setReconcilingState = useCallback((value: boolean) => {
    reconcilingRef.current = value;
    setReconciling(value);
  }, []);

  const resetRouteEpoch = useCallback(() => {
    routeEpochRef.current = null;
    setRouteEpoch(null);
  }, []);

  const adoptRouteEpoch = useCallback((epoch: unknown, replace = false) => {
    if (!isRouteEpoch(epoch)) return;
    const current = routeEpochRef.current;
    if (!replace && current !== null && epoch < current) return;
    routeEpochRef.current = epoch;
    setRouteEpoch(epoch);
  }, []);

  const currentRequestScope = useCallback((): RequestScope => ({
    sessionBindingId: sessionBindingIdRef.current,
    bindingGeneration: bindingGenerationRef.current,
    connectionId: connIdRef.current,
    documentGeneration: docGenRef.current,
    routeEpoch: routeEpochRef.current,
  }), []);

  const scopeIsCurrent = useCallback((scope: RequestScope): boolean => {
    if (scope.bindingGeneration !== bindingGenerationRef.current) return false;
    if (scope.sessionBindingId !== sessionBindingIdRef.current) return false;
    if (connIdRef.current === null || docGenRef.current === null) return false;
    if (scope.connectionId !== connIdRef.current) return false;
    if (scope.documentGeneration !== docGenRef.current) return false;
    if (
      scope.routeEpoch !== null &&
      routeEpochRef.current !== null &&
      scope.routeEpoch !== routeEpochRef.current
    ) {
      return false;
    }
    return true;
  }, []);

  const cancelPendingCaptures = useCallback((reason: string) => {
    for (const [requestId, pending] of pendingCapturesRef.current) {
      window.clearTimeout(pending.timer);
      pendingCapturesRef.current.delete(requestId);
      pending.reject(new Error(reason));
    }
  }, []);

  const cancelPendingPreviews = useCallback(
    (reason: string, stale?: (pending: PendingPreview) => boolean) => {
      for (const [requestId, pending] of pendingPreviewsRef.current) {
        if (stale !== undefined && !stale(pending)) continue;
        window.clearTimeout(pending.timer);
        pendingPreviewsRef.current.delete(requestId);
        pending.reject(new Error(reason));
      }
    },
    [],
  );

  const dropStalePreviews = useCallback(
    (nextEpoch: number) => {
      cancelPendingPreviews(
        'The target route changed.',
        (pending) => pending.routeEpoch !== null && pending.routeEpoch < nextEpoch,
      );
    },
    [cancelPendingPreviews],
  );

  const clearCaptures = useCallback(
    (reason: string = CAPTURE_CANCELLED) => {
      cancelPendingCaptures(reason);
      setCaptures({});
    },
    [cancelPendingCaptures],
  );

  const clearPendingSessionResets = useCallback(() => {
    for (const timer of pendingSessionResetsRef.current.values()) {
      window.clearTimeout(timer);
    }
    pendingSessionResetsRef.current.clear();
  }, []);

  const postSessionReset = useCallback(() => {
    if (connIdRef.current === null) return;
    const requestId = post('VERA_INSPECTOR_SESSION_RESET', {});
    if (!requestId) return;
    clearPendingSessionResets();
    while (pendingSessionResetsRef.current.size >= MAX_PENDING_SESSION_RESETS) {
      const oldest = pendingSessionResetsRef.current.keys().next();
      if (oldest.done) break;
      const timer = pendingSessionResetsRef.current.get(oldest.value);
      if (timer !== undefined) window.clearTimeout(timer);
      pendingSessionResetsRef.current.delete(oldest.value);
    }
    const timer = window.setTimeout(() => {
      pendingSessionResetsRef.current.delete(requestId);
    }, SESSION_RESET_TIMEOUT_MS);
    pendingSessionResetsRef.current.set(requestId, timer);
  }, [post, clearPendingSessionResets]);

  const requestSnapshot = useCallback(() => {
    post('VERA_INSPECTOR_REQUEST_SNAPSHOT', {});
  }, [post]);

  const requestFreshSnapshot = useCallback(() => {
    if (connIdRef.current === null) return;
    requestSnapshot();
  }, [requestSnapshot]);

  const sendHello = useCallback(() => {
    const requestId = post('VERA_INSPECTOR_HELLO', {
      appOrigin: window.location.origin,
    });
    if (requestId) {
      pendingHelloRef.current.add(requestId);
      setStatus((s) => (s === 'connected' || s === 'unavailable' ? s : 'connecting'));
    }
  }, [post]);

  const restartHelloRetry = useCallback(() => {
    if (helloTimer.current) window.clearInterval(helloTimer.current);
    helloTimer.current = window.setInterval(() => {
      if (connIdRef.current === null) {
        if (Date.now() - helloStartedAtRef.current >= HELLO_UNAVAILABLE_MS) {
          setStatus((current) => (current === 'connecting' ? 'unavailable' : current));
        }
        sendHello();
      }
    }, HELLO_RETRY_MS);
  }, [sendHello]);

  const reconnect = useCallback(() => {
    // The frame's load event is what makes posting to it legal, so this is also
    // where the flag that `post` checks gets set.
    frameLoadedRef.current = true;
    pendingHelloRef.current.clear();
    clearPendingSessionResets();
    clearCaptures();
    cancelPendingPreviews('The target Bridge reconnected.');
    // §8.4: invalidate stale assumptions, fresh handshake + reconciliation.
    connIdRef.current = null;
    docGenRef.current = null;
    activeBridgeKindRef.current = null;
    seqRef.current = 0;
    modeRef.current = 'html';
    helloStartedAtRef.current = Date.now();
    resetRouteEpoch();
    setSnapshot(null);
    setReconcilingState(true);
    setStatus('connecting');
    sendHello();
    restartHelloRetry();
    window.setTimeout(() => requestSnapshot(), 400);
  }, [
    sendHello,
    restartHelloRetry,
    requestSnapshot,
    clearCaptures,
    cancelPendingPreviews,
    clearPendingSessionResets,
    resetRouteEpoch,
    setReconcilingState,
  ]);

  const recoverFromBridgePresence = useCallback(
    (announced: { bridgeConnectionId: string; documentGeneration: string }) => {
      const sameInstance =
        connIdRef.current === announced.bridgeConnectionId &&
        docGenRef.current === announced.documentGeneration;
      if (sameInstance && statusRef.current === 'connected' && !reconcilingRef.current) return;
      reconnect();
    },
    [reconnect],
  );

  const resetSession = useCallback(() => {
    bindingGenerationRef.current += 1;
    clearPendingSessionResets();
    clearCaptures('The target session was reset.');
    cancelPendingPreviews('The target session was reset.');
    setSnapshot(null);
    setLastError(null);
    setReconcilingState(true);
    postSessionReset();
    requestFreshSnapshot();
  }, [
    clearCaptures,
    cancelPendingPreviews,
    clearPendingSessionResets,
    postSessionReset,
    requestFreshSnapshot,
    setReconcilingState,
  ]);

  const bindSession = useCallback(
    (sessionId: string) => {
      sessionBindingIdRef.current = sessionId;
      setSessionBindingId(sessionId);
      resetSession();
    },
    [resetSession],
  );

  const loadTarget = useCallback(
    (target: string, frameUrl = target) => {
      pendingHelloRef.current.clear();
      clearPendingSessionResets();
      clearCaptures();
      cancelPendingPreviews('The target changed.');
      setTargetUrl(target);
      // Cleared before the new URL is set, so nothing is posted into the frame
      // while it is still showing the previous target.
      frameLoadedRef.current = false;
      setLoadedUrl(frameUrl);
      connIdRef.current = null;
      docGenRef.current = null;
      activeBridgeKindRef.current = null;
      seqRef.current = 0;
      modeRef.current = 'html';
      helloStartedAtRef.current = Date.now();
      resetRouteEpoch();
      setSnapshot(null);
      setReconcilingState(true);
      setStatus('connecting');
    },
    [
      clearCaptures,
      cancelPendingPreviews,
      clearPendingSessionResets,
      resetRouteEpoch,
      setReconcilingState,
    ],
  );

  const captureSelection = useCallback(
    (selectionId: string) => {
      for (const [requestId, pending] of pendingCapturesRef.current) {
        if (pending.selectionId !== selectionId) continue;
        window.clearTimeout(pending.timer);
        pendingCapturesRef.current.delete(requestId);
        pending.reject(new Error('Capture superseded.'));
      }
      if (reconcilingRef.current) {
        return Promise.reject<CaptureResultPayload>(
          new Error('The target is still reconciling with the Bridge.'),
        );
      }
      setCaptures((previous) => ({
        ...previous,
        [selectionId]: { selectionId, status: 'capturing' },
      }));
      const requestId = post('VERA_INSPECTOR_CAPTURE_SELECTION', { selectionId });
      return new Promise<CaptureResultPayload>((resolve, reject) => {
        if (!requestId) {
          const error = new Error('The target Bridge is not available.');
          setCaptures((previous) => ({
            ...previous,
            [selectionId]: { selectionId, status: 'error', error: error.message },
          }));
          reject(error);
          return;
        }
        const timer = window.setTimeout(() => {
          pendingCapturesRef.current.delete(requestId);
          const error = new Error('Component capture timed out.');
          setCaptures((previous) => ({
            ...previous,
            [selectionId]: { selectionId, status: 'error', error: error.message },
          }));
          reject(error);
        }, CAPTURE_TIMEOUT_MS);
        pendingCapturesRef.current.set(requestId, {
          ...currentRequestScope(),
          selectionId,
          resolve,
          reject,
          timer,
        });
      });
    },
    [post, currentRequestScope],
  );

  const pruneCaptures = useCallback((selectionIds: string[]) => {
    const allowed = new Set(selectionIds);
    for (const [requestId, pending] of pendingCapturesRef.current) {
      if (allowed.has(pending.selectionId)) continue;
      window.clearTimeout(pending.timer);
      pendingCapturesRef.current.delete(requestId);
      pending.reject(new Error('Selection removed.'));
    }
    setCaptures((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([selectionId]) => allowed.has(selectionId))),
    );
  }, []);

  const requestPreview = useCallback(
    (
      type: PreviewCommandType,
      payload: Record<string, unknown>,
      bindingId: string,
      expectedTransactionId: string | null,
    ): Promise<PreviewResultPayload> =>
      new Promise<PreviewResultPayload>((resolve, reject) => {
        if (connIdRef.current === null) {
          reject(new Error('The target Bridge is not available.'));
          return;
        }
        const requestId = post(type, payload);
        if (!requestId) {
          reject(new Error('The target Bridge is not available.'));
          return;
        }
        if (pendingPreviewsRef.current.size >= MAX_PENDING_PREVIEWS) {
          const oldest = pendingPreviewsRef.current.keys().next();
          if (!oldest.done) {
            const stale = pendingPreviewsRef.current.get(oldest.value);
            pendingPreviewsRef.current.delete(oldest.value);
            if (stale !== undefined) {
              window.clearTimeout(stale.timer);
              stale.reject(new Error('Too many pending preview requests.'));
            }
          }
        }
        const timer = window.setTimeout(() => {
          pendingPreviewsRef.current.delete(requestId);
          reject(new Error('Preview request timed out.'));
        }, PREVIEW_TIMEOUT_MS);
        pendingPreviewsRef.current.set(requestId, {
          ...currentRequestScope(),
          bindingId,
          expectedTransactionId,
          resolve,
          reject,
          timer,
        });
      }),
    [post, currentRequestScope],
  );

  const applyPreview = useCallback(
    (
      bindingId: string,
      transactionId: string,
      changes: readonly PreviewAnchorChange[],
    ) =>
      requestPreview(
        'VERA_INSPECTOR_PREVIEW_APPLY',
        { bindingId, transactionId, changes: [...changes] },
        bindingId,
        transactionId,
      ),
    [requestPreview],
  );

  const undoPreview = useCallback(
    (bindingId: string, transactionId: string) =>
      requestPreview(
        'VERA_INSPECTOR_PREVIEW_UNDO',
        { bindingId, transactionId },
        bindingId,
        transactionId,
      ),
    [requestPreview],
  );

  const resetPreviews = useCallback(
    (bindingId: string, transactionIds?: readonly string[]) => {
      const ids = transactionIds === undefined ? null : [...transactionIds];
      return requestPreview(
        'VERA_INSPECTOR_PREVIEW_RESET',
        ids === null ? { bindingId } : { bindingId, transactionIds: ids },
        bindingId,
        ids !== null && ids.length === 1 ? (ids[0] ?? null) : null,
      );
    },
    [requestPreview],
  );

  // Handshake retry loop (§8.1/8.5): HELLO until ACK.
  useEffect(() => {
    if (!loadedUrl) return;
    sendHello();
    restartHelloRetry();
    return () => {
      if (helloTimer.current) window.clearInterval(helloTimer.current);
    };
  }, [loadedUrl, sendHello, restartHelloRetry]);

  // Heartbeat / liveness (§8.3).
  useEffect(() => {
    if (!loadedUrl) return;
    if (hbTimer.current) window.clearInterval(hbTimer.current);
    if (hbTimeoutTimer.current) window.clearInterval(hbTimeoutTimer.current);
    hbTimer.current = window.setInterval(() => {
      if (connIdRef.current !== null) post('VERA_INSPECTOR_PING', {});
    }, HEARTBEAT_MS);
    hbTimeoutTimer.current = window.setInterval(() => {
      if (
        connIdRef.current !== null &&
        Date.now() - lastPongRef.current > HEARTBEAT_TIMEOUT_MS
      ) {
        setStatus((s) => (s === 'connected' ? 'stale' : s));
        if (Date.now() - lastPongRef.current > HEARTBEAT_TIMEOUT_MS * 2) {
          setStatus('timed_out');
        }
      }
    }, 2000);
    return () => {
      if (hbTimer.current) window.clearInterval(hbTimer.current);
      if (hbTimeoutTimer.current) window.clearInterval(hbTimeoutTimer.current);
    };
  }, [loadedUrl, post]);

  // Incoming bridge messages: source + schema + staleness checks (§7).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      if (!isExpectedSource(e.source, iframe.contentWindow)) return;
      if (loadedUrl) {
        const expected = targetOriginFor(loadedUrl);
        if (expected && e.origin !== expected) return;
      }
      const data: unknown = e.data;
      if (messageTypeOf(data) === 'VERA_INSPECTOR_BRIDGE_PRESENT') {
        if (!preValidateBridgePresent(data)) return;
        const presence = (data as { payload: { bridgeConnectionId: string; documentGeneration: string } })
          .payload;
        recoverFromBridgePresence(presence);
        return;
      }
      const res = validateBridgeMessage(data, {
        expectedConnectionId: connIdRef.current,
        expectedDocumentGeneration: docGenRef.current,
        lastSequence: seqRef.current,
        expectedRouteEpoch: routeEpochRef.current,
      });
      if (!res.ok) return; // malformed/stale → never mutates state
      const msg = res.msg!;
      let advanceSequence = true;

      switch (msg.type) {
        case 'VERA_INSPECTOR_HELLO_ACK': {
          const p = msg.payload as HelloAckPayload;
          if (!pendingHelloRef.current.delete(msg.requestId)) break;
          const incomingKind = p.bridgeKind ?? 'native';
          if (activeBridgeKindRef.current === 'native' && incomingKind === 'compatibility') {
            advanceSequence = false;
            break;
          }
          activeBridgeKindRef.current = incomingKind;
          if (connIdRef.current !== p.bridgeConnectionId) {
            connIdRef.current = p.bridgeConnectionId;
            docGenRef.current = p.documentGeneration;
            seqRef.current = 0;
            cancelPendingPreviews('The target Bridge reconnected.');
            setSnapshot(null);
            setReconcilingState(true);
            adoptRouteEpoch(p.routeEpoch, true);
          } else {
            adoptRouteEpoch(p.routeEpoch);
          }
          lastPongRef.current = Date.now();
          setStatus('connected');
          setLastError(null);
          pendingHelloRef.current.clear();
          if (helloTimer.current) window.clearInterval(helloTimer.current);
          helloTimer.current = null;
          requestSnapshot();
          break;
        }
        case 'VERA_INSPECTOR_SNAPSHOT': {
          const p = msg.payload as LiveSnapshot;
          const incomingKind = p.bridgeKind ?? activeBridgeKindRef.current ?? 'native';
          if (activeBridgeKindRef.current === 'native' && incomingKind === 'compatibility') {
            advanceSequence = false;
            break;
          }
          activeBridgeKindRef.current = incomingKind;
          connIdRef.current = msg.connectionId;
          docGenRef.current = msg.documentGeneration;
          if (isRouteEpoch(p.routeEpoch)) dropStalePreviews(p.routeEpoch);
          adoptRouteEpoch(p.routeEpoch);
          lastPongRef.current = Date.now();
          setStatus('connected');
          modeRef.current = p.mode;
          setSnapshot(p);
          setReconcilingState(false);
          settlePendingClears(p);
          break;
        }
        case 'VERA_INSPECTOR_FREEZE_ACK': {
          const p = msg.payload as { inspectorFrozen: boolean; mode: InspectorMode };
          lastPongRef.current = Date.now();
          modeRef.current = p.mode;
          setSnapshot((prev) =>
            prev
              ? { ...prev, inspectorFrozen: p.inspectorFrozen, mode: p.mode }
              : prev,
          );
          // Canonical follow-up snapshot reconciles selections (§9.4).
          requestSnapshot();
          break;
        }
        case 'VERA_INSPECTOR_SELECTION': {
          if (reconcilingRef.current) break; // ignore pre-snapshot live events
          const p = msg.payload as { record: SelectionRecord; activeOrder: string[] };
          setSnapshot((prev) => {
            if (!prev) return prev;
            const others = prev.selections.filter(
              (s) => s.selectionId !== p.record.selectionId,
            );
            const selections =
              p.record.state === 'active'
                ? [...others, p.record]
                : others.filter((s) => s.selectionId !== p.record.selectionId);
            // Include inactive toggle records transiently? No — keep active only,
            // history preserved in chat citations (§4.4).
            return { ...prev, selections, activeOrder: p.activeOrder };
          });
          if (p.record.state !== 'active') {
            setCaptures((previous) => {
              if (!previous[p.record.selectionId]) return previous;
              const next = { ...previous };
              delete next[p.record.selectionId];
              return next;
            });
          }
          break;
        }
        case 'VERA_INSPECTOR_CAPTURE_RESULT': {
          const result = msg.payload as CaptureResultPayload;
          const pending = pendingCapturesRef.current.get(msg.requestId);
          if (!pending || pending.selectionId !== result.selectionId) break;
          if (!scopeIsCurrent(pending)) {
            window.clearTimeout(pending.timer);
            pendingCapturesRef.current.delete(msg.requestId);
            pending.reject(new Error('The target changed before the capture completed.'));
            break;
          }
          window.clearTimeout(pending.timer);
          pendingCapturesRef.current.delete(msg.requestId);
          setCaptures((previous) => ({
            ...previous,
            [result.selectionId]: { selectionId: result.selectionId, status: 'ready', result },
          }));
          pending.resolve(result);
          break;
        }
        case 'VERA_INSPECTOR_PREVIEW_RESULT': {
          const result = msg.payload as PreviewResultPayload;
          adoptRouteEpoch(result.routeEpoch);
          const pending = pendingPreviewsRef.current.get(msg.requestId);
          if (!pending) break;
          if (pending.bindingId !== result.bindingId) break;
          if (
            pending.expectedTransactionId !== null &&
            pending.expectedTransactionId !== result.transactionId
          ) {
            break;
          }
          window.clearTimeout(pending.timer);
          pendingPreviewsRef.current.delete(msg.requestId);
          if (!scopeIsCurrent(pending)) {
            pending.reject(new Error('The target changed before the preview completed.'));
            break;
          }
          pending.resolve(result);
          break;
        }
        case 'VERA_INSPECTOR_ROUTE_CHANGED': {
          const p = msg.payload as RouteChangedPayload;
          dropStalePreviews(p.routeEpoch);
          adoptRouteEpoch(p.routeEpoch);
          clearCaptures();
          setSnapshot(null);
          setReconcilingState(true);
          requestFreshSnapshot();
          break;
        }
        case 'VERA_INSPECTOR_SESSION_RESET_ACK': {
          const p = msg.payload as SessionResetAckPayload;
          const timer = pendingSessionResetsRef.current.get(msg.requestId);
          if (timer === undefined) break; // late ACK from a superseded reset
          window.clearTimeout(timer);
          pendingSessionResetsRef.current.delete(msg.requestId);
          dropStalePreviews(p.routeEpoch);
          adoptRouteEpoch(p.routeEpoch);
          setReconcilingState(true);
          requestFreshSnapshot();
          break;
        }
        case 'VERA_INSPECTOR_BRIDGE_PRESENT': {
          advanceSequence = false; // handled by the pre-validated recovery path
          break;
        }
        case 'VERA_INSPECTOR_PONG': {
          lastPongRef.current = Date.now();
          setStatus('connected');
          break;
        }
        case 'VERA_INSPECTOR_ERROR': {
          const p = msg.payload as ErrorPayload;
          const capture = pendingCapturesRef.current.get(msg.requestId);
          if (capture) {
            window.clearTimeout(capture.timer);
            pendingCapturesRef.current.delete(msg.requestId);
            setCaptures((previous) => ({
              ...previous,
              [capture.selectionId]: {
                selectionId: capture.selectionId,
                status: 'error',
                error: p.message,
              },
            }));
            capture.reject(new Error(p.message));
            break;
          }
          const preview = pendingPreviewsRef.current.get(msg.requestId);
          if (preview) {
            window.clearTimeout(preview.timer);
            pendingPreviewsRef.current.delete(msg.requestId);
            preview.reject(new Error(p.message));
            break;
          }
          const resetTimer = pendingSessionResetsRef.current.get(msg.requestId);
          if (resetTimer !== undefined) {
            window.clearTimeout(resetTimer);
            pendingSessionResetsRef.current.delete(msg.requestId);
            break;
          }
          if (!p.code.startsWith('capture-')) setLastError(p.message);
          break;
        }
        default:
          break;
      }
      if (advanceSequence) seqRef.current = Math.max(seqRef.current, msg.sequence);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    loadedUrl,
    requestSnapshot,
    requestFreshSnapshot,
    recoverFromBridgePresence,
    adoptRouteEpoch,
    dropStalePreviews,
    cancelPendingPreviews,
    scopeIsCurrent,
    setReconcilingState,
    clearCaptures,
  ]);

  // App-A-side freeze shortcut (§9.1): narrow handler, no inspection of App A.
  useEffect(() => {
    let lastToggle = 0;
    function onKey(e: KeyboardEvent) {
      if (matchesFreezeShortcut(e)) {
        if (!readyRef.current) return;
        const now = Date.now();
        // Double-toggle race guard (§9.2): ignore repeats within 400ms.
        if (now - lastToggle < 400) {
          e.preventDefault();
          return;
        }
        lastToggle = now;
        e.preventDefault();
        post('VERA_INSPECTOR_FREEZE', { active: !frozenRef.current });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [post]);

  const setFrozen = useCallback(
    (active: boolean) => {
      if (!readyRef.current) return;
      post('VERA_INSPECTOR_FREEZE', { active });
    },
    [post],
  );

  const setMode = useCallback(
    (m: InspectorMode) => {
      if (!readyRef.current) return;
      modeRef.current = m;
      post('VERA_INSPECTOR_SET_MODE', { mode: m });
    },
    [post],
  );

  const dropCapture = useCallback((selectionId: string) => {
    for (const [requestId, pending] of pendingCapturesRef.current) {
      if (pending.selectionId !== selectionId) continue;
      window.clearTimeout(pending.timer);
      pendingCapturesRef.current.delete(requestId);
      pending.reject(new Error('Selection removed.'));
    }
    setCaptures((previous) => {
      if (!previous[selectionId]) return previous;
      const next = { ...previous };
      delete next[selectionId];
      return next;
    });
  }, []);

  const clearSelection = useCallback(
    (id: string) => {
      dropCapture(id);
      post('VERA_INSPECTOR_CLEAR_SELECTION', { selectionId: id });
      // Optimistic tray removal; snapshot will confirm.
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              selections: prev.selections.filter((s) => s.selectionId !== id),
              activeOrder: prev.activeOrder.filter((x) => x !== id),
            }
          : prev,
      );
    },
    [dropCapture, post],
  );

  /**
   * Removing a composer tag also deselects the component. The tag list is
   * controlled, so a refused clear simply puts the tag back — this promise lets
   * the UI say so instead of silently disagreeing with the target.
   */
  const clearSelectionConfirmed = useCallback(
    (id: string, timeoutMs = 1500): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (!readyRef.current) {
          resolve(false);
          return;
        }
        let timer = 0;
        const settle = (cleared: boolean) => {
          window.clearTimeout(timer);
          if (pendingClearsRef.current.get(id)?.settle === settle) pendingClearsRef.current.delete(id);
          resolve(cleared);
        };
        pendingClearsRef.current.get(id)?.settle(false);
        timer = window.setTimeout(() => settle(false), timeoutMs);
        pendingClearsRef.current.set(id, { settle });
        clearSelection(id);
      }),
    [clearSelection],
  );

  const reselectSelection = useCallback(
    (id: string) => {
      // No optimistic tray edit: a deselected record is gone from the app's
      // snapshot, so the record only exists again once the bridge echoes it.
      post('VERA_INSPECTOR_RESELECT_SELECTION', { selectionId: id });
    },
    [post],
  );

  const clearAll = useCallback(() => {
    for (const selectionId of Object.keys(captures)) dropCapture(selectionId);
    post('VERA_INSPECTOR_CLEAR_ALL', {});
    setSnapshot((prev) =>
      prev ? { ...prev, selections: [], activeOrder: [] } : prev,
    );
  }, [captures, dropCapture, post]);

  return {
    status,
    ready,
    reconciling,
    snapshot,
    captures,
    frozen,
    mode,
    sessionBindingId,
    routeEpoch,
    bindingGeneration: bindingGenerationRef.current,
    iframeRef,
    targetUrl,
    setTargetUrl,
    loadTarget,
    reconnect,
    bindSession,
    resetSession,
    setFrozen,
    setMode,
    clearSelection,
    clearSelectionConfirmed,
    reselectSelection,
    clearAll,
    captureSelection,
    pruneCaptures,
    applyPreview,
    undoPreview,
    resetPreviews,
    lastError,
  };
}

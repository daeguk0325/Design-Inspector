import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { BridgeApi } from '../hooks/useBridge.ts';
import type { ChatCompletion } from '../hooks/useChat.ts';
import type { InspectorSession, ChatMessage } from '../state/models.ts';
import { makeId } from '../state/models.ts';
import type {
  PreviewAnchorChange,
  PreviewResultPayload,
} from '../protocol/types.ts';
import type {
  DesignDecision,
  PreviewChangeRecord,
  PreviewRuntimeStatus,
  PreviewTransaction,
} from './transaction.ts';
import { MAX_PREVIEW_RULES, MAX_PREVIEW_TARGET } from './contract.ts';
import type { MessagePreviewStatus } from '../components/ChatList.tsx';

interface ControllerInput {
  bridge: BridgeApi;
  session: InspectorSession | null;
  updateSession: (id: string, patch: (session: InspectorSession) => InspectorSession) => void;
  autoEnabled: boolean;
}

export interface PreviewController {
  applyCompletion: (completion: ChatCompletion) => void;
  undo: (assistantId: string) => Promise<void>;
  reset: () => Promise<void>;
  decide: (messageId: string, decision: DesignDecision) => void;
  previews: ReadonlyMap<string, MessagePreviewStatus>;
  activeCount: number;
}

function resultStatus(result: PreviewResultPayload): PreviewRuntimeStatus {
  if (result.status === 'applied') return 'applied';
  if (result.status === 'unbound') return 'unbound';
  if (result.status === 'ambiguous') return 'ambiguous';
  if (result.status === 'undone') return 'undone';
  if (result.status === 'reset') return 'reset';
  return 'rejected';
}

function transactionEnabled(status: PreviewRuntimeStatus): boolean {
  return status === 'applied' || status === 'pending-rebind' || status === 'unbound' || status === 'ambiguous';
}

function undoSucceeded(result: PreviewResultPayload): boolean {
  return result.status === 'undone' || result.status === 'no-op';
}

function resetSucceeded(result: PreviewResultPayload): boolean {
  return result.status === 'reset' || result.status === 'no-op';
}

function targetWithinCap(target: number): boolean {
  return Number.isSafeInteger(target) && target >= 1 && target <= MAX_PREVIEW_TARGET;
}

function previewChangesFor(completion: ChatCompletion): PreviewChangeRecord[] | null {
  if (!completion.candidate) return null;
  const rules = completion.candidate.rules;
  if (rules.length < 1 || rules.length > MAX_PREVIEW_RULES) return null;
  const byNumber = new Map(completion.citations.map((citation) => [citation.displayNumber, citation]));
  const changes: PreviewChangeRecord[] = [];
  for (const rule of rules) {
    if (!targetWithinCap(rule.target)) return null;
    const citation = byNumber.get(rule.target);
    const anchor = citation?.anchor;
    if (!citation || !anchor) return null;
    const declarations: Record<string, string> = {};
    for (const [property, value] of Object.entries(rule.declarations)) declarations[property] = value;
    changes.push({ target: rule.target, anchor: { ...anchor }, declarations });
  }
  return changes;
}

export function usePreviewController({ bridge, session, updateSession, autoEnabled }: ControllerInput): PreviewController {
  const appliedScopes = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const sessionRef = useRef(session);
  const updateSessionRef = useRef(updateSession);
  const bridgeRef = useRef(bridge);
  const autoEnabledRef = useRef(autoEnabled);
  useLayoutEffect(() => {
    sessionRef.current = session;
    updateSessionRef.current = updateSession;
    bridgeRef.current = bridge;
    autoEnabledRef.current = autoEnabled;
  }, [autoEnabled, bridge, session, updateSession]);

  const patchTransaction = useCallback(
    (ownerId: string, transactionId: string, patch: Partial<PreviewTransaction>) => {
      updateSessionRef.current(ownerId, (current) => ({
        ...current,
        previewTransactions: current.previewTransactions.map((transaction) =>
          transaction.id === transactionId ? { ...transaction, ...patch, updatedAt: Date.now() } : transaction,
        ),
        updatedAt: Date.now(),
      }));
    },
    [],
  );

  const claimScope = useCallback((ownerId: string, transactionId: string): boolean => {
    const active = bridgeRef.current;
    const routeScope = `${ownerId}|${active.sessionBindingId ?? ''}|${active.routeEpoch ?? 0}|${active.snapshot?.documentGeneration ?? ''}`;
    const key = `${routeScope}|${transactionId}`;
    if (appliedScopes.current.has(key)) return false;
    appliedScopes.current.add(key);
    return true;
  }, []);

  const applyTransaction = useCallback(async (ownerId: string, transaction: PreviewTransaction) => {
    const current = sessionRef.current;
    if (!current || current.id !== ownerId) return;
    if (transaction.sessionId !== ownerId) return;
    const active = bridgeRef.current;
    if (!active.ready || !active.snapshot?.capabilities?.cssPreview) return;
    if (!transaction.enabled || !transactionEnabled(transaction.status)) return;
    if (inFlight.current.has(transaction.id)) return;
    inFlight.current.add(transaction.id);
    try {
      const changes: PreviewAnchorChange[] = transaction.changes.map((change) => ({
        anchor: { ...change.anchor },
        declarations: { ...change.declarations },
      }));
      const result = await active.applyPreview(ownerId, transaction.id, changes);
      const status = resultStatus(result);
      patchTransaction(ownerId, transaction.id, {
        status,
        enabled: transactionEnabled(status),
        ...(status === 'rejected' ? { errorCode: result.status } : {}),
      });
    } catch {
      patchTransaction(ownerId, transaction.id, {
        status: 'rejected',
        enabled: false,
        errorCode: 'apply-failed',
      });
    } finally {
      inFlight.current.delete(transaction.id);
    }
  }, [patchTransaction]);

  const applyCompletion = useCallback((completion: ChatCompletion) => {
    const current = sessionRef.current;
    if (!session || !current || current.id !== session.id) return;
    if (completion.sessionId !== current.id) return;
    if (!autoEnabledRef.current) return;
    if (completion.errored || completion.truncated) return;
    const active = bridgeRef.current;
    if (!active.ready || !active.snapshot?.capabilities?.cssPreview) return;
    const changes = previewChangesFor(completion);
    if (!changes || changes.length === 0) return;
    const alreadyTracked = current.previewTransactions.some(
      (transaction) => transaction.assistantId === completion.assistantId,
    );
    if (alreadyTracked) return;
    const now = Date.now();
    const transaction: PreviewTransaction = {
      id: makeId('pv'),
      assistantId: completion.assistantId,
      userMessageId: completion.userMessageId,
      sessionId: current.id,
      targetUrl: current.targetUrl,
      routeKey: active.snapshot.routeKey ?? changes[0]?.anchor.routeKey ?? '',
      changes,
      enabled: true,
      status: 'pending-rebind',
      createdAt: now,
      updatedAt: now,
    };
    updateSessionRef.current(current.id, (existing) => ({
      ...existing,
      previewTransactions: [...existing.previewTransactions, transaction],
      messages: existing.messages.map((message) =>
        message.id === completion.assistantId
          ? { ...message, previewTransactionId: transaction.id }
          : message,
      ),
      updatedAt: now,
    }));
    if (claimScope(current.id, transaction.id)) void applyTransaction(current.id, transaction);
  }, [applyTransaction, claimScope, session]);

  useEffect(() => {
    if (!session || !bridge.ready || !autoEnabled || !bridge.snapshot?.capabilities?.cssPreview) return;
    for (const transaction of session.previewTransactions) {
      if (transaction.sessionId !== session.id) continue;
      if (!transaction.enabled || !transactionEnabled(transaction.status)) continue;
      if (!claimScope(session.id, transaction.id)) continue;
      void applyTransaction(session.id, transaction);
    }
  }, [applyTransaction, autoEnabled, bridge, claimScope, session]);

  const undo = useCallback(async (assistantId: string) => {
    const current = sessionRef.current;
    if (!session || !current || current.id !== session.id) return;
    const transaction = current.previewTransactions.find((item) => item.assistantId === assistantId);
    if (!transaction || transaction.sessionId !== current.id || !transaction.enabled) return;
    const ownerId = current.id;
    try {
      const result = await bridgeRef.current.undoPreview(ownerId, transaction.id);
      if (undoSucceeded(result)) {
        patchTransaction(ownerId, transaction.id, { status: 'undone', enabled: false });
      } else {
        patchTransaction(ownerId, transaction.id, { errorCode: 'undo-failed' });
      }
    } catch {
      patchTransaction(ownerId, transaction.id, { errorCode: 'undo-failed' });
    }
  }, [patchTransaction, session]);

  const reset = useCallback(async () => {
    const current = sessionRef.current;
    if (!session || !current || current.id !== session.id) return;
    const ownerId = current.id;
    const transactions = current.previewTransactions.filter(
      (transaction) => transaction.enabled && transaction.sessionId === ownerId,
    );
    if (transactions.length === 0) return;
    let failure: string | null = null;
    try {
      const result = await bridgeRef.current.resetPreviews(
        ownerId,
        transactions.map((transaction) => transaction.id),
      );
      if (!resetSucceeded(result)) failure = 'reset-failed';
    } catch {
      failure = 'reset-failed';
    }
    for (const transaction of transactions) {
      patchTransaction(
        ownerId,
        transaction.id,
        failure === null ? { status: 'reset', enabled: false } : { errorCode: failure },
      );
    }
  }, [patchTransaction, session]);

  const decide = useCallback((messageId: string, decision: DesignDecision) => {
    const current = sessionRef.current;
    if (!session || !current || current.id !== session.id) return;
    updateSessionRef.current(current.id, (existing) => ({
      ...existing,
      messages: existing.messages.map((message: ChatMessage) =>
        message.id === messageId ? { ...message, decision } : message,
      ),
      updatedAt: Date.now(),
    }));
  }, [session]);

  const previews = useMemo(() => {
    const map = new Map<string, MessagePreviewStatus>();
    for (const transaction of session?.previewTransactions ?? []) {
      map.set(transaction.assistantId, {
        status: transaction.status,
        enabled: transaction.enabled,
        changeCount: transaction.changes.length,
        errorCode: transaction.errorCode,
      });
    }
    return map;
  }, [session]);

  const activeCount = useMemo(
    () => (session?.previewTransactions ?? []).filter((transaction) => transaction.enabled).length,
    [session],
  );

  return { applyCompletion, undo, reset, decide, previews, activeCount };
}

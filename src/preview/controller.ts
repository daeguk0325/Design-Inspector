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
import { pendingForSession, proposalsIn, proposalSummaryLines } from './proposal.ts';
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
  /**
   * Accept keeps the applied change; Reject rolls it back. Either way the
   * decision is recorded so the next request carries it.
   *
   * A decision is reversible in both directions, so both of them touch the
   * page: Accept re-applies a change that is not currently on it, rather than
   * only ever confirming one that happens to be.
   */
  decide: (messageId: string, decision: DesignDecision) => Promise<void>;
  /** Drops every transaction and rewinds the conversation to `userMessageId`. */
  revertTo: (userMessageId: string) => Promise<RevertSnapshot | null>;
  previews: ReadonlyMap<string, MessagePreviewStatus>;
  activeCount: number;
  pendingCount: number;
}

/** Everything needed to put a rewind back the way it was. */
export interface RevertSnapshot {
  messages: ChatMessage[];
  previewTransactions: PreviewTransaction[];
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

/**
 * Whether the change is on the live page right now.
 *
 * Both halves matter: `enabled` is the local record of the intent, and the
 * status is what the target last reported. A transaction that claims to be
 * applied while disabled was never re-asserted, so it counts as off the page.
 */
function appliedToPage(transaction: PreviewTransaction): boolean {
  return transaction.enabled && transactionEnabled(transaction.status);
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
    const change: PreviewChangeRecord = { target: rule.target, anchor: { ...anchor }, declarations };
    if (rule.text !== undefined) change.text = rule.text;
    if (rule.replaceText !== undefined) change.replaceText = rule.replaceText;
    if (rule.element !== undefined) change.element = rule.element;
    changes.push(change);
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
        ...(change.text === undefined ? {} : { text: change.text }),
        ...(change.replaceText === undefined ? {} : { replaceText: change.replaceText }),
        ...(change.element === undefined ? {} : { element: change.element }),
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

  const decide = useCallback(async (messageId: string, decision: DesignDecision) => {
    const current = sessionRef.current;
    if (!session || !current || current.id !== session.id) return;
    const ownerId = current.id;
    const markDecision = updateSessionRef.current;
    const transaction = current.previewTransactions.find(
      (item) => item.assistantId === messageId,
    );
    // Both directions touch the page, because both directions are reversible.
    // The user decides by looking at the page, so flipping a decision has to
    // change what the page shows; recording the word alone would leave the
    // preview contradicting the decision it just recorded.
    if (transaction && decision === 'rejected' && transaction.enabled) {
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
    } else if (transaction && decision === 'accepted' && !appliedToPage(transaction)) {
      // The re-apply is handed a transaction that is enabled and live rather
      // than the one read here: `applyTransaction` refuses anything else, and
      // after a reject the stored transaction is `undone`/disabled. The session
      // read above cannot be used for that check because the reject has not
      // committed yet in the case where both happen in quick succession.
      //
      // `claimScope` is deliberately not consulted. It exists to stop the
      // automatic rebind effect from double-applying a scope, and a deliberate
      // user-driven re-apply is exactly what it is meant to refuse; the
      // `inFlight` guard inside `applyTransaction` is the protection that
      // belongs to a direct call.
      await applyTransaction(ownerId, { ...transaction, enabled: true, status: 'pending-rebind' });
    }
    markDecision(ownerId, (existing) => ({
      ...existing,
      messages: existing.messages.map((message: ChatMessage) =>
        message.id === messageId ? { ...message, decision } : message,
      ),
      updatedAt: Date.now(),
    }));
  }, [applyTransaction, patchTransaction, session]);

  const revertTo = useCallback(async (userMessageId: string): Promise<RevertSnapshot | null> => {
    const current = sessionRef.current;
    if (!session || !current || current.id !== session.id) return null;
    const index = current.messages.findIndex(
      (message) => message.id === userMessageId && message.role === 'user',
    );
    if (index < 0) return null;
    const ownerId = current.id;
    const snapshot: RevertSnapshot = {
      messages: current.messages,
      previewTransactions: current.previewTransactions,
    };
    const live = current.previewTransactions.filter(
      (transaction) => transaction.enabled && transaction.sessionId === ownerId,
    );
    if (live.length > 0) {
      try {
        await bridgeRef.current.resetPreviews(
          ownerId,
          live.map((transaction) => transaction.id),
        );
      } catch {
        // The rewind still happens locally; a failed bridge reset leaves the
        // page styled until the next session reset, and the snapshot can put
        // the transactions back.
      }
    }
    updateSessionRef.current(ownerId, (existing) => ({
      ...existing,
      messages: existing.messages.slice(0, index),
      previewTransactions: existing.previewTransactions.map((transaction) =>
        transaction.enabled && transaction.sessionId === ownerId
          ? { ...transaction, enabled: false, status: 'reset' as PreviewRuntimeStatus, updatedAt: Date.now() }
          : transaction,
      ),
      updatedAt: Date.now(),
    }));
    return snapshot;
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
    for (const proposal of proposalsIn(session?.messages ?? [], session?.previewTransactions ?? [])) {
      const existing = map.get(proposal.messageId);
      if (!existing) continue;
      map.set(proposal.messageId, {
        ...existing,
        proposalState: proposal.state,
        summaryLines: proposalSummaryLines(proposal),
      });
    }
    return map;
  }, [session]);

  const activeCount = useMemo(
    () => (session?.previewTransactions ?? []).filter((transaction) => transaction.enabled).length,
    [session],
  );

  const pendingCount = useMemo(
    () => pendingForSession(session).length,
    [session],
  );

  return { applyCompletion, undo, reset, decide, revertTo, previews, activeCount, pendingCount };
}

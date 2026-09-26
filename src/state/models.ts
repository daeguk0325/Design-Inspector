// App state models (§§4, 17, 18). App A owns persistent/UI state;
// Bridge owns live runtime state (§3). Keep them distinct.

import type { InspectorAnchor, InspectorMode, SelectionRecord, StyleFacts } from '../protocol/types.ts';
import type { DesignDecision, PreviewTransaction } from '../preview/transaction.ts';
import { sanitizeStyleFacts } from '../style/sanitize.ts';

export type AssistantStatus =
  | 'streaming'
  | 'completed'
  | 'interrupted'
  | 'error';

export interface CitationSnapshot {
  selectionId: string;
  elementKey: string;
  component: string | null;
  file: string | null;
  line: number | null;
  mode: InspectorMode;
  extra?: unknown;
  /** Canonical display number at send time. */
  displayNumber: number;
  anchor?: InspectorAnchor;
  styleFacts?: StyleFacts;
}

function sanitizeExtra(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string' && (item.startsWith('data:') || item.length > 2048)) return undefined;
      return item;
    });
    return serialized && serialized.length <= 16_384 ? JSON.parse(serialized) : undefined;
  } catch {
    return undefined;
  }
}

export function citationFromRecord(
  r: SelectionRecord,
  displayNumber: number,
): CitationSnapshot {
  const styleFacts = sanitizeStyleFacts(r.styleFacts);
  return {
    selectionId: r.selectionId,
    elementKey: r.elementKey,
    component: r.component,
    file: r.file,
    line: r.line,
    mode: r.mode,
    extra: sanitizeExtra(r.extra),
    displayNumber,
    ...(r.anchor === undefined ? {} : { anchor: { ...r.anchor } }),
    ...(styleFacts === undefined ? {} : { styleFacts }),
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Raw user text — never includes transmission-time citation prefix (§17). */
  content: string;
  citations: CitationSnapshot[];
  status?: AssistantStatus;
  createdAt: number;
  decision?: DesignDecision;
  previewTransactionId?: string;
  /**
   * The model's reasoning channel, shown as a collapsible log. Ollama streams
   * it as `message.thinking` apart from `message.content`; it used to be
   * counted and thrown away, so a turn spent entirely on thinking looked like
   * an empty answer with no explanation.
   */
  thinking?: string;
}

/**
 * Reasoning logs are unbounded in principle and live in localStorage with the
 * session. 32k characters is room for a long trace without letting one turn
 * eat the storage budget.
 */
export const MAX_THINKING_CHARS = 32_000;

export function capThinking(value: string): string {
  return value.length > MAX_THINKING_CHARS ? value.slice(0, MAX_THINKING_CHARS) : value;
}

/** A patch the chat pipeline applies to one message, including stream appends. */
export interface MessagePatch extends Partial<ChatMessage> {
  appendContent?: string;
  appendThinking?: string;
}

export interface InspectorSession {
  id: string;
  title: string;
  targetUrl: string;
  model: string;
  messages: ChatMessage[];
  previewTransactions: PreviewTransaction[];
  /** Persisted active-selection intent; MUST be reconciled vs live snapshot (§15.2). */
  persistedActiveSelectionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PersistedShape {
  sessions: InspectorSession[];
  currentSessionId: string | null;
}

export function latestUserRequest(session: InspectorSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m && m.role === 'user') return m.content;
  }
  return '';
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

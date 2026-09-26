// Chat hook: Ollama streaming with abort/stop, duplicate-send guard,
// session-switch race guards, explicit message lifecycle (§16).

import { useCallback, useRef, useState } from 'react';
import { normalizeBaseUrl, streamChat } from '../ollama/client.ts';
import type { ChatMessage, CitationSnapshot } from '../state/models.ts';
import { citationFromRecord, makeId } from '../state/models.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import type { VisualTransmission } from '../ollama/visualContext.ts';
import { PreviewSidecarParser } from '../preview/index.ts';
import type { PreviewCandidate } from '../preview/index.ts';

const MAX_RETRY_VISUALS = 8;
const MAX_RETRY_VISUAL_BASE64 = 16 * 1024 * 1024;

export interface ChatCompletion {
  sessionId: string;
  assistantId: string;
  userMessageId: string;
  candidate: PreviewCandidate | null;
  citations: CitationSnapshot[];
  content: string;
  truncated: boolean;
  errored: boolean;
}

export type OnChatComplete = (completion: ChatCompletion) => void;

export interface ChatApi {
  streaming: boolean;
  send: (
    sessionId: string,
    rawText: string,
    active: SelectionRecord[],
    displayNumbers: Map<string, number>,
    visual: VisualTransmission | undefined,
    appendMessage: (sessionId: string, m: ChatMessage) => void,
    patchMessage: (sessionId: string, id: string, patch: Partial<ChatMessage> & { appendContent?: string }) => void,
    history: ChatMessage[],
    baseUrl: string,
    model: string,
    onComplete?: OnChatComplete,
  ) => Promise<boolean>;
  stop: () => void;
  retry: (
    sessionId: string,
    userMsg: ChatMessage,
    citations: CitationSnapshot[],
    history: ChatMessage[],
    baseUrl: string,
    model: string,
    appendMessage: (sessionId: string, m: ChatMessage) => void,
    patchMessage: (sessionId: string, id: string, patch: Partial<ChatMessage> & { appendContent?: string }) => void,
    onComplete?: OnChatComplete,
  ) => Promise<void>;
}

export function useChat(): ChatApi {
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const activeAssistantRef = useRef<string | null>(null);
  const attemptVisualsRef = useRef(new Map<string, VisualTransmission>());
  const storeAttemptVisual = useCallback((messageId: string, visual: VisualTransmission) => {
    attemptVisualsRef.current.set(messageId, visual);
    let total = 0;
    for (const value of attemptVisualsRef.current.values()) {
      total += value.images.reduce((sum, image) => sum + image.length, 0);
    }
    while (
      attemptVisualsRef.current.size > MAX_RETRY_VISUALS ||
      total > MAX_RETRY_VISUAL_BASE64
    ) {
      const oldest = attemptVisualsRef.current.keys().next().value;
      if (oldest === undefined) break;
      const removed = attemptVisualsRef.current.get(oldest);
      attemptVisualsRef.current.delete(oldest);
      if (removed) total -= removed.images.reduce((sum, image) => sum + image.length, 0);
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // Status flip to interrupted happens in send/retry finally blocks.
  }, []);

  const runStream = useCallback(
    async (
      sessionId: string,
      assistantId: string,
      userMessageId: string,
      history: ChatMessage[],
      rawRequest: string,
      citations: CitationSnapshot[],
      visual: VisualTransmission | undefined,
      baseUrl: string,
      model: string,
      patchMessage: (sessionId: string, id: string, patch: Partial<ChatMessage> & { appendContent?: string }) => void,
      onComplete: OnChatComplete | undefined,
    ) => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      activeSessionRef.current = sessionId;
      activeAssistantRef.current = assistantId;
      setStreaming(true);
      let gotToken = false;
      let errored: string | null = null;
      let truncated = false;
      let visible = '';
      const sidecar = new PreviewSidecarParser({
        knownCitationNumbers: citations.map((citation) => citation.displayNumber),
      });
      const isCurrentAttempt = (): boolean =>
        activeSessionRef.current === sessionId && activeAssistantRef.current === assistantId;
      const applyVisible = (text: string): void => {
        if (text === '') return;
        gotToken = true;
        visible += text;
        if (!isCurrentAttempt()) return;
        patchMessage(sessionId, assistantId, { appendContent: text });
      };
      await streamChat(baseUrl, model, history, rawRequest, citations, visual, ctrl.signal, {
        onToken: (t) => {
          applyVisible(sidecar.push(t).text);
        },
        onDone: (meta) => {
          truncated = meta.truncated;
          applyVisible(sidecar.flush().text);
        },
        onError: (msg) => {
          errored = msg;
        },
      });
      const wasAborted = ctrl.signal.aborted;
      // Never silently mark interrupted streams successful (§16.7).
      if (isCurrentAttempt()) {
        if (wasAborted) {
          patchMessage(sessionId, assistantId, {
            status: 'interrupted',
            appendContent: gotToken ? '' : '(stopped)',
          });
        } else if (errored) {
          patchMessage(sessionId, assistantId, {
            status: 'error',
            appendContent: gotToken ? '' : `Error: ${errored}`,
          });
        } else {
          patchMessage(sessionId, assistantId, { status: 'completed' });
        }
      }
      const clean = !wasAborted && errored === null && !truncated;
      if (clean && isCurrentAttempt()) {
        // The answer cites the components of the request it is answering, so the
        // citations belong on the answer too — that is what lets a `({1})` in
        // the prose resolve to a component instead of staying plain text.
        patchMessage(sessionId, assistantId, {
          citations: citations.map((citation) => ({
            ...citation,
            ...(citation.anchor ? { anchor: { ...citation.anchor } } : {}),
          })),
        });
        onComplete?.({
          sessionId,
          assistantId,
          userMessageId,
          candidate: sidecar.candidate,
          citations: citations.map((citation) => ({ ...citation, ...(citation.anchor ? { anchor: { ...citation.anchor } } : {}) })),
          content: visible,
          truncated,
          errored: false,
        });
      }
      if (abortRef.current === ctrl) abortRef.current = null;
      setStreaming(false);
    },
    [],
  );

  type AppendFn = (sessionId: string, m: ChatMessage) => void;
  type PatchFn = (
    sessionId: string,
    id: string,
    patch: Partial<ChatMessage> & { appendContent?: string },
  ) => void;

  const send = useCallback(
    async (
      sessionId: string,
      rawText: string,
      active: SelectionRecord[],
      displayNumbers: Map<string, number>,
      visual: VisualTransmission | undefined,
      appendMessage: AppendFn,
      patchMessage: PatchFn,
      history: ChatMessage[],
      baseUrl: string,
      model: string,
      onComplete?: OnChatComplete,
    ) => {
      if (streaming || abortRef.current) return false; // duplicate-send guard (§16.8)
      const text = rawText;
      if (!text.trim()) return false;
      const citations: CitationSnapshot[] = active.map((r) =>
        citationFromRecord(r, displayNumbers.get(r.selectionId) ?? 0),
      );
      const userMsg: ChatMessage = {
        id: makeId('msg'),
        role: 'user',
        content: text, // raw text only — citation context added at transmission (§17)
        citations,
        pinned: false,
        pinnedAt: null,
        createdAt: Date.now(),
      };
      if (visual) storeAttemptVisual(userMsg.id, visual);
      appendMessage(sessionId, userMsg);
      const assistantId = makeId('msg');
      appendMessage(sessionId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        citations: [],
        pinned: false,
        pinnedAt: null,
        status: 'streaming',
        createdAt: Date.now(),
      });
      void runStream(
        sessionId,
        assistantId,
        userMsg.id,
        history,
        text,
        citations,
        visual,
        baseUrl,
        model,
        patchMessage,
        onComplete,
      );
      return true;
    },
    [streaming, runStream, storeAttemptVisual],
  );

  const retry = useCallback(
    async (
      sessionId: string,
      userMsg: ChatMessage,
      citations: CitationSnapshot[],
      history: ChatMessage[],
      baseUrl: string,
      model: string,
      appendMessage: AppendFn,
      patchMessage: PatchFn,
      onComplete?: OnChatComplete,
    ) => {
      // §16.9: user request preserved; new assistant attempt; old failed entry stays.
      if (streaming || abortRef.current) return;
      const storedVisual = attemptVisualsRef.current.get(userMsg.id);
      if (
        storedVisual &&
        (storedVisual.model !== model || normalizeBaseUrl(storedVisual.endpoint) !== normalizeBaseUrl(baseUrl))
      ) {
        appendMessage(sessionId, {
          id: makeId('msg'),
          role: 'assistant',
          content: 'Visual retry was not sent because the Ollama model or endpoint changed.',
          citations: [],
          pinned: false,
          pinnedAt: null,
          status: 'error',
          createdAt: Date.now(),
        });
        return;
      }
      const assistantId = makeId('msg');
      appendMessage(sessionId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        citations: [],
        pinned: false,
        pinnedAt: null,
        status: 'streaming',
        createdAt: Date.now(),
      });
      const userIndex = history.findIndex((message) => message.id === userMsg.id);
      const retryHistory = userIndex >= 0 ? history.slice(0, userIndex) : history;
      await runStream(
        sessionId,
        assistantId,
        userMsg.id,
        retryHistory,
        userMsg.content,
        citations,
        storedVisual,
        baseUrl,
        model,
        patchMessage,
        onComplete,
      );
    },
    [streaming, runStream],
  );

  return { streaming, send, stop, retry };
}

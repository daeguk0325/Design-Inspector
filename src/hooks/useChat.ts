// Chat hook: Ollama streaming with abort/stop, duplicate-send guard,
// session-switch race guards, explicit message lifecycle (§16).

import { useCallback, useRef, useState } from 'react';
import { streamChat } from '../ollama/client.ts';
import { shouldSuppressBlock } from '../ollama/intent.ts';
import { classifyRoute, routeContextLine } from '../ollama/route.ts';
import type { ChatMessage, CitationSnapshot, MessagePatch } from '../state/models.ts';
import { capThinking, citationFromRecord, makeId } from '../state/models.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import type { VisualTransmission } from '../ollama/visualContext.ts';
import { PreviewSidecarParser } from '../preview/index.ts';
import type { PreviewCandidate } from '../preview/index.ts';
import type { PreviewTransaction } from '../preview/transaction.ts';
import { DEFAULT_GENERATION_SETTINGS } from '../ollama/params.ts';
import type { GenerationSettings } from '../ollama/params.ts';

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
    patchMessage: (sessionId: string, id: string, patch: MessagePatch) => void,
    history: ChatMessage[],
    baseUrl: string,
    model: string,
    onComplete?: OnChatComplete,
    transactions?: readonly PreviewTransaction[],
    generation?: GenerationSettings,
  ) => Promise<boolean>;
  stop: () => void;
}

export function useChat(): ChatApi {
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const activeAssistantRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // Status flip to interrupted happens in the send finally block.
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
      patchMessage: (sessionId: string, id: string, patch: MessagePatch) => void,
      onComplete: OnChatComplete | undefined,
      transactions: readonly PreviewTransaction[],
      generation: GenerationSettings,
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
      let thinking = '';
      const sidecar = new PreviewSidecarParser(
        { knownCitationNumbers: citations.map((citation) => citation.displayNumber) },
        // Decided from the request, before any of the model's output exists, and
        // from `previewIntent` alone. The stage-one router is deliberately not
        // part of this decision: it can only ever subtract, and the gate is what
        // enforces that.
        { suppressBlock: shouldSuppressBlock(rawRequest) },
      );
      const isCurrentAttempt = (): boolean =>
        activeSessionRef.current === sessionId && activeAssistantRef.current === assistantId;
      // Stage one, before the main completion. A failure, a timeout or an
      // unparseable answer all come back as null and leave no line behind, so
      // the turn below is byte-for-byte the turn this app would have sent.
      const routeLine = routeContextLine(
        rawRequest,
        await classifyRoute({ baseUrl, model, rawRequest, signal: ctrl.signal }),
      );
      const applyVisible = (text: string): void => {
        if (text === '') return;
        gotToken = true;
        visible += text;
        if (!isCurrentAttempt()) return;
        patchMessage(sessionId, assistantId, { appendContent: text });
      };
      const applyThinking = (text: string): void => {
        if (text === '') return;
        thinking += text;
        if (!isCurrentAttempt()) return;
        // The full string rides along rather than an append: the store caps it,
        // and a capped append would need the current value anyway.
        patchMessage(sessionId, assistantId, { thinking: capThinking(thinking) });
      };
      await streamChat(baseUrl, model, history, rawRequest, citations, visual, ctrl.signal, {
        onToken: (t) => {
          applyVisible(sidecar.push(t).text);
        },
        onThinking: (t) => {
          applyThinking(t);
        },
        onDone: (meta) => {
          truncated = meta.truncated;
          applyVisible(sidecar.flush().text);
        },
        onError: (msg) => {
          errored = msg;
        },
      }, transactions, generation, routeLine);
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
    patch: MessagePatch,
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
      onComplete: OnChatComplete | undefined,
      transactions: readonly PreviewTransaction[] = [],
      generation: GenerationSettings = DEFAULT_GENERATION_SETTINGS,
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
        createdAt: Date.now(),
      };
      appendMessage(sessionId, userMsg);
      const assistantId = makeId('msg');
      appendMessage(sessionId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        citations: [],
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
        transactions,
        generation,
      );
      return true;
    },
    [streaming, runStream],
  );
  return { streaming, send, stop };
}

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_INSPECTOR_SYSTEM_PROMPT, MAX_RESPONSE_CHARS } from '../ollama/client.ts';
import type { PreviewTransaction } from '../preview/transaction.ts';
import { MAX_PREVIEW_BLOCK_CHARS } from '../preview/contract.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import type { ChatMessage } from '../state/models.ts';
import type { ChatApi, ChatCompletion, OnChatComplete } from './useChat.ts';
import { useChat } from './useChat.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_URL = 'http://localhost:11434';
const MODEL = 'vision-model';

const VISIBLE = '## 디자이너 전달문\n\n대비를 높여주세요 [1]\n\n';
const PARTIAL = '## 디자이너 전달문\n\n본문 [1]\n\n';
const CANDIDATE = { version: 1 as const, rules: [{ target: 1, declarations: { 'border-radius': '10px' } }] };
const BLOCK_JSON = JSON.stringify({ version: 1, rules: [{ target: 1, declarations: { 'border-radius': '10px' } }] });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const openStreams: ManualStream[] = [];

afterEach(() => {
  for (const stream of openStreams.splice(0)) stream.close();
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.unstubAllGlobals();
});

interface ManualStream {
  response: Response;
  push: (line: Record<string, unknown>) => void;
  close: () => void;
}

function ndjson(lines: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
  );
}

function contentResponse(fragments: string[]): Response {
  return ndjson([
    ...fragments.map((fragment) => ({ message: { content: fragment } })),
    { done: true },
  ]);
}

function manualResponse(): ManualStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner;
    },
  });
  const handle: ManualStream = {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
    push: (line) => {
      controller?.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    },
    close: () => {
      try {
        controller?.close();
      } catch {
        return;
      }
    },
  };
  openStreams.push(handle);
  return handle;
}

interface RecordedRequest {
  url: string;
  messages: Array<{ role: string; content: string; images?: string[] }>;
}

function stubFetch(responder: (index: number) => Response): RecordedRequest[] {
  const log: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: RecordedRequest['messages'];
      };
      log.push({ url: String(input), messages: body.messages });
      return responder(log.length - 1);
    }),
  );
  return log;
}

interface PatchCall {
  sessionId: string;
  id: string;
  patch: Partial<ChatMessage> & { appendContent?: string };
}

interface Store {
  messages: Map<string, ChatMessage[]>;
  patches: PatchCall[];
  appendMessage: (sessionId: string, message: ChatMessage) => void;
  patchMessage: (sessionId: string, id: string, patch: Partial<ChatMessage> & { appendContent?: string }) => void;
}

function createStore(): Store {
  const messages = new Map<string, ChatMessage[]>();
  const patches: PatchCall[] = [];
  const appendMessage = (sessionId: string, message: ChatMessage): void => {
    patches.push({ sessionId, id: message.id, patch: { status: message.status } });
    const list = messages.get(sessionId) ?? [];
    list.push(message);
    messages.set(sessionId, list);
  };
  const patchMessage = (
    sessionId: string,
    id: string,
    patch: Partial<ChatMessage> & { appendContent?: string },
  ): void => {
    patches.push({ sessionId, id, patch });
    messages.set(
      sessionId,
      (messages.get(sessionId) ?? []).map((message) =>
        message.id === id
          ? {
              ...message,
              ...(patch.content !== undefined ? { content: patch.content } : {}),
              ...(patch.appendContent ? { content: message.content + patch.appendContent } : {}),
              ...(patch.status ? { status: patch.status } : {}),
              ...(patch.citations ? { citations: patch.citations } : {}),
            }
          : message,
      ),
    );
  };
  return { messages, patches, appendMessage, patchMessage };
}

function mountChat(): () => ChatApi {
  const holder: { current: ChatApi | null } = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Probe() {
    holder.current = useChat();
    return null;
  }
  act(() => root.render(createElement(Probe)));
  mounted.push({ root, container });
  return () => {
    if (holder.current === null) throw new Error('useChat was not mounted');
    return holder.current;
  };
}

async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function record(overrides: Partial<SelectionRecord> = {}): SelectionRecord {
  return {
    selectionId: 's1',
    elementKey: 'button.primary',
    component: 'PrimaryButton',
    file: 'src/ui/Button.tsx',
    line: 42,
    mode: 'html',
    state: 'active',
    order: 0,
    ...overrides,
  };
}

const SELECTION = record();
const DISPLAY_NUMBERS = new Map([['s1', 1]]);

const PREVIEW_TRANSACTION: PreviewTransaction = {
  id: 'tx-1',
  assistantId: 'a-prev',
  userMessageId: 'u-prev',
  sessionId: 'session-a',
  targetUrl: 'http://target.test',
  routeKey: '/',
  changes: [
    {
      target: 1,
      anchor: {
        elementKey: 'html:testid:cta',
        routeKey: '/',
        mode: 'html',
        tagName: 'button',
        id: '',
        testId: 'cta',
        path: '',
      },
      declarations: { padding: '12px' },
    },
  ],
  enabled: true,
  status: 'applied',
  createdAt: 1,
  updatedAt: 1,
};

function transaction(): [PreviewTransaction] {
  return [PREVIEW_TRANSACTION];
}

function decidedMessage(): ChatMessage {
  return {
    id: 'a-prev',
    role: 'assistant',
    content: '이전 답변',
    citations: [
      {
        selectionId: 's1',
        elementKey: 'html:testid:cta',
        component: 'PrimaryButton',
        file: null,
        line: null,
        mode: 'html',
        displayNumber: 1,
      },
    ],
    status: 'completed',
    decision: 'accepted',
    createdAt: 1,
    previewTransactionId: 'tx-1',
  };
}

function lastSystemPrompt(log: RecordedRequest[]): string {
  return log.at(-1)?.messages.find((m) => m.role === 'system')?.content ?? '';
}

async function send(
  api: () => ChatApi,
  store: Store,
  sessionId: string,
  text: string,
  onComplete?: OnChatComplete,
  transactions: readonly PreviewTransaction[] = [],
  history?: ChatMessage[],
): Promise<boolean> {
  let accepted = false;
  await act(async () => {
    accepted = await api().send(
      sessionId,
      text,
      [SELECTION],
      DISPLAY_NUMBERS,
      undefined,
      store.appendMessage,
      store.patchMessage,
      history ?? store.messages.get(sessionId) ?? [],
      BASE_URL,
      MODEL,
      onComplete,
      transactions,
    );
  });
  await settle();
  return accepted;
}


function messagesOf(store: Store, sessionId: string): ChatMessage[] {
  return store.messages.get(sessionId) ?? [];
}

function userMessage(store: Store, sessionId: string): ChatMessage {
  const found = messagesOf(store, sessionId).find((message) => message.role === 'user');
  if (found === undefined) throw new Error('user message missing');
  return found;
}

function assistantMessages(store: Store, sessionId: string): ChatMessage[] {
  return messagesOf(store, sessionId).filter((message) => message.role === 'assistant');
}

function lastAssistant(store: Store, sessionId: string): ChatMessage {
  const found = assistantMessages(store, sessionId).at(-1);
  if (found === undefined) throw new Error('assistant message missing');
  return found;
}

const blockFragments = (json: string): string[] => [
  '## 디자이너 전달문\n\n',
  '대비를 높여주세요 [1]\n\n',
  '```design-inspec',
  'tor-preview\n',
  `${json}\n`,
  '```\n',
];

describe('useChat streaming with the preview sidecar', () => {
  it('sends the English system instruction first and the Korean request last', async () => {
    const store = createStore();
    const log = stubFetch(() => contentResponse(['본문 [1]\n']));
    const api = mountChat();
    expect(await send(api, store, 'session-a', '시각 개선안')).toBe(true);
    const messages = log[0]?.messages ?? [];
    expect(log[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(messages[0]).toEqual({ role: 'system', content: DESIGN_INSPECTOR_SYSTEM_PROMPT });
    expect(messages[0]?.content).toContain('Respond entirely in Korean');
    expect(messages.at(-1)).toMatchObject({ role: 'user' });
    const sent = String(messages.at(-1)?.content);
    expect(sent.startsWith('Inspected UI citations:\n({1}) PrimaryButton')).toBe(true);
    // No visual was attached, so the model is told so instead of being left to
    // guess (§9e).
    expect(sent).toContain('No image is attached to this request.');
    expect(sent.endsWith('User request:\n시각 개선안')).toBe(true);
  });

  it('persists only sanitized Markdown and reports a clean candidate', async () => {
    const store = createStore();
    stubFetch(() => contentResponse(blockFragments(BLOCK_JSON)));
    const api = mountChat();
    const onComplete = vi.fn<(completion: ChatCompletion) => void>();
    expect(await send(api, store, 'session-a', '시각 개선안', onComplete)).toBe(true);
    const assistant = lastAssistant(store, 'session-a');
    const user = userMessage(store, 'session-a');
    expect(assistant.status).toBe('completed');
    expect(assistant.content).toBe(VISIBLE);
    expect(assistant.content).not.toContain('design-inspector-preview');
    expect(assistant.content).not.toContain('"version"');
    expect(JSON.stringify(store.messages.get('session-a'))).not.toContain('design-inspector-preview');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      sessionId: 'session-a',
      assistantId: assistant.id,
      userMessageId: user.id,
      candidate: CANDIDATE,
      citations: user.citations,
      content: VISIBLE,
      truncated: false,
      errored: false,
    });
  });

  it('stores the request citations on the answer, so its markers resolve', async () => {
    const store = createStore();
    stubFetch(() => contentResponse(['## 전달문\n\n여백을 조정했습니다 ({1})\n\n']));
    const api = mountChat();
    expect(await send(api, store, 'session-a', 'make ({1}) roomier')).toBe(true);

    const assistant = lastAssistant(store, 'session-a');
    // The answer cites the components of the request it is answering, so the
    // `({1})` in its prose has something to point at.
    expect(assistant.citations).toEqual(userMessage(store, 'session-a').citations);
    expect(assistant.citations[0]?.displayNumber).toBe(1);
  });

  it('carries the settled decisions into the next request', async () => {
    // Settling happens before the prompt is built, so the transactions the
    // caller passes in have to reach the system message.
    const store = createStore();
    const log = stubFetch(() => contentResponse(['응답\n\n']));
    const api = mountChat();
    await send(api, store, 'session-a', '첫 요청');
    expect(lastSystemPrompt(log)).not.toContain('PrimaryButton: padding 12px');

    const withDecision = [decidedMessage(), ...(store.messages.get('session-a') ?? [])];
    await send(
      api,
      store,
      'session-a',
      '두번째 요청',
      undefined,
      transaction(),
      withDecision,
    );
    const second = lastSystemPrompt(log);
    expect(second).toContain('Changes already decided in this session');
    expect(second).toContain('- [accept] PrimaryButton: padding 12px');
  });
  it('reports a clean completion without a candidate when no block is emitted', async () => {
    const store = createStore();
    stubFetch(() => contentResponse(['## 디자이너 전달문\n\n본문 [1]\n']));
    const api = mountChat();
    const onComplete = vi.fn<(completion: ChatCompletion) => void>();
    await send(api, store, 'session-a', '요약만', onComplete);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0].candidate).toBeNull();
    expect(onComplete.mock.calls[0]?.[0].content).toBe('## 디자이너 전달문\n\n본문 [1]\n');
  });

  it('ignores malformed, invalid, and oversized machine blocks', async () => {
    const cases: Array<[string, string]> = [
      ['malformed', '{"version":1,'],
      ['unknown citation', JSON.stringify({ version: 1, rules: [{ target: 9, declarations: { color: 'red' } }] })],
      [
        'oversized',
        JSON.stringify({
          version: 1,
          rules: [{ target: 1, declarations: { 'font-family': `"${'a'.repeat(MAX_PREVIEW_BLOCK_CHARS + 400)}"` } }],
        }),
      ],
    ];
    for (const [label, json] of cases) {
      const store = createStore();
      stubFetch(() => contentResponse(blockFragments(json)));
      const api = mountChat();
      const onComplete = vi.fn<(completion: ChatCompletion) => void>();
      await send(api, store, 'session-a', '시각 개선안', onComplete);
      const assistant = lastAssistant(store, 'session-a');
      expect({ label, status: assistant.status }).toEqual({ label, status: 'completed' });
      expect({ label, content: assistant.content }).toEqual({ label, content: VISIBLE });
      expect({ label, candidate: onComplete.mock.calls[0]?.[0].candidate }).toEqual({
        label,
        candidate: null,
      });
      expect(onComplete.mock.calls[0]?.[0].errored).toBe(false);
    }
  });

  it('does not report a completion when the user stops the stream', async () => {
    const store = createStore();
    const stream = manualResponse();
    stubFetch(() => stream.response);
    const api = mountChat();
    const onComplete = vi.fn<(completion: ChatCompletion) => void>();
    await act(async () => {
      await api().send(
        'session-a',
        '시각 개선안',
        [SELECTION],
        DISPLAY_NUMBERS,
        undefined,
        store.appendMessage,
        store.patchMessage,
        [],
        BASE_URL,
        MODEL,
        onComplete,
      );
    });
    await settle();
    stream.push({ message: { content: `${PARTIAL}\`\`\`design-inspector-preview\n` } });
    await settle();
    await act(async () => {
      api().stop();
    });
    stream.close();
    await settle();
    const assistant = lastAssistant(store, 'session-a');
    expect(assistant.status).toBe('interrupted');
    expect(assistant.content).toBe(PARTIAL);
    expect(assistant.content).not.toContain('design-inspector-preview');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not report a completion when the transport fails', async () => {
    const store = createStore();
    stubFetch(() => new Response('', { status: 500 }));
    const api = mountChat();
    const onComplete = vi.fn<(completion: ChatCompletion) => void>();
    await send(api, store, 'session-a', '시각 개선안', onComplete);
    const assistant = lastAssistant(store, 'session-a');
    expect(assistant.status).toBe('error');
    expect(assistant.content).toBe('Error: Ollama chat failed: HTTP 500');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not report a completion when the server reports an inline error', async () => {
    const store = createStore();
    stubFetch(() =>
      ndjson([{ message: { content: '## 디자이너 전달문\n' } }, { error: 'model not found' }, { done: true }]),
    );
    const api = mountChat();
    const onComplete = vi.fn<(completion: ChatCompletion) => void>();
    await send(api, store, 'session-a', '시각 개선안', onComplete);
    const assistant = lastAssistant(store, 'session-a');
    expect(assistant.status).toBe('error');
    expect(assistant.content).toBe('## 디자이너 전달문\n');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not report a completion when the response cap truncates the stream', async () => {
    const store = createStore();
    const filler = '가'.repeat(20_000);
    stubFetch(() =>
      contentResponse([
        '## 디자이너 전달문\n\n',
        filler,
        `${filler}\n`,
        `${filler}다`,
        '```design-inspector-preview\n',
        `${BLOCK_JSON}\n`,
        '```\n',
      ]),
    );
    const api = mountChat();
    const onComplete = vi.fn<(completion: ChatCompletion) => void>();
    await send(api, store, 'session-a', '긴 응답', onComplete);
    const assistant = lastAssistant(store, 'session-a');
    expect(assistant.status).toBe('completed');
    expect(assistant.content.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(assistant.content).not.toContain('design-inspector-preview');
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('useChat attempt identity guards', () => {  it('keeps an interrupted attempt from publishing content or a completion in a newer session', async () => {
    const store = createStore();
    const first = manualResponse();
    const log = stubFetch((index) => (index === 0 ? first.response : contentResponse(blockFragments(BLOCK_JSON))));
    const api = mountChat();
    const onFirstComplete = vi.fn<(completion: ChatCompletion) => void>();
    await act(async () => {
      await api().send(
        'session-a',
        '시각 개선안',
        [SELECTION],
        DISPLAY_NUMBERS,
        undefined,
        store.appendMessage,
        store.patchMessage,
        [],
        BASE_URL,
        MODEL,
        onFirstComplete,
      );
    });
    await settle();
    first.push({
      message: { content: `${PARTIAL}\`\`\`design-inspector-preview\n{"version":1,"rules":[{"target":1,` },
    });
    await settle();
    const firstAssistant = lastAssistant(store, 'session-a');
    await act(async () => {
      api().stop();
    });
    first.close();
    await settle();
    expect(lastAssistant(store, 'session-a').status).toBe('interrupted');
    expect(onFirstComplete).not.toHaveBeenCalled();
    const patchMark = store.patches.length;

    const onSecondComplete = vi.fn<(completion: ChatCompletion) => void>();
    await send(api, store, 'session-b', '다른 세션 요청', onSecondComplete);
    const secondAssistant = lastAssistant(store, 'session-b');
    expect(secondAssistant.status).toBe('completed');
    expect(secondAssistant.content).toBe(VISIBLE);
    expect(onSecondComplete).toHaveBeenCalledTimes(1);
    expect(onSecondComplete.mock.calls[0]?.[0].sessionId).toBe('session-b');
    expect(onSecondComplete.mock.calls[0]?.[0].assistantId).toBe(secondAssistant.id);
    expect(onSecondComplete.mock.calls[0]?.[0].candidate).toEqual(CANDIDATE);
    expect(store.patches.slice(patchMark).every((call) => call.id !== firstAssistant.id)).toBe(true);
    expect(lastAssistant(store, 'session-a').content).toBe(PARTIAL);
    expect(log).toHaveLength(2);
  });
});

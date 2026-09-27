// The stage-one classifier. No network: `fetch` is stubbed and the request body
// is asserted rather than issued, because what matters is the shape of the call
// (raw text only, no images, a 12-token budget) and the parse, not the model.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewIntent } from './intent.ts';
import {
  classifyRoute,
  parseRouteLabel,
  routeContextLine,
  ROUTE_NUM_PREDICT,
  ROUTE_SYSTEM_PROMPT,
} from './route.ts';
import { DEFAULT_GENERATION_SETTINGS } from './params.ts';

const BASE_URL = 'http://localhost:11434';

afterEach(() => {
  vi.unstubAllGlobals();
});

function labelResponse(content: unknown, ok = true): Response {
  return new Response(JSON.stringify({ message: { content } }), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Recorded {
  url: string;
  body: {
    model?: string;
    think?: unknown;
    options?: { num_predict?: number; temperature?: number };
    messages?: Array<{ role: string; content: string; images?: string[] }>;
    stream?: boolean;
  };
}

function stubRoute(response: () => Response): Recorded[] {
  const log: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      log.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Recorded['body'] });
      return response();
    }),
  );
  return log;
}

function classify(rawRequest = '간격 16px로 바꿔줘') {
  return classifyRoute({
    baseUrl: `${BASE_URL}/`,
    model: 'qwen3:8b',
    rawRequest,
    signal: new AbortController().signal,
  });
}

/**
 * The eight phrasings the deterministic gate is measured on, from
 * docs/VERIFICATION_REPORT.md. They are the cases the router has to agree with
 * if it is going to be worth a second model call.
 */
const RECORDED_CASES: ReadonlyArray<{ request: string; expected: 'CHANGE' | 'ANSWER' }> = [
  { request: '이거 디자이너한테 전달문 만들어줘', expected: 'ANSWER' },
  { request: '이 변경 사항을 디자이너에게 전달할 문구 만들어줘', expected: 'ANSWER' },
  { request: '이걸 디자이너한테 보낼 문구 써줘', expected: 'ANSWER' },
  { request: '안내문 좀 만들어줘', expected: 'ANSWER' },
  { request: '공지 문구 부탁해', expected: 'ANSWER' },
  { request: '전달용 카피 써줘', expected: 'ANSWER' },
  { request: '리뷰만 해줘', expected: 'ANSWER' },
  { request: 'write a handoff note for this', expected: 'ANSWER' },
  { request: '간격 16px로 바꿔줘', expected: 'CHANGE' },
  { request: '이 컴포넌트 어때?', expected: 'CHANGE' },
];

describe('parseRouteLabel', () => {
  it('accepts the bare label in any case, with surrounding whitespace', () => {
    expect(parseRouteLabel('CHANGE')).toBe('CHANGE');
    expect(parseRouteLabel('change')).toBe('CHANGE');
    expect(parseRouteLabel('  Answer\n')).toBe('ANSWER');
    expect(parseRouteLabel('\tANSWER  ')).toBe('ANSWER');
  });

  it('returns null for anything that is not the label alone', () => {
    // A lenient parse is how a 9B's one sentence of reasoning becomes a verdict.
    // Every one of these was a real shape: a prefix, a full stop, an explanation.
    for (const reply of [
      '',
      '   ',
      'CHANGES',
      'CHANGE.',
      'Route: CHANGE',
      'The user wants a change',
      'CHANGE or ANSWER',
      'ANSWER\nCHANGE',
      'MAYBE',
      'CH',
    ]) {
      expect({ reply, label: parseRouteLabel(reply) }).toEqual({ reply, label: null });
    }
    expect(parseRouteLabel(undefined as unknown as string)).toBeNull();
  });
});

describe('classifyRoute', () => {
  it('sends the raw request text and nothing else', async () => {
    // Stage one is on the critical path of every turn. A turn carrying four
    // screenshots spends about 4200 of an 8192-token window on the prompt, and
    // that is the cost this call exists to avoid paying.
    const log = stubRoute(() => labelResponse('CHANGE'));
    expect(await classify()).toBe('CHANGE');
    expect(log).toHaveLength(1);
    expect(log[0]?.url).toBe(`${BASE_URL}/api/chat`);
    const body = log[0]?.body;
    expect(body?.stream).toBe(false);
    // The reasoning channel is off, and it is off in the form the server
    // accepts: Ollama rejects the string "off" with a 400.
    expect(body?.think).toBe(false);
    expect(body?.options).toEqual({
      num_ctx: DEFAULT_GENERATION_SETTINGS.numCtx,
      temperature: DEFAULT_GENERATION_SETTINGS.temperature,
      repeat_penalty: DEFAULT_GENERATION_SETTINGS.repeatPenalty,
      repeat_last_n: DEFAULT_GENERATION_SETTINGS.repeatLastN,
      num_predict: ROUTE_NUM_PREDICT,
      seed: DEFAULT_GENERATION_SETTINGS.seed,
    });
    expect(body?.messages).toEqual([
      { role: 'system', content: ROUTE_SYSTEM_PROMPT },
      { role: 'user', content: '간격 16px로 바꿔줘' },
    ]);
    // No facts, no citation list, no history, and above all no images.
    const sent = JSON.stringify(body);
    expect(sent).not.toContain('images');
    expect(sent).not.toContain('Component facts');
    expect(sent).not.toContain('Inspected UI citations');
  });

  it('caps the reply so stage one can only emit the label', () => {
    expect(ROUTE_NUM_PREDICT).toBeLessThanOrEqual(12);
    // A system prompt long enough to discuss is a system prompt with something
    // to get wrong in it.
    expect(ROUTE_SYSTEM_PROMPT.split('\n').length).toBeLessThanOrEqual(6);
    expect(ROUTE_SYSTEM_PROMPT).toContain('CHANGE');
    expect(ROUTE_SYSTEM_PROMPT).toContain('ANSWER');
  });

  it('returns the label when the model obeys, case included', async () => {
    stubRoute(() => labelResponse(' answer \n'));
    expect(await classify()).toBe('ANSWER');
  });

  it('returns null on every failure mode, and never throws', async () => {
    const cases: Array<[string, () => Response]> = [
      ['http error', () => labelResponse('CHANGE', false)],
      ['unparseable body', () => new Response('not json', { status: 200 })],
      ['no message field', () => new Response('{}', { status: 200 })],
      ['non-string content', () => labelResponse(7)],
      ['wordy answer', () => labelResponse('Route: CHANGE')],
      ['network failure', () => { throw new TypeError('Failed to fetch'); }],
    ];
    for (const [label, response] of cases) {
      stubRoute(response);
      await expect(classify(), label).resolves.toBeNull();
    }
  });

  it('returns null rather than throwing when the request itself is malformed', async () => {
    // The whole safety argument downstream is that a routing problem is an
    // ordinary `null`. Reading a missing field before the try block would turn a
    // verdict into a rejected promise, and a rejected promise at this call site
    // is a turn with no answer.
    stubRoute(() => labelResponse('CHANGE', true));
    for (const [label, bad] of [
      ['no baseUrl', { model: 'm', rawRequest: 'q', signal: new AbortController().signal }],
      ['no signal', { baseUrl: 'http://x.test', model: 'm', rawRequest: 'q' }],
      ['not an object', null],
      ['undefined', undefined],
    ] as Array<[string, unknown]>) {
      await expect(classifyRoute(bad as never), label).resolves.toBeNull();
    }
  });

  it('gives up on its own deadline instead of delaying the answer', async () => {
    // Never resolves: the point of the timeout is that stage one cannot sit on
    // the critical path of a turn the user is waiting on.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );
    const started = Date.now();
    expect(
      await classifyRoute({
        baseUrl: BASE_URL,
        model: 'm',
        rawRequest: '질문',
        signal: new AbortController().signal,
        timeoutMs: 20,
      }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops when the turn is aborted', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );
    const pending = classifyRoute({
      baseUrl: BASE_URL,
      model: 'm',
      rawRequest: '질문',
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBeNull();
  });
});

describe('routeContextLine', () => {
  it('reports the router verdict when the gate allows the request', () => {
    expect(routeContextLine('간격 16px로 바꿔줘', 'CHANGE')).toBe(
      'Route: CHANGE — the user asked for a change to the page.',
    );
    expect(routeContextLine('이 컴포넌트 어때?', 'ANSWER')).toBe(
      'Route: ANSWER — the user asked a question about the current state.',
    );
  });

  it('says nothing at all when the router had no verdict', () => {
    // The failure mode is not a third opinion, it is no opinion: the turn then
    // reaches the model as it did before stage one existed, so a routing
    // failure cannot cost a request its preview.
    expect(routeContextLine('간격 16px로 바꿔줘', null)).toBeNull();
    expect(routeContextLine('이 컴포넌트 어때?', null)).toBeNull();
  });

  it('lets the router subtract but never add a preview', () => {
    // The safety property, stated as a test: a wrong CHANGE verdict must not be
    // able to talk stage two into treating a handoff request as a change.
    for (const { request, expected } of RECORDED_CASES) {
      const allows = previewIntent(request).allowPreview;
      expect({ request, allows }).toEqual({ request, allows: expected === 'CHANGE' });
      expect({ request, forced: routeContextLine(request, 'CHANGE') }).toEqual({
        request,
        forced: allows ? 'Route: CHANGE — the user asked for a change to the page.' : 'Route: ANSWER — the user asked a question about the current state.',
      });
    }
  });

  it('falls back to the deterministic gate when the router returns null', () => {
    // `null` is where the gate is actually load-bearing, so the fallback is
    // read from previewIntent rather than reimplemented: the gate's 8/8 record
    // on these phrasings cannot be weakened by a second opinion.
    for (const { request, expected } of RECORDED_CASES) {
      const line = routeContextLine(request, null);
      if (expected === 'CHANGE') {
        expect({ request, line }).toEqual({ request, line: null });
      } else {
        expect({ request, line }).toEqual({
          request,
          line: 'Route: ANSWER — the user asked a question about the current state.',
        });
      }
    }
  });

  it('never produces a CHANGE line for a request the gate suppresses', () => {
    const suppressed = RECORDED_CASES.filter(({ expected }) => expected === 'ANSWER').map(({ request }) => request);
    for (const request of suppressed) {
      for (const label of ['CHANGE', 'ANSWER', null] as const) {
        expect({ request, label, line: routeContextLine(request, label) }).not.toContain('CHANGE');
      }
    }
  });
});

// Stage one of a two-stage turn: is this a change request or a question?
//
// The product asks one model to judge intent, read every measured value, write
// the answer and emit the machine block, all in one pass. On a real 9B that
// pass is where things go wrong: the same turn answers correctly on one run and
// restyles a page the user only asked about on the next. Splitting it puts the
// single cheapest possible decision in its own call, where it has one job and
// a 12-token budget.
//
// What this deliberately cannot do is force a preview. `previewIntent` remains
// the enforcement, and the model may only subtract from it: a CHANGE verdict on
// a request the gate has already suppressed still produces an ANSWER line. That
// asymmetry is the whole safety argument, so it lives in `routeContextLine`
// rather than at the call site.
//
// The request text is the entire input. No images, no component facts, no
// history: a turn carrying four screenshots spends about 4200 of an 8192-token
// window on the prompt alone, and that is exactly the cost stage one must not
// pay. The facts would also be the thing that tempts a verdict about the page
// rather than about the request.

import { previewIntent } from './intent.ts';
import { buildChatControls, DEFAULT_GENERATION_SETTINGS } from './params.ts';

export type RouteLabel = 'CHANGE' | 'ANSWER';

/** Short enough to act as a formatting rule rather than a topic to discuss. */
export const ROUTE_SYSTEM_PROMPT = `Decide what the user is asking for.
CHANGE: they want the page itself altered.
ANSWER: they want to know, be told, or given text, and nothing should be altered.
Reply with one word, CHANGE or ANSWER, and nothing else.`;

/**
 * Enough for the label and a little whitespace, not enough for a sentence.
 * A router that can write a paragraph has something to get wrong in it.
 */
export const ROUTE_NUM_PREDICT = 12;


/**
 * Stage one is on the critical path of every turn, so it gets a deadline. The
 * main completion is seconds; a router slower than this is not worth its
 * latency and its answer is worth less than no answer.
 */
export const ROUTE_TIMEOUT_MS = 4_000;

const CHANGE_LINE = 'Route: CHANGE — the user asked for a change to the page.';
const ANSWER_LINE = 'Route: ANSWER — the user asked a question about the current state.';

/**
 * Strict on purpose. A 9B asked for one word will sometimes answer
 * `Route: CHANGE` or `CHANGE.` or `The user wants a change`, and a lenient parse
 * would turn a ramble into a verdict. Anything but the bare label is no verdict
 * at all, and the turn then falls back to the deterministic gate.
 */
export function parseRouteLabel(reply: string): RouteLabel | null {
  if (typeof reply !== 'string') return null;
  const text = reply.trim().toUpperCase();
  if (text === 'CHANGE') return 'CHANGE';
  if (text === 'ANSWER') return 'ANSWER';
  return null;
}

export interface RouteRequest {
  baseUrl: string;
  model: string;
  /** The user's own words and nothing else. */
  rawRequest: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * One non-streaming call. Never throws and never rejects: every failure mode
 * below returns `null`, because a routing failure must not cost the user an
 * answer.
 */
export async function classifyRoute(request: RouteRequest): Promise<RouteLabel | null> {
  // Same normalization client.ts applies. Repeated rather than imported because
  // client.ts is the module that would import this one, and a value cycle
  // between the two is worse than a one-line repeat.
  //
  // Everything that reads the request lives inside the try, including the lines
  // above it in an earlier draft. The "never throws" promise below is what lets
  // the caller treat a routing problem as an ordinary `null`, and a promise a
  // missing field can break is not a promise.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    const base = request.baseUrl.trim().replace(/\/+$/, '');
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), request.timeoutMs ?? ROUTE_TIMEOUT_MS);
    onAbort = (): void => controller.abort();
    request.signal.addEventListener('abort', onAbort);
    // The same generation controls builder the main completion uses, so this call
    // cannot drift into a request shape the server rejects. The `'off'` level is
    // what `buildChatControls` turns into `think: false`; Ollama rejects the
    // string form outright, which is a 400 and no verdict at all.
    const controls = buildChatControls({
      ...DEFAULT_GENERATION_SETTINGS,
      think: 'off',
      numPredict: ROUTE_NUM_PREDICT,
    });
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        think: controls.think,
        options: controls.options,
        messages: [
          { role: 'system', content: ROUTE_SYSTEM_PROMPT },
          { role: 'user', content: request.rawRequest },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { message?: { content?: unknown } };
    const content = data.message?.content;
    return typeof content === 'string' ? parseRouteLabel(content) : null;
  } catch {
    return null;
  } finally {
    // Guarded, not bare: a throw from a `finally` block replaces the return
    // value, so an unguarded `request.signal` here would turn the `catch`'s
    // `null` back into a rejected promise for exactly the malformed requests
    // the try above was widened to survive.
    if (timer !== null) clearTimeout(timer);
    try {
      if (onAbort !== null) request.signal.removeEventListener('abort', onAbort);
    } catch {
      // Nothing left to clean up if the request object was never readable.
    }
  }
}

/**
 * The one line stage two sees, or `null` when the router had nothing to say.
 *
 * `null` is not a third answer. It means the classifier failed, timed out or
 * returned something unparseable, and the turn then proceeds exactly as it did
 * before stage one existed — which is why a routing failure cannot cost a
 * request its preview.
 */
export function routeContextLine(rawRequest: string, label: RouteLabel | null): string | null {
  // The gate wins. A router that says CHANGE for a handoff request may not talk
  // stage two into treating it as one.
  if (!previewIntent(rawRequest).allowPreview) return ANSWER_LINE;
  if (label === 'CHANGE') return CHANGE_LINE;
  if (label === 'ANSWER') return ANSWER_LINE;
  return null;
}

// Should this request be allowed to restyle the page? (§9e, §16.12)
//
// The prompt already tells the model that 바뀌지 마 and a handoff request mean
// no block. Twice. It emitted a block anyway, on a delivery-message request, in
// roughly one run in three. A prompt instruction is a suggestion sampled at
// temperature 0.8; this is a check.
//
// Scope is deliberately narrow and one-directional. Only NEGATIVE rules exist:
// each one suppresses a block. There is no "you must have said one of these
// words" rule, because that would invent a false negative for a perfectly valid
// request like "이거 좀 어색한데" and silently refuse to help. A false positive
// here costs the user a keystroke; a false negative restyles their product
// without asking.
//
// The one mixed-request case decides whether the narrow scope is safe: "전달문
//으로 정리하고 간격은 16px로" contains a suppression cue and a real change
// instruction. Suppressing it would be wrong, so a change cue beats a handoff
// cue — the gate only fires when nothing in the text asks for a change.

/** Explicit instructions not to change anything. Wins over everything. */
const NO_CHANGE = [
  /바꾸지\s*마/,
  /바꿀\s*필요\s*없/,
  /바꿀\s*필요\s*없다고/,
  /건드리지\s*마/,
  /손대지\s*마/,
  /그대로\s*둬/,
  /그대로\s*두세요/,
  /그대로\s*유지/,
  /그대로\s*두고/,
  /수정하지\s*마/,
  /수정하지\s*않/,
  /변경하지\s*마/,
  /건드리지\s*않/,
  // Korean negates with 안 and with a -지 ending about as often as with -마,
  // and "안 바꾸고 그대로 두고 싶어" is the ordinary way to ask for a review.
  // A gate that only recognized -마 would miss most of them.
  /안\s*(바꾸|바꿔|바꿀|바꿔|수정|변경|건드리|손대)/,
  /(바꾸|바꿔|바꿀|수정|변경|건드리|손대)[지질]\s*않/,
  /그대로\s*(두고|두는|두고\s*싶)/,
  /그대로\s*있/,
  /do\s*n[o']?t\s*change/i,
  /leave\s*it\s*(alone|as[\s-]?is)/i,
  /don'?t\s*(change|restyle|touch)/i,
  /no\s*changes?/i,
];

/**
 * Requests whose deliverable is text about the current state, not a change to
 * it. "안내문" is here because a handoff for other people is exactly the case
 * that produced a bogus block.
 *
 * The 전달 family is spelled several ways and the gate was caught missing one:
 * `전달할 문구 만들어줘` passed straight through `전달문`. Worth stating why that
 * is the dangerous direction — a text request that gets a live restyle is the
 * whole failure being prevented — and why a broad match is still acceptable:
 * these rules only ever suppress, and a change cue still wins.
 */
const NON_CHANGE_SHAPE = [
  /전달문/,
  /전달\s*(할|할\s*수\s*있는|용)?\s*(문구|메시지|텍스트|카피|내용|안내|참고)/,
  /안내문/,
  /안내\s*문구/,
  /공지\s*문구/,
  /공통\s*문구/,
  /리뷰만/,
  /리뷰\s*문구/,
  /handoff/i,
  /hand\s*off/i,
  /디자이너\s*에게\s*보낼/,
  /보낼\s*(문구|메시지|텍스트|카피)/,
  /설명만/,
  /정리만/,
  /요약만/,
  /알려줘만/,
  /알아보게/,
  /전달해줘/,
  /공유해줘/,
];

/**
 * A real instruction to change something. Beats NON_CHANGE_SHAPE.
 *
 * Only unambiguous style-changing verbs belong here. `정리` does not: "전달문으로
 * 정리해줘" is a request for text, and putting it here would let exactly the case
 * this gate exists for through the front door. `변경` is absent for the same
 * reason — "이 변경 사항을 전달할 문구 만들어줘" refers to changes already made.
 */
const CHANGE = [
  /바꿔줘/,
  /바꾸어줘/,
  /바꾸자/,
  /바꿔/,
  /바꾸고/,
  /적용해줘/,
  /적용\s*해/,
  /적용하자/,
  /반영해줘/,
  /반영\s*해/,
  /조정해줘/,
  /조정\s*해/,
  /조정하자/,
  /고쳐줘/,
  /고쳐\s*주/,
  /고쳐야/,
  /고쳐\b/,
  /수정해줘/,
  /손봐줘/,
  /손보게/,
  /개선해줘/,
  /늘려줘/,
  /늘리고/,
  /줄여줘/,
  /줄여/,
  /키워줘/,
  /키우고/,
  /작게\s*해줘/,
  /크게\s*해줘/,
  /\b(pad|padding|margin)\b/i,
  /\b(radius|rounded|corner)\b/i,
  /\bfont[\s-]?size\b/i,
  /\bcolor\b/i,
  /\bbg\b/i,
  /\bbackground\b/i,
  /\bborder\b/i,
  /\bgap\b/i,
  /\bapply\b/i,
  /\brestyle\b/i,
  /\bincrease\b/i,
  /\bdecrease\b/i,
  /\breduce\b/i,
  /\bfix\s+(it|this|the)\b/i,
  /\bset\s+(it|the|this)\b/i,
  /\bmake\s+it\b/i,
];

export type SuppressionReason = 'explicit-no-change' | 'non-change-shape';

export interface IntentVerdict {
  /** Whether a preview block may be applied from this request. */
  allowPreview: boolean;
  reason: SuppressionReason | null;
}

const OK: IntentVerdict = { allowPreview: true, reason: null };

/**
 * Decide from the user's own words, before the model has said anything.
 * Deliberately a pure function of the raw string: it runs on the request, not
 * on the answer, so a block that the model emits anyway can be dropped instead
 * of argued with.
 */
export function previewIntent(rawRequest: string): IntentVerdict {
  if (!rawRequest || !rawRequest.trim()) return OK;
  // An explicit "do not change this" is never overridden. The one thing the
  // model must not do is restyle a page the user told it to leave alone.
  if (NO_CHANGE.some((pattern) => pattern.test(rawRequest))) {
    return { allowPreview: false, reason: 'explicit-no-change' };
  }
  // A change instruction inside a text-shaped request still wins, so
  // "전달문으로 정리하고 간격은 16px로" keeps its block.
  if (CHANGE.some((pattern) => pattern.test(rawRequest))) return OK;
  if (NON_CHANGE_SHAPE.some((pattern) => pattern.test(rawRequest))) {
    return { allowPreview: false, reason: 'non-change-shape' };
  }
  return OK;
}

/**
 * Whether a block that is already inside the text should be stripped out. A
 * suppressed block is not shown as a pending card: offering the user a "yes,
 * apply this" button for a request they never made is worse than not offering
 * one, because the card itself asserts the change was wanted.
 */
export function shouldSuppressBlock(rawRequest: string): boolean {
  return !previewIntent(rawRequest).allowPreview;
}

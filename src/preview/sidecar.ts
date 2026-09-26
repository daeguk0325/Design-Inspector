import type { PreviewCandidate, PreviewCheck, PreviewValidationContext } from './contract.ts';
import { MAX_PREVIEW_BLOCK_CHARS, PREVIEW_BLOCK_LANGUAGE, validatePreviewBlock } from './contract.ts';

export interface PreviewSidecarDelta {
  text: string;
  candidate: PreviewCandidate | null;
}

export interface PreviewSidecarStats {
  blocksStripped: number;
  blocksInvalid: number;
  blocksOversized: number;
  blocksUnterminated: number;
  /** Opened through a misspelled info string. See NEAR_MISS_MAX_EDITS. */
  blocksNearMiss: number;
}

const OPENING_FENCE_RE = new RegExp('^`{3}' + PREVIEW_BLOCK_LANGUAGE + '[ \\t]*$', 'i');
const CLOSING_FENCE_RE = /^`{3,}[ \t]*$/;
const FENCE_INFO_RE = /^`{3,}([A-Za-z0-9][A-Za-z0-9 _-]*)[ \t]*$/;

/**
 * How wrong an info string may be and still count as an attempt at ours.
 *
 * Observed from a 9B model that had the exact tag in its context and wrote
 * `design-insector-preview` — one missing letter. Without a tolerance the
 * consequence is not a lost preview, it is the JSON payload printed into the
 * answer as visible text, because nothing recognises the fence. Two edits is
 * the bound: near enough to be a slip of the same token, far enough that
 * `design-inspector-preview-note` (5 edits) still stays ordinary prose, which
 * an existing test pins.
 *
 * What this deliberately does not fix: a partially streamed near-miss tag can
 * flash for a frame or two before the newline completes the line, because the
 * streaming guard only hides prefixes of the correct tag. Hiding every
 * unrecognised fence would mean hiding the user's code blocks too, and the
 * payload leaking is the part that has to be prevented.
 */
const NEAR_MISS_MAX_EDITS = 2;

/** Levenshtein, abandoned as soon as it exceeds `cap`. */
function editDistanceWithin(a: string, b: string, cap: number): boolean {
  if (Math.abs(a.length - b.length) > cap) return false;
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return false;
    previous = current;
  }
  return (previous[b.length] ?? cap + 1) <= cap;
}

function isNearMissInfo(info: string): boolean {
  const text = info.trim().toLowerCase();
  if (text.length === 0) return false;
  return editDistanceWithin(text, PREVIEW_BLOCK_LANGUAGE, NEAR_MISS_MAX_EDITS);
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TAG_PREFIX_PATTERN = [...PREVIEW_BLOCK_LANGUAGE].reduce<string>(
  (pattern, character) => `${pattern}(?:${escapeRegExp(character)}|$)`,
  '',
);

const AMBIGUOUS_FENCE_RE = new RegExp('^`{0,3}' + TAG_PREFIX_PATTERN + '[ \\t]*$', 'i');

const stripCarriageReturn = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

const isWhitespaceOnly = (value: string): boolean => /^\s*$/.test(value);

export class PreviewSidecarParser {
  private readonly context: PreviewValidationContext;
  private lineBuffer = '';
  private emittedLength = 0;
  private insideBlock = false;
  private blockLines: string[] = [];
  private blockChars = 0;
  private blockOversized = false;
  private blockNearMiss = false;
  private pendingBlock: string | null = null;
  private committed: PreviewCandidate | null = null;
  private finished = false;
  private stripped = 0;
  private invalid = 0;
  private oversized = 0;
  private unterminated = 0;
  private nearMiss = 0;

  constructor(context: PreviewValidationContext = {}) {
    this.context = context;
  }

  get candidate(): PreviewCandidate | null {
    return this.committed;
  }

  get hasOpenBlock(): boolean {
    return this.insideBlock;
  }

  get stats(): PreviewSidecarStats {
    return {
      blocksStripped: this.stripped,
      blocksInvalid: this.invalid,
      blocksOversized: this.oversized,
      blocksUnterminated: this.unterminated,
      blocksNearMiss: this.nearMiss,
    };
  }

  push(fragment: string): PreviewSidecarDelta {
    if (this.finished) return { text: '', candidate: null };
    if (typeof fragment !== 'string' || fragment === '') return { text: '', candidate: null };
    this.lineBuffer += fragment;
    let text = '';
    for (;;) {
      const index = this.lineBuffer.indexOf('\n');
      if (index < 0) break;
      const rawLine = this.lineBuffer.slice(0, index);
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      text += this.consumeLine(rawLine, true);
    }
    return { text: text + this.drainPartial(), candidate: null };
  }

  flush(): PreviewSidecarDelta {
    if (this.finished) return { text: '', candidate: null };
    let text = '';
    if (this.lineBuffer !== '') {
      const rawLine = this.lineBuffer;
      this.lineBuffer = '';
      text = this.consumeLine(rawLine, false);
    }
    if (this.insideBlock) {
      this.unterminated += 1;
      this.discardBlock();
    }
    this.finished = true;
    const pending = this.pendingBlock;
    this.pendingBlock = null;
    if (pending === null) return { text, candidate: this.committed };
    const check = this.validate(pending);
    if (!check.ok) {
      this.invalid += 1;
      return { text, candidate: null };
    }
    this.committed = check.candidate;
    return { text, candidate: check.candidate };
  }

  private validate(raw: string): PreviewCheck {
    return validatePreviewBlock(raw, this.context);
  }

  private drainPartial(): string {
    if (this.insideBlock) return '';
    if (this.lineBuffer.length <= this.emittedLength) return '';
    if (this.emittedLength === 0 && AMBIGUOUS_FENCE_RE.test(this.lineBuffer)) return '';
    const fresh = this.lineBuffer.slice(this.emittedLength);
    this.emittedLength = this.lineBuffer.length;
    return fresh;
  }

  private consumeLine(rawLine: string, withNewline: boolean): string {
    const line = stripCarriageReturn(rawLine);
    if (this.insideBlock) {
      if (CLOSING_FENCE_RE.test(line)) {
        this.closeBlock();
        this.emittedLength = 0;
        return '';
      }
      this.appendBlockLine(line);
      return '';
    }
    if (OPENING_FENCE_RE.test(line)) {
      this.pendingBlock = null;
      this.openBlock(false);
      this.emittedLength = 0;
      return '';
    }
    const nearMiss = FENCE_INFO_RE.exec(line);
    if (nearMiss !== null && isNearMissInfo(nearMiss[1] ?? '')) {
      this.pendingBlock = null;
      this.openBlock(true);
      this.emittedLength = 0;
      return '';
    }
    if (!isWhitespaceOnly(line)) this.pendingBlock = null;
    const fresh = rawLine.slice(Math.min(this.emittedLength, rawLine.length));
    this.emittedLength = 0;
    return withNewline ? `${fresh}\n` : fresh;
  }

  private openBlock(nearMiss: boolean): void {
    this.insideBlock = true;
    this.blockLines = [];
    this.blockChars = 0;
    this.blockOversized = false;
    this.blockNearMiss = nearMiss;
  }

  private appendBlockLine(line: string): void {
    if (this.blockOversized) return;
    this.blockChars += line.length + 1;
    if (this.blockChars > MAX_PREVIEW_BLOCK_CHARS) {
      this.blockOversized = true;
      this.blockLines = [];
      this.oversized += 1;
      return;
    }
    this.blockLines.push(line);
  }

  private discardBlock(): void {
    this.insideBlock = false;
    this.blockLines = [];
    this.blockChars = 0;
    this.blockOversized = false;
    this.blockNearMiss = false;
  }

  private closeBlock(): void {
    const oversized = this.blockOversized;
    const nearMiss = this.blockNearMiss;
    const raw = this.blockLines.join('\n');
    this.discardBlock();
    this.stripped += 1;
    if (nearMiss) this.nearMiss += 1;
    if (oversized) return;
    if (isWhitespaceOnly(raw)) {
      this.invalid += 1;
      return;
    }
    this.pendingBlock = raw;
  }
}

export function createPreviewSidecarParser(
  context: PreviewValidationContext = {},
): PreviewSidecarParser {
  return new PreviewSidecarParser(context);
}

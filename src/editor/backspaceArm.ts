export const BACKSPACE_ARM_WINDOW_MS = 1500;

export interface ArmedAttachment {
  selectionId: string;
  caret: string;
  armedAt: number;
}

export interface BackspaceArmState {
  armed: ArmedAttachment | null;
}

export interface BackspacePress {
  selectionId: string | null;
  caret: string;
  repeat?: boolean;
  composing?: boolean;
  modified?: boolean;
}

export type BackspaceDecision =
  | { kind: 'ignored'; reason: 'composing' | 'modified' }
  | { kind: 'passthrough'; reason: 'no-attachment' | 'repeat' | 'range' }
  | { kind: 'armed'; selectionId: string }
  | { kind: 'remove'; selectionId: string };

export function createBackspaceArmState(): BackspaceArmState {
  return { armed: null };
}

export function isBackspaceArmed(
  state: BackspaceArmState,
  selectionId: string,
  caret: string,
  now: number,
  windowMs: number = BACKSPACE_ARM_WINDOW_MS,
): boolean {
  const armed = state.armed;
  if (!armed) return false;
  if (armed.selectionId !== selectionId || armed.caret !== caret) return false;
  return now - armed.armedAt <= windowMs;
}

/**
 * Two-step removal: the first press arms the tag so an accidental keystroke
 * cannot destroy a citation, the second one removes it.
 *
 * Order matters here. `repeat` used to be rejected first, which meant a held
 * Backspace did nothing at all — the decision came back `ignored` and the
 * caller still called `preventDefault()`, so the browser never got a chance to
 * run its own repeat deletion. A repeat is now only consulted once we know a
 * tag is actually in the way, and it resolves to `passthrough` so the platform
 * deletes the character behind the caret.
 */
export function decideBackspace(
  state: BackspaceArmState,
  press: BackspacePress,
  now: number,
  windowMs: number = BACKSPACE_ARM_WINDOW_MS,
): { state: BackspaceArmState; decision: BackspaceDecision } {
  if (press.composing === true) {
    return { state, decision: { kind: 'ignored', reason: 'composing' } };
  }
  if (press.modified === true) {
    return { state, decision: { kind: 'ignored', reason: 'modified' } };
  }
  if (press.selectionId === null) {
    return { state: createBackspaceArmState(), decision: { kind: 'passthrough', reason: 'no-attachment' } };
  }
  // Holding the key next to a tag means "keep deleting", not "delete the tag".
  // Abandoning the arm here is what makes a held Backspace run through the text.
  if (press.repeat === true) {
    return { state: createBackspaceArmState(), decision: { kind: 'passthrough', reason: 'repeat' } };
  }
  if (isBackspaceArmed(state, press.selectionId, press.caret, now, windowMs)) {
    return { state: createBackspaceArmState(), decision: { kind: 'remove', selectionId: press.selectionId } };
  }
  return {
    state: { armed: { selectionId: press.selectionId, caret: press.caret, armedAt: now } },
    decision: { kind: 'armed', selectionId: press.selectionId },
  };
}

export interface BackspaceArmControllerOptions {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (handle: number) => void;
  onArmChange?: (selectionId: string | null) => void;
  windowMs?: number;
}

export interface BackspaceArmController {
  press: (press: BackspacePress) => BackspaceDecision;
  isArmed: (selectionId: string, caret: string) => boolean;
  matchesCaret: (caret: string) => boolean;
  disarm: () => void;
  dispose: () => void;
}

export function createBackspaceArmController(
  options: BackspaceArmControllerOptions = {},
): BackspaceArmController {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => window.clearTimeout(handle));
  const windowMs = options.windowMs ?? BACKSPACE_ARM_WINDOW_MS;
  let state = createBackspaceArmState();
  let timer: number | null = null;

  function clearTimer(): void {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function disarm(): void {
    clearTimer();
    if (state.armed === null) return;
    state = createBackspaceArmState();
    options.onArmChange?.(null);
  }

  return {
    press(press: BackspacePress): BackspaceDecision {
      const result = decideBackspace(state, press, now(), windowMs);
      if (result.decision.kind === 'ignored') return result.decision;
      const previousId = state.armed?.selectionId ?? null;
      state = result.state;
      clearTimer();
      if (result.decision.kind === 'armed') {
        timer = schedule(() => {
          timer = null;
          state = createBackspaceArmState();
          options.onArmChange?.(null);
        }, windowMs);
      }
      const nextId = state.armed?.selectionId ?? null;
      if (nextId !== previousId) options.onArmChange?.(nextId);
      return result.decision;
    },
    isArmed(selectionId: string, caret: string): boolean {
      return isBackspaceArmed(state, selectionId, caret, now(), windowMs);
    },
    matchesCaret(caret: string): boolean {
      const armed = state.armed;
      if (!armed) return false;
      if (now() - armed.armedAt > windowMs) {
        disarm();
        return false;
      }
      return armed.caret === caret;
    },
    disarm,
    dispose(): void {
      clearTimer();
      state = createBackspaceArmState();
    },
  };
}

/**
 * Eased scrolling for the chat jump buttons.
 *
 * `behavior: 'smooth'` would hand the curve to the browser, which is a different
 * feel on every engine and untestable here. easeInOutCubic starts fast and lands
 * soft — the accelerate-then-settle motion the buttons promise — and runs on
 * requestAnimationFrame so a long log does not jank through it.
 */

export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Distance-based duration: a short hop is quick, a full log never drags past 800ms. */
export function scrollDuration(distancePx: number): number {
  const distance = Math.abs(distancePx);
  if (distance <= 0) return 0;
  return Math.min(800, Math.max(280, Math.round(distance / 2.5)));
}

const active = new WeakMap<HTMLElement, number>();

function frameScheduler(): (cb: FrameRequestCallback) => number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb: FrameRequestCallback): number => window.setTimeout(() => cb(Date.now()), 16);
}

function cancelScheduler(): (handle: number) => void {
  return typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (handle: number): void => window.clearTimeout(handle);
}

/** Stops an in-flight jump, e.g. when the user grabs the wheel mid-flight. */
export function cancelChatScroll(element: HTMLElement): void {
  const handle = active.get(element);
  if (handle !== undefined) {
    cancelScheduler()(handle);
    active.delete(element);
  }
}

/**
 * Eases `element` to `target` scrollTop. A second call replaces the first, and
 * `prefers-reduced-motion` jumps straight there — motion is decoration, and
 * decoration must not override an access setting.
 */
export function smoothChatScroll(element: HTMLElement, target: number): void {
  cancelChatScroll(element);
  const from = element.scrollTop;
  const max = Math.max(0, element.scrollHeight - element.clientHeight);
  const to = Math.min(Math.max(0, target), max);
  const duration = scrollDuration(to - from);
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (duration === 0 || reduce) {
    element.scrollTop = to;
    return;
  }
  const schedule = frameScheduler();
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const step = (now: number): void => {
    const elapsed = now - startedAt;
    const progress = Math.min(1, elapsed / duration);
    element.scrollTop = from + (to - from) * easeInOutCubic(progress);
    if (progress < 1) {
      active.set(element, schedule(step));
    } else {
      active.delete(element);
    }
  };
  active.set(element, schedule(step));
}

/** How far the list is from each edge, in pixels. */
export function chatEdges(element: HTMLElement): { top: number; bottom: number } {
  const max = Math.max(0, element.scrollHeight - element.clientHeight);
  return { top: element.scrollTop, bottom: max - element.scrollTop };
}

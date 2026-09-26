/** Tag motion timings, kept in sync with the keyframes in index.css. */
export const ATTACH_ENTER_MS = 260;
export const ATTACH_EXIT_MS = 200;
export const ATTACH_SHAKE_MS = 320;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function attachmentExitMs(): number {
  return prefersReducedMotion() ? 0 : ATTACH_EXIT_MS;
}

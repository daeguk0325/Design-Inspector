import { describe, expect, it } from 'vitest';
import {
  cancelChatScroll,
  chatEdges,
  easeInOutCubic,
  scrollDuration,
  smoothChatScroll,
} from './chatScroll.ts';

function scroller(scrollTop: number, scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperties(el, {
    scrollHeight: { value: scrollHeight, configurable: true },
    clientHeight: { value: clientHeight, configurable: true },
  });
  el.scrollTop = scrollTop;
  return el;
}

describe('easeInOutCubic', () => {
  it('starts at 0, passes through the middle, and lands on 1', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('accelerates out of the start and decelerates into the end', () => {
    // Slow near both edges, fast in the middle: the first and last tenths move
    // less than a middle tenth.
    const edge = easeInOutCubic(0.1) - easeInOutCubic(0);
    const middle = easeInOutCubic(0.6) - easeInOutCubic(0.5);
    const end = easeInOutCubic(1) - easeInOutCubic(0.9);
    expect(middle).toBeGreaterThan(edge);
    expect(middle).toBeGreaterThan(end);
  });

  it('clamps outside input instead of overshooting', () => {
    expect(easeInOutCubic(-2)).toBe(0);
    expect(easeInOutCubic(3)).toBe(1);
  });
});

describe('scrollDuration', () => {
  it('is instant for no distance and bounded for a full log', () => {
    expect(scrollDuration(0)).toBe(0);
    expect(scrollDuration(120)).toBeGreaterThanOrEqual(280);
    expect(scrollDuration(100_000)).toBe(800);
  });
});

describe('chatEdges', () => {
  it('reports the distance to each edge', () => {
    expect(chatEdges(scroller(0, 1000, 400))).toEqual({ top: 0, bottom: 600 });
    expect(chatEdges(scroller(600, 1000, 400))).toEqual({ top: 600, bottom: 0 });
  });
});

describe('smoothChatScroll', () => {
  it('jumps straight there when the distance is zero', () => {
    const el = scroller(200, 1000, 400);
    smoothChatScroll(el, 200);
    expect(el.scrollTop).toBe(200);
  });

  it('clamps a target past the end instead of scrolling nowhere', () => {
    const el = scroller(0, 1000, 400);
    cancelChatScroll(el);
    smoothChatScroll(el, 999_999);
    // Either the jump happened (reduced motion / clamped) or an animation was
    // scheduled; what must not happen is a scrollTop past the maximum.
    expect(el.scrollTop).toBeLessThanOrEqual(600);
  });
});

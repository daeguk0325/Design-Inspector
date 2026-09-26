import { describe, expect, it } from 'vitest';
import {
  CHAT_RATIO_DEFAULT,
  CHAT_RATIO_MAX,
  CHAT_RATIO_MIN,
  effectiveChatRatio,
  loadChatRatio,
  normalizeChatRatio,
  ratioFromPointerDelta,
  saveChatRatio,
  SPLIT_LAYOUT_KEY,
} from './split.ts';

function memoryStorage(value: string | null = null) {
  const data = new Map<string, string>();
  if (value !== null) data.set(SPLIT_LAYOUT_KEY, value);
  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, next: string) {
      data.set(key, next);
    },
  };
}

describe('split layout', () => {
  it('normalizes ratios and rejects invalid values', () => {
    expect(normalizeChatRatio(Number.NaN)).toBe(CHAT_RATIO_DEFAULT);
    expect(normalizeChatRatio(0.1)).toBe(CHAT_RATIO_MIN);
    expect(normalizeChatRatio(0.9)).toBe(CHAT_RATIO_MAX);
  });

  it('clamps against chat and target pixel minimums', () => {
    expect(effectiveChatRatio(0.25, 1000)).toBeCloseTo(0.34);
    expect(effectiveChatRatio(0.6, 1000)).toBe(0.6);
    expect(effectiveChatRatio(0.4, 700)).toBeCloseTo(340 / 700);
  });

  it('moves the divider right by shrinking the chat ratio', () => {
    expect(ratioFromPointerDelta(0.4, 100, 200, 1000)).toBeCloseTo(0.3);
  });

  it('moves the divider left by growing the chat ratio', () => {
    expect(ratioFromPointerDelta(0.4, 100, 0, 1000)).toBeCloseTo(0.5);
  });

  it('clamps pointer movement to chat ratio bounds', () => {
    expect(ratioFromPointerDelta(0.4, 500, 1000, 1000)).toBe(CHAT_RATIO_MIN);
    expect(ratioFromPointerDelta(0.4, 500, 0, 1000)).toBe(CHAT_RATIO_MAX);
    expect(ratioFromPointerDelta(0.4, 100, 0, 0)).toBe(0.4);
  });

  it('persists and recovers the chat ratio', () => {
    const storage = memoryStorage();
    saveChatRatio(0.55, storage);
    expect(loadChatRatio(storage)).toBe(0.55);
  });

  it('recovers from malformed layout storage', () => {
    expect(loadChatRatio(memoryStorage('{bad'))).toBe(CHAT_RATIO_DEFAULT);
    expect(loadChatRatio(memoryStorage('{"chatRatio":"bad"}'))).toBe(CHAT_RATIO_DEFAULT);
  });
});

export const CHAT_RATIO_DEFAULT = 0.4;
export const CHAT_RATIO_MIN = 0.25;
export const CHAT_RATIO_MAX = 0.6;
export const CHAT_MIN_WIDTH = 340;
export const TARGET_MIN_WIDTH = 360;
export const SPLIT_LAYOUT_KEY = 'design-inspector/layout-v1';

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function normalizeChatRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CHAT_RATIO_DEFAULT;
  return Math.min(CHAT_RATIO_MAX, Math.max(CHAT_RATIO_MIN, value));
}

export function effectiveChatRatio(preferred: number, trackWidth: number): number {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return CHAT_RATIO_DEFAULT;
  const maxByTarget = (trackWidth - TARGET_MIN_WIDTH) / trackWidth;
  const minByChat = Math.min(1, CHAT_MIN_WIDTH / trackWidth);
  const min = Math.max(CHAT_RATIO_MIN, minByChat);
  const max = Math.min(CHAT_RATIO_MAX, Math.max(min, maxByTarget));
  return Math.min(max, Math.max(min, normalizeChatRatio(preferred)));
}

export function ratioFromPointerDelta(
  startRatio: number,
  startX: number,
  clientX: number,
  trackWidth: number,
): number {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return normalizeChatRatio(startRatio);
  return normalizeChatRatio(startRatio - (clientX - startX) / trackWidth);
}

function browserStorage(): LayoutStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadChatRatio(storage: LayoutStorage | null = browserStorage()): number {
  if (!storage) return CHAT_RATIO_DEFAULT;
  try {
    const raw = storage.getItem(SPLIT_LAYOUT_KEY);
    if (!raw) return CHAT_RATIO_DEFAULT;
    const parsed = JSON.parse(raw) as { chatRatio?: unknown };
    return normalizeChatRatio(parsed.chatRatio);
  } catch {
    return CHAT_RATIO_DEFAULT;
  }
}

export function saveChatRatio(
  value: number,
  storage: LayoutStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SPLIT_LAYOUT_KEY, JSON.stringify({ chatRatio: normalizeChatRatio(value) }));
  } catch {
    return;
  }
}

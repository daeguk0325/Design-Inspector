// Freeze shortcut contract (shared by App A and the Vera bridge).
//
// Primary: Ctrl+Shift+F (Cmd+Shift+F on macOS). Alt+Shift+F is kept as a
// legacy fallback for spec compatibility.
// Rationale: on Windows, Alt+Shift is reserved for input-language switching,
// so the key event often never reaches the page; Ctrl+Shift+F is unassigned
// in Chrome/Edge/Firefox and does not collide with typing.

export const FREEZE_SHORTCUT_LABEL = 'Ctrl+Shift+F';
export const FREEZE_SHORTCUT_LABEL_MAC = 'Cmd+Shift+F';

export interface KeyCombo {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function matchesFreezeShortcut(e: KeyCombo): boolean {
  const isF = e.key === 'F' || e.key === 'f';
  if (!isF || !e.shiftKey) return false;
  // Primary: Ctrl+Shift+F / Cmd+Shift+F (no Alt).
  if ((e.ctrlKey || e.metaKey) && !e.altKey) return true;
  // Legacy: Alt+Shift+F (no Ctrl/Cmd).
  if (e.altKey && !e.ctrlKey && !e.metaKey) return true;
  return false;
}

export function shortcutLabel(): string {
  try {
    if (
      typeof navigator !== 'undefined' &&
      /mac/i.test(navigator.platform ?? '')
    ) {
      return FREEZE_SHORTCUT_LABEL_MAC;
    }
  } catch {
    // fall through to default
  }
  return FREEZE_SHORTCUT_LABEL;
}

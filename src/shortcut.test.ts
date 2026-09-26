import { describe, expect, it } from 'vitest';
import { matchesFreezeShortcut } from './shortcut.ts';

function combo(over: Partial<Parameters<typeof matchesFreezeShortcut>[0]> = {}) {
  return {
    key: 'F',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  };
}

describe('matchesFreezeShortcut', () => {
  it('accepts the primary Ctrl+Shift+F', () => {
    expect(matchesFreezeShortcut(combo({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('accepts Cmd+Shift+F on macOS', () => {
    expect(matchesFreezeShortcut(combo({ metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('accepts lowercase f', () => {
    expect(
      matchesFreezeShortcut(combo({ key: 'f', ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it('keeps Alt+Shift+F as legacy fallback', () => {
    expect(matchesFreezeShortcut(combo({ altKey: true, shiftKey: true }))).toBe(true);
  });

  it('rejects partial and unrelated combos', () => {
    expect(matchesFreezeShortcut(combo())).toBe(false); // plain F
    expect(matchesFreezeShortcut(combo({ ctrlKey: true }))).toBe(false); // Ctrl+F (find)
    expect(matchesFreezeShortcut(combo({ shiftKey: true }))).toBe(false); // Shift+F
    expect(matchesFreezeShortcut(combo({ altKey: true }))).toBe(false); // Alt+F
    expect(
      matchesFreezeShortcut(combo({ key: 'G', ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it('rejects Ctrl+Alt+Shift+F (ambiguous chord)', () => {
    expect(
      matchesFreezeShortcut(
        combo({ ctrlKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });
});

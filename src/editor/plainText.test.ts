import { describe, expect, it } from 'vitest';
import {
  composePlainText,
  composeTypedText,
  hasSendableText,
  type ComposerSegment,
} from './plainText.ts';

const text = (value: string): ComposerSegment => ({ type: 'text', text: value });
const tag = (selectionId: string): ComposerSegment => ({ type: 'attachment', selectionId });

const numbered: Record<string, string> = { s1: '({1})', s2: '({2})' };
const byNumber = (selectionId: string): string | null => numbered[selectionId] ?? null;

describe('composePlainText', () => {
  it('renders a tag where the user wrote it, not at either end', () => {
    expect(composePlainText([text('make '), tag('s1'), text(' roomier')], byNumber))
      .toBe('make ({1}) roomier');
  });

  it('keeps several references in sentence order', () => {
    expect(
      composePlainText(
        [text('make '), tag('s1'), text(' and '), tag('s2'), text(' more compact')],
        byNumber,
      ),
    ).toBe('make ({1}) and ({2}) more compact');
  });

  it('spaces references away from the words and from each other', () => {
    expect(composePlainText([tag('s1'), tag('s2'), text('go')], byNumber)).toBe('({1}) ({2}) go');
    expect(composePlainText([text('make'), tag('s1'), text('roomier')], byNumber))
      .toBe('make ({1}) roomier');
  });

  it('keeps leading tags at the front when that is where they were added', () => {
    expect(composePlainText([tag('s1'), tag('s2'), text('make this roomier')], byNumber))
      .toBe('({1}) ({2}) make this roomier');
  });

  it('falls back to the component name before a number exists', () => {
    const segments = [text('fix '), tag('s1'), text(' please')];
    expect(composePlainText(segments, () => '({PrimaryButton})')).toBe('fix ({PrimaryButton}) please');
  });

  it('drops a tag with no reference rather than emitting a blank', () => {
    expect(composePlainText([text('make '), tag('gone'), text('it')], () => null)).toBe('make it');
    expect(composePlainText([text('make '), tag('gone'), text('it')])).toBe('make it');
  });

  it('preserves newlines so a multi-line request keeps its shape', () => {
    expect(composePlainText([text('first\n'), tag('s1'), text('\nsecond')], byNumber))
      .toBe('first\n({1})\nsecond');
  });
});

describe('composeTypedText', () => {
  it('counts only what the user typed', () => {
    expect(composeTypedText([text('make '), tag('s1'), text(' roomier')])).toBe('make  roomier');
  });

  it('is empty for a message of nothing but tags', () => {
    expect(composeTypedText([tag('s1'), tag('s2')])).toBe('');
    expect(hasSendableText(composeTypedText([tag('s1'), tag('s2')]))).toBe(false);
  });

  it('is sendable as soon as a word is typed, even beside tags', () => {
    expect(hasSendableText(composeTypedText([tag('s1'), text('fix')]))).toBe(true);
  });
});

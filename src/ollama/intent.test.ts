// The preview intent gate. Its whole value is that it never blocks a request
// the user actually made, so the tests spend most of their budget on the
// requests it must let through.

import { describe, expect, it } from 'vitest';
import { previewIntent, shouldSuppressBlock } from './intent.ts';

describe('previewIntent', () => {
  it('allows a direct change request', () => {
    expect(previewIntent('버튼 간격을 16px로 바꿔줘')).toEqual({ allowPreview: true, reason: null });
    expect(previewIntent('radius 10px로 적용해줘')).toEqual({ allowPreview: true, reason: null });
    expect(previewIntent('increase the padding to 24px')).toEqual({ allowPreview: true, reason: null });
  });

  it('allows a request with no change cue at all, because absence is not refusal', () => {
    // The narrow, one-directional scope. Refusing here would mean a request the
    // user might well have meant as a change silently gets no preview.
    expect(previewIntent('이거 좀 어색한데')).toEqual({ allowPreview: true, reason: null });
    expect(previewIntent('이 컴포넌트 어때?')).toEqual({ allowPreview: true, reason: null });
  });

  it('suppresses an explicit instruction not to change anything', () => {
    expect(previewIntent('색만 확인해줘. 바꾸지 마')).toEqual({
      allowPreview: false,
      reason: 'explicit-no-change',
    });
    expect(previewIntent('그대로 둬').reason).toBe('explicit-no-change');
    expect(previewIntent('do not change anything').reason).toBe('explicit-no-change');
  });

  it('suppresses a handoff or review-only request', () => {
    expect(previewIntent('이거 디자이너한테 전달문 만들어줘')).toEqual({
      allowPreview: false,
      reason: 'non-change-shape',
    });
    expect(previewIntent('리뷰만 해줘').reason).toBe('non-change-shape');
    expect(previewIntent('write a handoff note for this').reason).toBe('non-change-shape');
  });

  it('lets a change instruction win inside a text-shaped request', () => {
    // The mixed case that decides whether the narrow scope is safe at all.
    expect(previewIntent('전달문으로 정리하고 간격은 16px로 바꿔줘').allowPreview).toBe(true);
    expect(previewIntent('안내문 만들어주고 배경색도 바꿔줘').allowPreview).toBe(true);
  });

  it('lets an explicit no-change beat a change word elsewhere in the text', () => {
    // Asking about padding is not asking to change padding.
    expect(previewIntent('padding이 16px인데 이거 안 바꾸고 그대로 두고 싶어').reason).toBe(
      'explicit-no-change',
    );
  });

  it('allows an empty or whitespace request', () => {
    expect(previewIntent('').allowPreview).toBe(true);
    expect(previewIntent('   ').allowPreview).toBe(true);
  });
});

describe('shouldSuppressBlock', () => {
  it('mirrors the verdict', () => {
    expect(shouldSuppressBlock('전달문 만들어줘')).toBe(true);
    expect(shouldSuppressBlock('바꿔줘')).toBe(false);
  });
});

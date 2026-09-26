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

  it('catches every spelling of the handoff request, not just 전달문', () => {
    // Found in the real app: the gate matched `전달문` and let
    // `전달할 문구 만들어줘` through, which restyled the page and offered a card
    // for a request that was only ever about writing text.
    for (const request of [
      '이 변경 사항을 디자이너에게 전달할 문구 만들어줘',
      '이걸 디자이너한테 보낼 문구 써줘',
      '안내문 좀 만들어줘',
      '공지 문구 부탁해',
      '전달용 카피 써줘',
    ]) {
      expect({ request, verdict: previewIntent(request) }).toEqual({
        request,
        verdict: { allowPreview: false, reason: 'non-change-shape' },
      });
    }
  });

  it('does not read a reference to past changes as an instruction to change', () => {
    // "이 변경 사항을" points at changes already made, so treating 변경 as a
    // change cue would open the front door for the case above.
    expect(previewIntent('이 변경 사항을 디자이너에게 전달할 문구 만들어줘').allowPreview).toBe(false);
  });

  it('lets an explicit style fix through the widened change list', () => {
    // The verbs added to CHANGE are only the unambiguous style ones. A broad
    // match here would cost the user their preview, which is the failure the
    // gate exists to prevent in the other direction.
    for (const request of ['이 버튼 고쳐줘', '여기 손봐줘', '간격 수정해줘', 'fix the spacing']) {
      expect({ request, allow: previewIntent(request).allowPreview }).toEqual({ request, allow: true });
    }
  });

  it('does not treat 정리 as a style instruction', () => {
    // "전달문으로 정리해줘" is a request for text, not a restyle.
    expect(previewIntent('전달문으로 정리해줘').allowPreview).toBe(false);
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

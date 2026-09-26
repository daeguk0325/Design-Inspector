import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectionCapture } from '../hooks/useBridge.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import {
  attachmentImageSrc,
  attachmentStatus,
  attachmentViewsById,
  buildAttachmentViews,
  displayNumberFor,
  partitionAttachments,
  placeholderAttachmentView,
} from './attachmentModel.ts';
import {
  ATTACHMENT_NODE_TYPE,
  parseSerializedSelectionId,
  serializeAttachment,
} from './attachmentSerialization.ts';
import { composePlainText, hasSendableText } from './plainText.ts';
import { planSendCommit, planSendIntent } from './sendLifecycle.ts';
import {
  BACKSPACE_ARM_WINDOW_MS,
  createBackspaceArmController,
  decideBackspace,
  isBackspaceArmed,
} from './backspaceArm.ts';
import { hasBlockingModifier, isImeComposing, isSendEnter } from './keyboard.ts';
import { AttachmentViewProvider, type AttachmentContextValue } from './AttachmentContext.tsx';
import { AttachmentTag } from './AttachmentTag.tsx';
import { AttachmentChip, AttachmentChips } from './AttachmentChip.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const containers: HTMLElement[] = [];

function record(overrides: Partial<SelectionRecord> = {}): SelectionRecord {
  return {
    selectionId: 's1',
    elementKey: 'button.primary',
    component: 'PrimaryButton',
    file: 'src/ui/Button.tsx',
    line: 42,
    mode: 'html',
    state: 'active',
    order: 0,
    ...overrides,
  };
}

function capture(overrides: Partial<SelectionCapture> = {}): SelectionCapture {
  return { selectionId: 's1', status: 'capturing', ...overrides };
}

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  roots.push(root);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  vi.useRealTimers();
});

function contextValue(overrides: Partial<AttachmentContextValue> = {}): AttachmentContextValue {
  return {
    views: new Map(),
    armedSelectionId: null,
    onRemove: vi.fn(),
    onRefresh: vi.fn(),
    focusEditor: vi.fn(),
    ...overrides,
  };
}

function renderTag(context: AttachmentContextValue): string {
  return renderToStaticMarkup(
    <AttachmentViewProvider value={context}>
      <AttachmentTag selectionId="s1" />
    </AttachmentViewProvider>,
  );
}

describe('attachment model', () => {
  it('maps selections to compact views in the given order', () => {
    const views = buildAttachmentViews(
      [record(), record({ selectionId: 's2', component: null, elementKey: 'card.root' })],
      new Map([['s1', 1], ['s2', 2]]),
      {
        s1: capture({
          status: 'ready',
          result: { selectionId: 's1', mimeType: 'image/png', base64: 'AAA', width: 4, height: 4, byteLength: 3 },
        }),
        s2: capture({ selectionId: 's2', status: 'error', error: 'Capture failed.' }),
      },
    );

    expect(views.map((view) => view.selectionId)).toEqual(['s1', 's2']);
    expect(views[0]).toMatchObject({
      number: 1,
      name: 'PrimaryButton',
      location: 'src/ui/Button.tsx:42',
      status: 'ready',
      imageSrc: 'data:image/png;base64,AAA',
    });
    expect(views[1]).toMatchObject({
      number: 2,
      name: 'card.root',
      status: 'error',
      statusText: 'Capture failed.',
      imageSrc: null,
    });
  });

  it('treats missing captures as loading and falls back to element keys', () => {
    const views = buildAttachmentViews(
      [record({ component: null, file: null, line: null, mode: 'konva' })],
      undefined,
      undefined,
    );
    expect(views[0]).toMatchObject({ number: null, name: 'button.primary', location: 'konva', status: 'loading', statusText: 'Preparing…' });
    expect(views[0].imageSrc).toBeNull();
  });

  it('accepts map or record display numbers and indexes views by id', () => {
    expect(displayNumberFor(new Map([['a', 3]]), 'a')).toBe(3);
    expect(displayNumberFor({ a: 4 }, 'a')).toBe(4);
    expect(displayNumberFor({ a: 4 }, 'b')).toBeNull();
    expect(displayNumberFor(null, 'a')).toBeNull();
    const byId = attachmentViewsById(buildAttachmentViews([record()], new Map([['s1', 1]]), {}));
    expect(byId.get('s1')?.name).toBe('PrimaryButton');
  });

  it('only derives image sources from ready captures', () => {
    const ready = capture({
      status: 'ready',
      result: { selectionId: 's1', mimeType: 'image/jpeg', base64: 'Zm9v', width: 1, height: 1, byteLength: 3 },
    });
    expect(attachmentImageSrc(ready)).toBe('data:image/jpeg;base64,Zm9v');
    expect(attachmentImageSrc(capture({ status: 'capturing', result: ready.result }))).toBeNull();
    expect(attachmentImageSrc(capture({ status: 'error' }))).toBeNull();
    expect(attachmentStatus(undefined)).toBe('loading');
  });

  it('caps inline tags at maxSelectionCount and reports the overflow', () => {
    expect(partitionAttachments(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], overflow: 1 });
    expect(partitionAttachments(['a', 'b'], 4)).toEqual({ shown: ['a', 'b'], overflow: 0 });
    expect(partitionAttachments(['a', 'b'], 0)).toEqual({ shown: ['a', 'b'], overflow: 0 });
  });

  it('describes stale selection ids without inventing identity', () => {
    const stale = placeholderAttachmentView('gone');
    expect(stale).toMatchObject({ selectionId: 'gone', number: null, status: 'error', imageSrc: null });
  });
});

describe('attachment node serialization', () => {
  it('stores only the selectionId so no image bytes enter editor state', () => {
    const json = serializeAttachment('s1');
    expect(json).toEqual({ type: ATTACHMENT_NODE_TYPE, version: 1, selectionId: 's1' });
    expect(Object.keys(json)).toEqual(['type', 'version', 'selectionId']);
    const encoded = JSON.stringify(json);
    expect(encoded).not.toContain('base64');
    expect(encoded).not.toContain('data:image');
    expect(parseSerializedSelectionId(JSON.parse(encoded))).toBe('s1');
  });

  it('rejects payloads without a usable selectionId', () => {
    expect(parseSerializedSelectionId(null)).toBeNull();
    expect(parseSerializedSelectionId('s1')).toBeNull();
    expect(parseSerializedSelectionId({})).toBeNull();
    expect(parseSerializedSelectionId({ selectionId: '' })).toBeNull();
    expect(parseSerializedSelectionId({ selectionId: 7 })).toBeNull();
  });
});

describe('plain text extraction', () => {
  it('drops attachment nodes and keeps only typed text', () => {
    const text = composePlainText([
      { type: 'attachment', selectionId: 's1' },
      { type: 'text', text: 'make this ' },
      { type: 'attachment', selectionId: 's2' },
      { type: 'text', text: 'bigger' },
    ]);
    expect(text).toBe('make this bigger');
    expect(text).not.toContain('s1');
    expect(text).not.toContain('s2');
    expect(hasSendableText(text)).toBe(true);
    expect(hasSendableText('   \n ')).toBe(false);
  });
});

describe('send lifecycle', () => {
  it('stops while streaming and blocks preparing, empty, and not-ready sends', () => {
    const base = { streaming: false, preparing: false, text: 'hello', ready: true };
    expect(planSendIntent({ ...base, streaming: true })).toEqual({ kind: 'stop' });
    expect(planSendIntent({ ...base, preparing: true })).toEqual({ kind: 'blocked', reason: 'preparing' });
    expect(planSendIntent({ ...base, text: '   ' })).toEqual({ kind: 'blocked', reason: 'empty' });
    expect(planSendIntent({ ...base, ready: false })).toEqual({ kind: 'blocked', reason: 'not-ready' });
    expect(planSendIntent(base)).toEqual({ kind: 'send', text: 'hello' });
  });

  it('clears text and attachments only after a successful send', () => {
    expect(planSendCommit(true, 'hello', 'hello', ['s1', 's1', 's2'])).toEqual({
      clearText: true,
      clearAttachmentsOnly: false,
      releaseSelectionIds: ['s1', 's2'],
    });
  });

  it('preserves text and attachments when the send fails', () => {
    expect(planSendCommit(false, 'hello', 'hello', ['s1', 's2'])).toEqual({
      clearText: false,
      clearAttachmentsOnly: false,
      releaseSelectionIds: [],
    });
  });

  it('keeps edits typed during the request and still consumes attachments', () => {
    expect(planSendCommit(true, 'hello', 'hello again', ['s1'])).toEqual({
      clearText: false,
      clearAttachmentsOnly: true,
      releaseSelectionIds: ['s1'],
    });
  });
});

describe('keyboard intent', () => {
  it('sends on unmodified Enter outside IME composition only', () => {
    expect(isSendEnter({ key: 'Enter' })).toBe(true);
    expect(isSendEnter({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSendEnter({ key: 'Enter', isComposing: true })).toBe(false);
    expect(isSendEnter({ key: 'Enter', keyCode: 229 })).toBe(false);
    expect(isSendEnter({ key: 'Enter' }, true)).toBe(false);
    expect(isSendEnter({ key: 'a' })).toBe(false);
  });

  it('detects IME composition and blocking modifiers', () => {
    expect(isImeComposing({ key: 'Backspace' })).toBe(false);
    expect(isImeComposing({ key: 'Backspace' }, true)).toBe(true);
    expect(hasBlockingModifier({ key: 'Backspace' })).toBe(false);
    expect(hasBlockingModifier({ key: 'Backspace', ctrlKey: true })).toBe(true);
    expect(hasBlockingModifier({ key: 'Backspace', metaKey: true })).toBe(true);
    expect(hasBlockingModifier({ key: 'Backspace', altKey: true })).toBe(true);
    expect(hasBlockingModifier({ key: 'Backspace', shiftKey: true })).toBe(false);
  });
});

describe('backspace arm state machine', () => {
  const press = { selectionId: 's1', caret: 'c1' };

  it('arms on the first press and removes on the second distinct press', () => {
    const first = decideBackspace({ armed: null }, press, 1000);
    expect(first.decision).toEqual({ kind: 'armed', selectionId: 's1' });
    const second = decideBackspace(first.state, press, 1200);
    expect(second.decision).toEqual({ kind: 'remove', selectionId: 's1' });
    expect(second.state.armed).toBeNull();
  });

  it('ignores modifiers and IME composition without changing state', () => {
    const armed = decideBackspace({ armed: null }, press, 1000).state;
    expect(decideBackspace(armed, { ...press, modified: true }, 1100).decision).toEqual({ kind: 'ignored', reason: 'modified' });
    expect(decideBackspace(armed, { ...press, composing: true }, 1100).decision).toEqual({ kind: 'ignored', reason: 'composing' });
    expect(decideBackspace(armed, { ...press, modified: true }, 1100).state).toBe(armed);
    expect(decideBackspace(armed, { ...press, composing: true }, 1100).state).toBe(armed);
  });

  // Holding Backspace must keep deleting the text behind the caret. The repeat
  // used to resolve to `ignored`, and the caller still prevented the default,
  // so a held key deleted nothing anywhere in the composer.
  it('passes a held repeat through and drops the arm so text deletion resumes', () => {
    const armed = decideBackspace({ armed: null }, press, 1000).state;
    const held = decideBackspace(armed, { ...press, repeat: true }, 1100);
    expect(held.decision).toEqual({ kind: 'passthrough', reason: 'repeat' });
    expect(held.state.armed).toBeNull();
    // A repeat is a hold, never a confirmation: the tag must survive it.
    const stillThere = decideBackspace(held.state, { ...press, repeat: true }, 1200);
    expect(stillThere.decision).toEqual({ kind: 'passthrough', reason: 'repeat' });
  });

  it('still arms on a discrete press after a hold abandoned the arm', () => {
    const held = decideBackspace({ armed: null }, { ...press, repeat: true }, 1000);
    expect(held.decision).toEqual({ kind: 'passthrough', reason: 'repeat' });
    expect(decideBackspace(held.state, press, 1400).decision).toEqual({ kind: 'armed', selectionId: 's1' });
  });

  it('re-arms for a different attachment or a moved caret', () => {
    const armed = decideBackspace({ armed: null }, press, 1000).state;
    expect(decideBackspace(armed, { ...press, selectionId: 's2' }, 1100).decision).toEqual({ kind: 'armed', selectionId: 's2' });
    expect(decideBackspace(armed, { ...press, caret: 'c2' }, 1100).decision).toEqual({ kind: 'armed', selectionId: 's1' });
  });

  it('expires the arm after 1500ms', () => {
    const armed = decideBackspace({ armed: null }, press, 1000).state;
    expect(isBackspaceArmed(armed, 's1', 'c1', 1000 + BACKSPACE_ARM_WINDOW_MS)).toBe(true);
    expect(isBackspaceArmed(armed, 's1', 'c1', 1000 + BACKSPACE_ARM_WINDOW_MS + 1)).toBe(false);
    expect(decideBackspace(armed, press, 1000 + BACKSPACE_ARM_WINDOW_MS + 1).decision).toEqual({ kind: 'armed', selectionId: 's1' });
  });

  it('passes through and disarms when no attachment is adjacent', () => {
    const armed = decideBackspace({ armed: null }, press, 1000).state;
    const result = decideBackspace(armed, { selectionId: null, caret: '' }, 1100);
    expect(result.decision).toEqual({ kind: 'passthrough', reason: 'no-attachment' });
    expect(result.state.armed).toBeNull();
  });
});

describe('backspace arm controller', () => {
  it('arms, then removes within the window and disarms on timeout', () => {
    vi.useFakeTimers();
    const onArmChange = vi.fn();
    const controller = createBackspaceArmController({ onArmChange });

    expect(controller.press({ selectionId: 's1', caret: 'c1' })).toEqual({ kind: 'armed', selectionId: 's1' });
    expect(onArmChange).toHaveBeenLastCalledWith('s1');
    expect(controller.isArmed('s1', 'c1')).toBe(true);

    vi.advanceTimersByTime(BACKSPACE_ARM_WINDOW_MS - 1);
    expect(controller.press({ selectionId: 's1', caret: 'c1' })).toEqual({ kind: 'remove', selectionId: 's1' });
    expect(onArmChange).toHaveBeenLastCalledWith(null);
    expect(controller.isArmed('s1', 'c1')).toBe(false);

    expect(controller.press({ selectionId: 's1', caret: 'c1' })).toEqual({ kind: 'armed', selectionId: 's1' });
    vi.advanceTimersByTime(BACKSPACE_ARM_WINDOW_MS);
    expect(onArmChange).toHaveBeenLastCalledWith(null);
    expect(controller.press({ selectionId: 's1', caret: 'c1' })).toEqual({ kind: 'armed', selectionId: 's1' });
    expect(controller.press({ selectionId: 's1', caret: 'c1' })).toEqual({ kind: 'remove', selectionId: 's1' });
    controller.dispose();
  });

  it('detects a moved caret and disarms when the adjacency is gone', () => {
    const onArmChange = vi.fn();
    const controller = createBackspaceArmController({ onArmChange });
    controller.press({ selectionId: 's1', caret: 'c1' });
    expect(controller.matchesCaret('c1')).toBe(true);
    expect(controller.matchesCaret('c2')).toBe(false);
    controller.disarm();
    expect(onArmChange).toHaveBeenLastCalledWith(null);

    controller.press({ selectionId: 's1', caret: 'c3' });
    expect(controller.press({ selectionId: null, caret: '' })).toEqual({ kind: 'passthrough', reason: 'no-attachment' });
    expect(onArmChange).toHaveBeenLastCalledWith(null);
    expect(controller.isArmed('s1', 'c3')).toBe(false);
    controller.dispose();
  });
});

describe('AttachmentTag rendering', () => {
  const ready = buildAttachmentViews(
    [record()],
    new Map([['s1', 1]]),
    {
      s1: capture({
        status: 'ready',
        result: { selectionId: 's1', mimeType: 'image/png', base64: 'AAA', width: 4, height: 4, byteLength: 3 },
      }),
    },
  )[0];

  it('shows thumbnail, display number, component name, and an always-visible remove control', () => {
    const html = renderTag(contextValue({ views: attachmentViewsById([ready]) }));
    expect(html).toContain('data-state="ready"');
    expect(html).toContain('class="attach-thumb-img"');
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).toContain('class="attach-badge"');
    expect(html).toContain('>1<');
    expect(html).toContain('PrimaryButton');
    expect(html).toContain('aria-label="Remove attachment 1"');
    expect(html).toContain('class="attach-tag-x"');
  });

  it('keeps a fixed thumb box while loading and shows an error affordance', () => {
    const loading = buildAttachmentViews([record()], new Map([['s1', 1]]), { s1: capture() })[0];
    const loadingHtml = renderTag(contextValue({ views: attachmentViewsById([loading]) }));
    expect(loadingHtml).toContain('data-state="loading"');
    expect(loadingHtml).toContain('aria-busy="true"');
    expect(loadingHtml).toContain('class="attach-spinner"');
    expect(loadingHtml).not.toContain('attach-thumb-img');

    const failed = buildAttachmentViews([record()], new Map([['s1', 1]]), {
      s1: capture({ status: 'error', error: 'Timed out.' }),
    })[0];
    const failedHtml = renderTag(contextValue({ views: attachmentViewsById([failed]) }));
    expect(failedHtml).toContain('data-state="error"');
    expect(failedHtml).toContain('aria-label="Retry capture for PrimaryButton"');
    expect(failedHtml).toContain('Timed out.');
  });

  it('marks the armed attachment for the two-step backspace affordance', () => {
    const armed = renderTag(contextValue({ views: attachmentViewsById([ready]), armedSelectionId: 's1' }));
    expect(armed).toContain('data-armed="true"');
    const idle = renderTag(contextValue({ views: attachmentViewsById([ready]) }));
    expect(idle).not.toContain('data-armed');
  });

  it('falls back to an unavailable chip for unknown selection ids', () => {
    const html = renderTag(contextValue());
    expect(html).toContain('data-state="error"');
    expect(html).toContain('no longer selected');
  });

  it('calls onRemove and keeps the editor focused from the X control', () => {
    const onRemove = vi.fn();
    const focusEditor = vi.fn();
    const container = mount(
      <AttachmentViewProvider value={contextValue({ views: attachmentViewsById([ready]), onRemove, focusEditor })}>
        <AttachmentTag selectionId="s1" />
      </AttachmentViewProvider>,
    );
    const remove = container.querySelector<HTMLButtonElement>('.attach-tag-x');
    expect(remove).not.toBeNull();
    act(() => remove?.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('s1');
    expect(focusEditor).toHaveBeenCalledTimes(1);
  });

  it('retries a failed capture from the thumbnail', () => {
    const failed = buildAttachmentViews([record()], new Map([['s1', 1]]), {
      s1: capture({ status: 'error', error: 'Timed out.' }),
    })[0];
    const onRefresh = vi.fn();
    const container = mount(
      <AttachmentViewProvider value={contextValue({ views: attachmentViewsById([failed]), onRefresh })}>
        <AttachmentTag selectionId="s1" />
      </AttachmentViewProvider>,
    );
    const retry = container.querySelector<HTMLButtonElement>('.attach-thumb-action');
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    expect(onRefresh).toHaveBeenCalledWith('s1');
  });
});

describe('read-only attachment chips', () => {
  const views = buildAttachmentViews(
    [record(), record({ selectionId: 's2', component: 'Card', file: null, line: null, mode: '3d' })],
    new Map([['s1', 1], ['s2', 2]]),
    {},
  );

  it('renders name and location without interactive controls', () => {
    const html = renderToStaticMarkup(<AttachmentChip view={views[0]} />);
    expect(html).toContain('PrimaryButton');
    expect(html).toContain('src/ui/Button.tsx:42');
    expect(html).toContain('class="attach-chip"');
    expect(html).not.toContain('<button');
  });

  it('renders a list of chips and nothing when empty', () => {
    const html = renderToStaticMarkup(<AttachmentChips items={views} />);
    expect(html.match(/attach-chip-name/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<AttachmentChips items={[]} />)).toBe('');
  });
});

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectionCapture } from '../hooks/useBridge.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import { attachmentViewsById, buildAttachmentViews } from '../editor/attachmentModel.ts';
import type { ComposerAttachmentContext, ComposerEditorController } from '../editor/ComposerEditor.tsx';

const editorModule = await import('../editor/ComposerEditor.tsx').catch(() => null);
const composerModule = await import('./Composer.tsx').catch(() => null);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

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
  return { selectionId: 's1', status: 'ready', ...overrides };
}

function mount(element: ReactNode): { root: Root; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  const entry = { root, container };
  mounted.push(entry);
  return entry;
}

function contextFor(selections: readonly SelectionRecord[]): ComposerAttachmentContext {
  const views = buildAttachmentViews(
    selections,
    new Map(selections.map((selection, index) => [selection.selectionId, index + 1])),
    { s1: capture() },
  );
  return {
    views: attachmentViewsById(views),
    armedSelectionId: null,
    onRemove: vi.fn(),
    onRefresh: vi.fn(),
  };
}

interface HarnessProps {
  attachmentIds: string[];
  selections: readonly SelectionRecord[];
  onRemove?: (selectionId: string) => void;
  onArmChange?: (selectionId: string | null) => void;
  onSubmit?: () => void;
  onReady?: (controller: ComposerEditorController | null) => void;
  onTextChange?: (text: string) => void;
}

function Harness({
  attachmentIds,
  selections,
  onRemove,
  onArmChange,
  onSubmit = vi.fn(),
  onReady = vi.fn(),
  onTextChange = vi.fn(),
}: HarnessProps) {
  const { ComposerEditor } = editorModule!;
  const [armedSelectionId, setArmedSelectionId] = useState<string | null>(null);
  const base = contextFor(selections);
  return (
    <ComposerEditor
      attachmentIds={attachmentIds}
      attachmentContext={{
        ...base,
        armedSelectionId,
        onRemove: onRemove ?? base.onRemove,
      }}
      onArmChange={(selectionId) => {
        setArmedSelectionId(selectionId);
        onArmChange?.(selectionId);
      }}
      onSubmit={onSubmit}
      onReady={onReady}
      onTextChange={onTextChange}
      placeholder="Ask…"
    />
  );
}

async function pressKey(input: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    input.dispatchEvent(event);
  });
  return event;
}

function editable(container: HTMLElement): HTMLElement {
  const input = container.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!input) throw new Error('composer editable surface was not mounted');
  return input;
}

describe.skipIf(editorModule === null)('ComposerEditor attachments', () => {
  it('renders one inline atomic tag per ordered selection', () => {
    const selections = [record(), record({ selectionId: 's2', component: 'Card' })];
    const { container } = mount(
      <Harness attachmentIds={['s1', 's2']} selections={selections} />,
    );
    const tags = container.querySelectorAll('.attach-tag');
    expect(tags).toHaveLength(2);
    expect(tags[0].textContent).toContain('PrimaryButton');
    expect(tags[0].querySelector('.attach-badge')?.textContent).toBe('1');
    expect(tags[1].querySelector('.attach-badge')?.textContent).toBe('2');
    expect(container.querySelectorAll('.attach-tag-x')).toHaveLength(2);
    expect(container.querySelector('[data-selection-id="s1"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-lexical-decorator="true"]')).toHaveLength(2);
  });

  it('reconciles attachment nodes when the ordered selections change', () => {
    const selections = [record(), record({ selectionId: 's2', component: 'Card' })];
    const { container, root } = mount(
      <Harness attachmentIds={['s1', 's2']} selections={selections} />,
    );
    expect(container.querySelectorAll('.attach-tag')).toHaveLength(2);

    act(() => root.render(<Harness attachmentIds={['s2']} selections={selections} />));
    expect(container.querySelectorAll('.attach-tag')).toHaveLength(1);
    expect(container.querySelectorAll('.attach-tag')[0].textContent).toContain('Card');
  });

  it('keeps the armed tag on the first Backspace and removes it on the second', async () => {
    const onRemove = vi.fn();
    const onArmChange = vi.fn();
    const { container } = mount(
      <Harness attachmentIds={['s1']} selections={[record()]} onRemove={onRemove} onArmChange={onArmChange} />,
    );
    const input = editable(container);

    const first = await pressKey(input, { key: 'Backspace' });
    expect(first.defaultPrevented).toBe(true);
    expect(onRemove).not.toHaveBeenCalled();
    expect(onArmChange).toHaveBeenLastCalledWith('s1');
    expect(container.querySelectorAll('.attach-tag')).toHaveLength(1);
    expect(container.querySelectorAll('.attach-tag[data-armed="true"]')).toHaveLength(1);

    const second = await pressKey(input, { key: 'Backspace' });
    expect(second.defaultPrevented).toBe(true);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('s1');
    expect(onArmChange).toHaveBeenLastCalledWith(null);
  });

  it('ignores repeated, modified, and IME Backspace presses', async () => {
    const onRemove = vi.fn();
    const onArmChange = vi.fn();
    const { container } = mount(
      <Harness attachmentIds={['s1']} selections={[record()]} onRemove={onRemove} onArmChange={onArmChange} />,
    );
    const input = editable(container);

    await pressKey(input, { key: 'Backspace', repeat: true });
    await pressKey(input, { key: 'Backspace', ctrlKey: true });
    await pressKey(input, { key: 'Backspace', metaKey: true });
    await pressKey(input, { key: 'Backspace', isComposing: true });
    await pressKey(input, { key: 'Backspace', keyCode: 229 });

    expect(onRemove).not.toHaveBeenCalled();
    expect(onArmChange).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.attach-tag')).toHaveLength(1);
    expect(container.querySelectorAll('.attach-tag[data-armed="true"]')).toHaveLength(0);
  });

  it('disarms after the 1500ms window and re-arms instead of removing', async () => {
    vi.useFakeTimers();
    const onRemove = vi.fn();
    const onArmChange = vi.fn();
    const { container } = mount(
      <Harness attachmentIds={['s1']} selections={[record()]} onRemove={onRemove} onArmChange={onArmChange} />,
    );
    const input = editable(container);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    expect(onArmChange).toHaveBeenLastCalledWith('s1');

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(onArmChange).toHaveBeenLastCalledWith(null);
    expect(container.querySelectorAll('.attach-tag[data-armed="true"]')).toHaveLength(0);

    await pressKey(input, { key: 'Backspace' });
    expect(onRemove).not.toHaveBeenCalled();
    expect(onArmChange).toHaveBeenLastCalledWith('s1');

    await pressKey(input, { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('s1');
    vi.useRealTimers();
  });

  it('sends on Enter, keeps Shift+Enter for a line break, and sends no attachment identity', async () => {
    const onSubmit = vi.fn();
    const onTextChange = vi.fn();
    const { container } = mount(
      <Harness attachmentIds={['s1']} selections={[record()]} onSubmit={onSubmit} onTextChange={onTextChange} />,
    );
    const input = editable(container);

    await pressKey(input, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    await pressKey(input, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();

    await pressKey(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    for (const text of onTextChange.mock.calls.map((call) => call[0])) {
      expect(String(text)).not.toContain('s1');
    }
  });

  it('sends a tag as its citation reference, never as its selection id', () => {
    const holder: { controller: ComposerEditorController | null } = { controller: null };
    mount(
      <Harness
        attachmentIds={['s1']}
        selections={[record()]}
        onReady={(next) => {
          holder.controller = next;
        }}
      />,
    );
    expect(holder.controller).not.toBeNull();
    // The tag becomes the reference the `Inspected UI citations:` block names.
    expect(holder.controller?.getPlainText()).toBe('({1})');
    expect(holder.controller?.getPlainText()).not.toContain('s1');
    // Tags alone are not a request, so the send gate stays shut.
    expect(holder.controller?.getTypedText()).toBe('');
    expect(holder.controller?.hasText()).toBe(false);
  });
});

describe.skipIf(composerModule === null)('Composer', () => {
  it('keeps the send control gated on target readiness and text', () => {
    const { Composer } = composerModule!;
    const onSend = vi.fn(async () => true);
    const { container, root } = mount(
      <Composer streaming={false} canSend={false} onSend={onSend} onStop={vi.fn()} />,
    );
    expect(container.querySelector<HTMLButtonElement>('.compose-row .btn.primary')?.disabled).toBe(true);

    act(() => root.render(
      <Composer
        streaming={false}
        canSend
        onSend={onSend}
        onStop={vi.fn()}
        selections={[record(), record({ selectionId: 's2', component: 'Card' })]}
      />,
    ));
    expect(container.querySelector<HTMLButtonElement>('.compose-row .btn.primary')?.disabled).toBe(true);
    expect(editable(container).getAttribute('aria-placeholder')).toContain('2 selected elements');
  });

  it('never claims a selection count that the tag list does not have', () => {
    const { Composer } = composerModule!;
    const onSend = vi.fn(async () => true);
    const { container, root } = mount(
      <Composer streaming={false} canSend onSend={onSend} onStop={vi.fn()} selections={[record()]} />,
    );
    expect(editable(container).getAttribute('aria-placeholder')).toContain('1 selected element');

    act(() => root.render(<Composer streaming={false} canSend onSend={onSend} onStop={vi.fn()} selections={[]} />));
    expect(editable(container).getAttribute('aria-placeholder')).toContain('Freeze the target');
    expect(container.querySelectorAll('.attach-tag')).toHaveLength(0);
  });

  it('restores the tag with an inline notice when the target refuses the deselect', async () => {
    const { Composer } = composerModule!;
    const onRemove = vi.fn(async () => false);
    const onSend = vi.fn(async () => true);
    const { container } = mount(
      <Composer
        streaming={false}
        canSend
        onSend={onSend}
        onStop={vi.fn()}
        selections={[record()]}
        onRemove={onRemove}
      />,
    );
    const remove = container.querySelector<HTMLButtonElement>('.attach-tag-x');
    await act(async () => {
      remove?.click();
    });
    expect(onRemove).toHaveBeenCalledWith('s1');
    expect(container.querySelector('.compose-error')?.textContent).toContain('kept that component selected');
  });

  it('stops an active stream instead of sending', () => {
    const { Composer } = composerModule!;
    const onSend = vi.fn(async () => true);
    const onStop = vi.fn();
    const { container } = mount(<Composer streaming canSend onSend={onSend} onStop={onStop} />);
    const stop = container.querySelector<HTMLButtonElement>('.compose-row .btn');
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('Composer rewind seed', () => {
  it('starts with the restored text when a rewind seeds the composer', async () => {
    const { Composer } = composerModule!;
    const { container } = mount(
      <Composer
        streaming={false}
        canSend
        onSend={vi.fn(async () => true)}
        onStop={vi.fn()}
        selections={[]}
        seed={{ text: '버튼을 더 크게', nonce: 1 }}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const editable = container.querySelector<HTMLElement>('[contenteditable]');
    expect(editable?.textContent).toBe('버튼을 더 크게');
  });

  it('starts empty without a seed', async () => {
    const { Composer } = composerModule!;
    const { container } = mount(
      <Composer
        streaming={false}
        canSend
        onSend={vi.fn(async () => true)}
        onStop={vi.fn()}
        selections={[]}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const editable = container.querySelector<HTMLElement>('[contenteditable]');
    expect(editable?.textContent ?? '').toBe('');
  });
});

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  createEditor,
  type ParagraphNode,
  type TextNode,
} from 'lexical';
import type { SelectionCapture } from '../hooks/useBridge.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import { attachmentViewsById, buildAttachmentViews } from './attachmentModel.ts';
import { AttachmentNode, $createAttachmentNode } from './AttachmentNode.tsx';
import { ComposerEditor, type ComposerEditorController } from './ComposerEditor.tsx';
import {
  $adjacentAttachment,
  $reconcileTagNodes,
  $tagsInSelection,
} from './composerDocument.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.useRealTimers();
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

function editable(container: HTMLElement): HTMLElement {
  const input = container.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!input) throw new Error('composer editable surface was not mounted');
  return input;
}

function block(container: HTMLElement): HTMLElement {
  const input = editable(container);
  const first = input.firstElementChild as HTMLElement | null;
  if (!first) throw new Error('composer block was not mounted');
  return first;
}

function tagIdAt(container: HTMLElement, index: number): string | null {
  const child = block(container).childNodes[index];
  return child instanceof HTMLElement ? child.getAttribute('data-selection-id') : null;
}

function tagCount(container: HTMLElement): number {
  return container.querySelectorAll('.attach-tag').length;
}

function childSummary(container: HTMLElement): string[] {
  return [...block(container).childNodes]
    .filter((node) => !(node.nodeType === Node.ELEMENT_NODE && node.nodeName === 'BR'))
    .filter((node) => (node.textContent ?? '').length > 0)
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return `#text(${node.textContent ?? ''})`;
      if (node.nodeType !== Node.ELEMENT_NODE) return node.nodeName.toLowerCase();
      const element = node as HTMLElement;
      // Lexical wraps a text node in a span, so the wrapper is what carries the
      // distinction between a word and a tag.
      if (element.hasAttribute('data-lexical-text')) return `#text(${element.textContent ?? ''})`;
      return element.nodeName.toLowerCase();
    });
}

interface HarnessProps {
  attachmentIds: string[];
  selections: readonly SelectionRecord[];
  onRemove?: (selectionId: string) => void;
  onRestore?: (selectionId: string) => void;
  onReady?: (controller: ComposerEditorController | null) => void;
  onTextChange?: (text: string) => void;
}

const NOOP: () => void = () => {};

function Harness({ attachmentIds, selections, onRemove, onRestore, onReady, onTextChange }: HarnessProps) {
  const [armedSelectionId, setArmedSelectionId] = useState<string | null>(null);
  const views = buildAttachmentViews(
    selections,
    new Map(selections.map((selection, index) => [selection.selectionId, index + 1])),
    { s1: capture(), s2: capture({ selectionId: 's2' }) },
  );
  return (
    <ComposerEditor
      attachmentIds={attachmentIds}
      attachmentContext={{
        views: attachmentViewsById(views),
        armedSelectionId,
        onRemove: onRemove ?? vi.fn(),
        onRefresh: vi.fn(),
      }}
      onArmChange={setArmedSelectionId}
      onRestore={onRestore}
      onSubmit={NOOP}
      onReady={onReady ?? NOOP}
      onTextChange={onTextChange ?? NOOP}
      placeholder="Ask…"
    />
  );
}

function controllerHolder(): { current: ComposerEditorController | null } {
  return { current: null };
}

async function type(controller: ComposerEditorController | null, text: string): Promise<void> {
  await act(async () => {
    controller?.insertText(text);
  });
}

async function pressKey(input: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    input.dispatchEvent(event);
  });
  return event;
}

const TWO = [record(), record({ selectionId: 's2', component: 'SecondaryButton' })];

describe('composer typing with inline tags', () => {
  it('keeps the tags and puts typed text inline after them in a single block', async () => {
    const holder = controllerHolder();
    const { container } = mount(
      <Harness attachmentIds={['s1', 's2']} selections={TWO} onReady={(c) => { holder.current = c; }} />,
    );
    expect(tagCount(container)).toBe(2);

    await type(holder.current, 'make this roomier');

    expect(tagCount(container)).toBe(2);
    expect(editable(container).children.length).toBe(1);
    expect(childSummary(container)).toHaveLength(3);
    expect(block(container).firstElementChild?.getAttribute('data-selection-id')).toBe('s1');
    expect(block(container).children[1].getAttribute('data-selection-id')).toBe('s2');
    expect(block(container).lastElementChild?.textContent).toBe('make this roomier');
    // Tags render as the citation references the model already knows.
    expect(holder.current?.getPlainText()).toBe('({1}) ({2}) make this roomier');
    // The send gate must ignore the references: tags alone are not a request.
    expect(holder.current?.getTypedText()).toBe('make this roomier');
  });

  it('inserts a new tag at the caret instead of at the front of the sentence', async () => {
    const holder = controllerHolder();
    const onReady = (c: ComposerEditorController | null) => { holder.current = c; };
    const { container, root } = mount(
      <Harness attachmentIds={[]} selections={[]} onReady={onReady} />,
    );

    await type(holder.current, 'make this roomier');

    await act(async () => {
      root.render(<Harness attachmentIds={['s1']} selections={[TWO[0]]} onReady={onReady} />);
    });

    expect(childSummary(container)).toEqual(['#text(make this roomier)', 'span']);
    expect(tagIdAt(container, 1)).toBe('s1');
    expect(holder.current?.getPlainText()).toBe('make this roomier ({1})');
  });

  it('lets a tag land between words when that is where the caret is', async () => {
    const holder = controllerHolder();
    const onReady = (c: ComposerEditorController | null) => { holder.current = c; };
    const { container, root } = mount(
      <Harness attachmentIds={[]} selections={[]} onReady={onReady} />,
    );

    await type(holder.current, 'make this ');
    await act(async () => {
      root.render(<Harness attachmentIds={['s1']} selections={[TWO[0]]} onReady={onReady} />);
    });
    await type(holder.current, 'roomier');

    expect(childSummary(container)).toEqual(['#text(make this )', 'span', '#text(roomier)']);
    expect(tagIdAt(container, 1)).toBe('s1');
    expect(holder.current?.getPlainText()).toBe('make this ({1}) roomier');
  });

  it('never emits a leading newline for text typed after the tags', async () => {
    const holder = controllerHolder();
    const onTextChange = vi.fn();
    mount(
      <Harness
        attachmentIds={['s1', 's2']}
        selections={TWO}
        onReady={(c) => { holder.current = c; }}
        onTextChange={onTextChange}
      />,
    );

    await type(holder.current, 'tighten the radius');
    await type(holder.current, ' and the shadow');

    for (const call of onTextChange.mock.calls) {
      expect(String(call[0])).not.toMatch(/^\n/);
    }
  });

  it('brings a deleted tag back on undo and asks the target to re-select it', async () => {
    vi.useFakeTimers();
    const holder = controllerHolder();
    const onRemove = vi.fn();
    const onRestore = vi.fn();
    const onReady = (c: ComposerEditorController | null) => { holder.current = c; };
    const { container, root } = mount(
      <Harness
        attachmentIds={['s1', 's2']}
        selections={TWO}
        onRemove={onRemove}
        onRestore={onRestore}
        onReady={onReady}
      />,
    );
    const input = editable(container);

    await pressKey(input, { key: 'Backspace' });
    await pressKey(input, { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('s2');
    // The target confirmed the deselect, so the authoritative list shrank.
    await act(async () => {
      root.render(
        <Harness
          attachmentIds={['s1']}
          selections={TWO}
          onRemove={onRemove}
          onRestore={onRestore}
          onReady={onReady}
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(tagCount(container)).toBe(1);

    await pressKey(input, { key: 'z', ctrlKey: true });

    // The tag is back, and the target outline is asked to follow it.
    expect(tagCount(container)).toBe(2);
    expect(onRestore).toHaveBeenCalledWith('s2');
  });

  it('deletes a swallowed tag and the text around it, with no arm step', async () => {
    vi.useFakeTimers();
    const holder = controllerHolder();
    const onRemove = vi.fn();
    const onReady = (c: ComposerEditorController | null) => { holder.current = c; };
    const { container, root } = mount(
      <Harness
        attachmentIds={[]}
        selections={[]}
        onRemove={onRemove}
        onReady={onReady}
      />,
    );

    await type(holder.current, 'make this ');
    await act(async () => {
      root.render(
        <Harness
          attachmentIds={['s1']}
          selections={[record()]}
          onRemove={onRemove}
          onReady={onReady}
        />,
      );
    });
    await type(holder.current, 'roomier');
    expect(childSummary(container)).toEqual(['#text(make this )', 'span', '#text(roomier)']);

    // Drag from the start of the sentence to the end: a tag is inside.
    const input = editable(container);
    const spans = [...block(container).querySelectorAll<HTMLElement>('[data-lexical-text]')];
    const start = spans[0]?.firstChild;
    const end = spans[1]?.firstChild;
    const selection = window.getSelection();
    if (!start || !end || !selection) throw new Error('composer text nodes were not mounted');
    selection.removeAllRanges();
    selection.setBaseAndExtent(start, 0, end, end.textContent?.length ?? 0);
    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'));
    });

    await pressKey(input, { key: 'Backspace' });

    // A multi-node gesture is deliberate: no arm, the target is told at once.
    expect(onRemove).toHaveBeenCalledWith('s1');
    expect(holder.current?.getTypedText()).toBe('');
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('restores a locally removed tag when the authoritative list still contains it', async () => {
    vi.useFakeTimers();
    const onRemove = vi.fn();
    const { container } = mount(
      <Harness attachmentIds={['s1', 's2']} selections={TWO} onRemove={onRemove} />,
    );
    const input = editable(container);

    await pressKey(input, { key: 'Backspace' });
    expect(onRemove).not.toHaveBeenCalled();
    expect(tagCount(container)).toBe(2);

    await pressKey(input, { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('s2');
    expect(container.querySelector('[data-selection-id="s2"][data-removing="true"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(tagCount(container)).toBe(2);
    expect(container.querySelector('[data-removing="true"]')).toBeNull();
  });

  it('drops a locally removed tag once the authoritative list shrinks', async () => {
    vi.useFakeTimers();
    const onRemove = vi.fn();
    const { container, root } = mount(
      <Harness attachmentIds={['s1', 's2']} selections={TWO} onRemove={onRemove} />,
    );
    const input = editable(container);

    await pressKey(input, { key: 'Backspace' });
    await pressKey(input, { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('s2');

    await act(async () => {
      root.render(<Harness attachmentIds={['s1']} selections={TWO} onRemove={onRemove} />);
    });
    expect(tagCount(container)).toBe(2);
    expect(container.querySelector('[data-selection-id="s2"][data-removing="true"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(tagCount(container)).toBe(1);
    expect(container.querySelector('[data-selection-id="s1"]')).not.toBeNull();
  });

  it('hides the visual placeholder while tags are present and restores it when empty', async () => {
    const { container, root } = mount(<Harness attachmentIds={['s1']} selections={[record()]} />);
    expect(container.querySelector('.compose-placeholder')).toBeNull();

    await act(async () => {
      root.render(<Harness attachmentIds={[]} selections={[]} />);
    });
    expect(container.querySelector('.compose-placeholder')?.textContent).toBe('Ask…');
  });

  it('lets the caret walk through the tags, but keeps a shortcut from deleting one', async () => {
    const { container } = mount(<Harness attachmentIds={['s1', 's2']} selections={TWO} />);
    const input = editable(container);

    // Arrow keys are Lexical's own business; what matters is that a caret in the
    // tag run is legal rather than yanked back out of it.
    await pressKey(input, { key: 'ArrowLeft' });
    await pressKey(input, { key: 'ArrowLeft' });
    expect(tagCount(container)).toBe(2);

    // Ctrl+Backspace is a shortcut rather than a gesture, so it stops at a tag.
    const ctrlBackspace = await pressKey(input, { key: 'Backspace', ctrlKey: true });
    expect(ctrlBackspace.defaultPrevented).toBe(true);
    expect(tagCount(container)).toBe(2);
  });

  // The character deletion itself is the browser's: Lexical leaves collapsed
  // Backspace to native contenteditable editing, which jsdom does not implement.
  // What is asserted here is that the composer never swallows the key, and that
  // a hold can never be mistaken for a confirmation. The repeat deleting real
  // characters is covered by the browser end-to-end run.
  it('never treats a held Backspace as a confirmation', async () => {
    const onRemove = vi.fn();
    const holder = controllerHolder();
    const { container } = mount(
      <Harness
        attachmentIds={['s1']}
        selections={[record()]}
        onRemove={onRemove}
        onReady={(c) => { holder.current = c; }}
      />,
    );
    const input = editable(container);

    await type(holder.current, 'abc');
    // Clear of the tag: nothing of ours may run, and the tag stays.
    await pressKey(input, { key: 'Backspace', repeat: true });
    expect(onRemove).not.toHaveBeenCalled();
    expect(tagCount(container)).toBe(1);
    expect(holder.current?.getTypedText()).toBe('abc');
  });

  it('abandons the two-step arm when Backspace is held next to a tag', async () => {
    const onRemove = vi.fn();
    const { container } = mount(
      <Harness attachmentIds={['s1']} selections={[record()]} onRemove={onRemove} />,
    );
    const input = editable(container);

    // First press arms; the hold that follows must not read as a confirmation.
    await pressKey(input, { key: 'Backspace' });
    await pressKey(input, { key: 'Backspace', repeat: true });

    expect(onRemove).not.toHaveBeenCalled();
    expect(tagCount(container)).toBe(1);
  });

  it('keeps a single block when the text grows past the tag row', async () => {
    const holder = controllerHolder();
    const { container } = mount(
      <Harness attachmentIds={['s1']} selections={[record()]} onReady={(c) => { holder.current = c; }} />,
    );

    await type(holder.current, 'word '.repeat(60));

    expect(editable(container).children.length).toBe(1);
    expect(tagCount(container)).toBe(1);
  });
});


describe('tags inline with the text', () => {
  function withDocument(
    run: (paragraph: ParagraphNode, left: TextNode, right: TextNode) => void,
    build: (paragraph: ParagraphNode) => void = (paragraph) => {
      paragraph.append(
        $createAttachmentNode('s1'),
        $createTextNode('make '),
        $createAttachmentNode('s2'),
        $createTextNode('roomier'),
      );
    },
  ): void {
    const editor = createEditor({ namespace: 'composer-document-test', nodes: [AttachmentNode] });
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        build(paragraph);
        $getRoot().clear().append(paragraph);
        run(paragraph, $createTextNode(''), $createTextNode(''));
      },
      { discrete: true },
    );
  }

  function textChild(paragraph: ParagraphNode, index: number): TextNode {
    const child = paragraph.getChildAtIndex(index);
    if (!$isTextNode(child)) throw new Error(`child ${index} is not a text node`);
    return child;
  }

  it('finds the tag on either side of a collapsed caret', () => {
    let afterTag: string | null = null;
    withDocument((paragraph) => {
      textChild(paragraph, 1).select(0, 0);
      afterTag = $adjacentAttachment();
    });
    expect(afterTag).toBe('s1');

    let beforeTag: string | null = null;
    withDocument((paragraph) => {
      textChild(paragraph, 3).select(0, 0);
      beforeTag = $adjacentAttachment();
    });
    expect(beforeTag).toBe('s2');
  });

  it('finds a tag at the far edge of the text it precedes', () => {
    let result: string | null = null;
    withDocument(
      (paragraph) => {
        textChild(paragraph, 0).select(5, 5);
        result = $adjacentAttachment();
      },
      (paragraph) => {
        paragraph.append($createTextNode('make '), $createAttachmentNode('s1'));
      },
    );
    expect(result).toBe('s1');
  });


  it('finds a tag through an element point on either side', () => {
    let left: string | null = null;
    withDocument((paragraph) => {
      paragraph.select(1, 1);
      left = $adjacentAttachment();
    });
    expect(left).toBe('s1');

    let right: string | null = null;
    withDocument((paragraph) => {
      paragraph.select(2, 2);
      right = $adjacentAttachment();
    });
    expect(right).toBe('s2');
  });

  it('reports nothing in the middle of a word, so a character still deletes', () => {
    let result: string | null = 'unset';
    withDocument((paragraph) => {
      textChild(paragraph, 1).select(2, 2);
      result = $adjacentAttachment();
    });
    expect(result).toBeNull();
  });

  it('lists every tag a drag swallowed, in document order', () => {
    let result: string[] = [];
    withDocument((paragraph) => {
      // A drag from before s1 to the end of the sentence: both tags are inside.
      const selection = $createRangeSelection();
      selection.anchor.set(paragraph.getKey(), 0, 'element');
      selection.focus.set(textChild(paragraph, 3).getKey(), 7, 'text');
      $setSelection(selection);
      result = $tagsInSelection();
    });
    expect(result).toEqual(['s1', 's2']);
  });

  it('lists no tag for a range of plain text', () => {
    let result: string[] = ['unset'];
    withDocument((paragraph) => {
      textChild(paragraph, 3).select(1, 4);
      result = $tagsInSelection();
    });
    expect(result).toEqual([]);
  });


  it('lists nothing for a collapsed caret', () => {
    let result: string[] = ['unset'];
    withDocument((paragraph) => {
      paragraph.select(1, 1);
      result = $tagsInSelection();
    });
    expect(result).toEqual([]);
  });

  it('reconciles a missing tag in without moving the ones already placed', () => {
    const editor = createEditor({ namespace: 'composer-document-test', nodes: [AttachmentNode] });
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append(
          $createTextNode('make '),
          $createAttachmentNode('s1'),
          $createTextNode('this roomier ok'),
        );
        $getRoot().clear().append(paragraph);
        // Caret after "this ", which is inside the last word: the new tag has
        // to split it rather than jump to the front of the sentence.
        textChild(paragraph, 2).select(5, 5);
        expect($reconcileTagNodes(['s1', 's2']).inserted).toEqual(['s2']);
        const ids = paragraph.getChildren().flatMap((child) =>
          child instanceof AttachmentNode ? [child.getSelectionId()] : [],
        );
        expect(ids).toEqual(['s1', 's2']);
        expect(textChild(paragraph, 0).getTextContent()).toBe('make ');
        expect(textChild(paragraph, 2).getTextContent()).toBe('this ');
        expect(textChild(paragraph, 4).getTextContent()).toBe(' roomier ok');
      },
      { discrete: true },
    );
  });


  it('is a no-op when the document already matches the props', () => {
    const editor = createEditor({ namespace: 'composer-document-test', nodes: [AttachmentNode] });
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createAttachmentNode('s2'), $createTextNode('x'), $createAttachmentNode('s1'));
        $getRoot().clear().append(paragraph);
        // Order in the document is the user's, not the props', and that is fine.
        expect($reconcileTagNodes(['s1', 's2'])).toEqual({
          inserted: [],
          removed: [],
          restored: [],
        });
      },
      { discrete: true },
    );
  });
});

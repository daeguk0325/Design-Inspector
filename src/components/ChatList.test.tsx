import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CitationSnapshot, ChatMessage } from '../state/models.ts';
import { ChatList, type MessagePreviewStatus } from './ChatList.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function click(target: Element | null | undefined): void {
  act(() => {
    (target as HTMLElement | null)?.click();
  });
}

function citation(overrides: Partial<CitationSnapshot> = {}): CitationSnapshot {
  return {
    selectionId: 's1',
    elementKey: 'button.primary',
    component: 'PrimaryButton',
    file: 'src/ui/Button.tsx',
    line: 42,
    mode: 'html',
    displayNumber: 1,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'Make the primary button tighter',
    citations: [],
    pinned: false,
    pinnedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

describe('ChatList inline citation references', () => {
  const TWO = [
    citation(),
    citation({
      selectionId: 's2',
      component: 'Card',
      file: 'src/ui/Card.tsx',
      line: 7,
      displayNumber: 2,
    }),
  ];

  function render(messages: ChatMessage[]): HTMLElement {
    return mount(
      <ChatList
        messages={messages}
        streaming={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
  }

  it('renders each reference as a chip where it was written', () => {
    const container = render([
      message({ content: 'make this roomier ({1}) and ({2}) tighter', citations: TWO }),
    ]);

    const chips = container.querySelectorAll('.msg.user .cite-inline');
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector('.cite-inline-num')?.textContent).toBe('1');
    expect(chips[0].querySelector('.cite-inline-name')?.textContent).toBe('PrimaryButton');
    expect(chips[0].getAttribute('title')).toContain('src/ui/Button.tsx:42');
    expect(chips[1].querySelector('.cite-inline-name')?.textContent).toBe('Card');
    // The words around the reference survive, in order.
    expect(container.querySelector('.user-text')?.textContent)
      .toBe('make this roomier 1PrimaryButton and 2Card tighter');
  });

  it('puts no tag row under a user bubble any more', () => {
    const container = render([message({ content: 'make this roomier ({1})', citations: TWO })]);
    expect(container.querySelectorAll('.msg.user .msg-attach')).toHaveLength(0);
    expect(container.querySelectorAll('.msg.user .attach-chip')).toHaveLength(0);
  });

  it('keeps the citation row on an assistant message', () => {
    const container = render([
      message({ id: 'm1', role: 'user', content: 'make this roomier ({1})', citations: TWO }),
      message({
        id: 'm2',
        role: 'assistant',
        content: 'adjusted ({1})',
        status: 'completed',
        citations: [citation()],
      }),
    ]);
    expect(container.querySelectorAll('.msg.user .msg-attach')).toHaveLength(0);
    const assistantChips = container.querySelectorAll('.msg.assistant .msg-attach .attach-chip');
    expect(assistantChips).toHaveLength(1);
    expect(assistantChips[0].querySelector('.attach-chip-name')?.textContent).toBe('PrimaryButton');
  });

  it('turns a marker in an answer into a chip that re-selects the component', () => {
    const onCite = vi.fn();
    const container = mount(
      <ChatList
        messages={[message({
          id: 'm2',
          role: 'assistant',
          content: 'the padding of ({1}) is tight',
          status: 'completed',
          citations: [citation()],
        })]}
        streaming={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
        onCite={onCite}
      />,
    );
    const chip = container.querySelector<HTMLButtonElement>('.msg.assistant .cite-inline-btn');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('PrimaryButton');
    expect(container.querySelector('.msg.assistant .md')?.textContent).not.toContain('({1})');
    click(chip);
    expect(onCite).toHaveBeenCalledWith('s1');
  });

  it('leaves an answer marker as text when the answer carries no citations', () => {
    const container = render([
      message({
        id: 'm2',
        role: 'assistant',
        content: 'the padding of ({1}) is tight',
        status: 'completed',
        citations: [],
      }),
    ]);
    expect(container.querySelectorAll('.cite-inline-btn')).toHaveLength(0);
    expect(container.querySelector('.msg.assistant .md')?.textContent).toContain('({1})');
  });

  it('leaves a marker the user typed by hand as plain text', () => {
    const container = render([message({ content: 'use ({7}) for the grid', citations: [citation()] })]);
    expect(container.querySelectorAll('.cite-inline')).toHaveLength(0);
    expect(container.querySelector('.user-text')?.textContent).toBe('use ({7}) for the grid');
  });

  it('does not turn parenthesised numbering into a reference', () => {
    const container = render([message({ content: '우선순위 (1) 여백, (2) 대비', citations: [citation()] })]);
    expect(container.querySelectorAll('.cite-inline')).toHaveLength(0);
    expect(container.querySelector('.user-text')?.textContent).toBe('우선순위 (1) 여백, (2) 대비');
  });

  it('never carries image data with a reference', () => {
    const container = render([
      message({ content: 'make this roomier ({1})', citations: [citation({ extra: { text: 'Save' } })] }),
    ]);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('data:image');
    expect(container.innerHTML).not.toContain('base64');
  });

  it('falls back to the element key, file without a line, and the mode', () => {
    const container = render([
      message({
        content: '({1}) ({2}) ({3})',
        citations: [
          citation({ component: null }),
          citation({ selectionId: 's2', component: 'Card', file: 'src/ui/Card.tsx', line: null, displayNumber: 2 }),
          citation({ selectionId: 's3', component: 'Stage', file: null, mode: '3d', displayNumber: 3 }),
        ],
      }),
    ]);
    const names = [...container.querySelectorAll('.cite-inline-name')].map((n) => n.textContent);
    const titles = [...container.querySelectorAll('.cite-inline')].map((n) => n.getAttribute('title'));
    expect(names).toEqual(['button.primary', 'Card', 'Stage']);
    expect(titles[0]).toContain('src/ui/Button.tsx:42');
    expect(titles[1]).toContain('src/ui/Card.tsx');
    expect(titles[2]).toContain('3D');
  });

  it('renders no reference and no text for an empty request', () => {
    const container = render([message({ content: '', citations: [citation()] })]);
    expect(container.querySelectorAll('.cite-inline')).toHaveLength(0);
    expect(container.querySelector('.user-text')).toBeNull();
  });

  it('copies the raw sentence, markers included', () => {
    const onCopy = vi.fn();
    const container = mount(
      <ChatList
        messages={[message({ content: 'make this roomier ({1})', citations: [citation()] })]}
        streaming={false}
        onCopy={onCopy}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    click(container.querySelector('.msg.user .actions .mini'));
    expect(onCopy).toHaveBeenCalledWith('make this roomier ({1})');
  });
});

describe('ChatList message actions', () => {
  it('keeps Copy, Pin, and Retry working next to the new controls', () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    const onTogglePin = vi.fn();
    const onRetry = vi.fn();
    const user = message({ id: 'm1', citations: [citation()] });
    const container = mount(
      <ChatList
        messages={[user]}
        streaming={false}
        onCopy={onCopy}
        onTogglePin={onTogglePin}
        onRetry={onRetry}
        onDecision={vi.fn()}
        onUndoPreview={vi.fn()}
        previews={{ m1: { status: 'applied' } }}
      />,
    );

    const actions = container.querySelector('.msg.user .actions');
    click(actions?.querySelector('[aria-label^="Copy"]'));
    expect(onCopy).toHaveBeenCalledWith(user.content);
    expect(actions?.querySelector('[aria-label^="Copy"]')?.textContent).toBe('Copied ✓');

    click([...actions!.querySelectorAll('button')].find((b) => b.textContent === 'Pin'));
    expect(onTogglePin).toHaveBeenCalledWith('m1');

    click([...actions!.querySelectorAll('button')].find((b) => b.textContent === 'Retry'));
    expect(onRetry).toHaveBeenCalledWith(user);
    vi.useRealTimers();
  });
});

describe('ChatList decision controls', () => {
  it('marks the recorded decision and reports the next one', () => {
    const onDecision = vi.fn();
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: 'Done', citations: [], decision: 'accepted' })]}
        streaming={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
        onDecision={onDecision}
      />,
    );

    const group = container.querySelector('.msg.assistant .decide');
    expect(group?.getAttribute('role')).toBe('group');
    const accepted = group?.querySelector<HTMLElement>('[data-decision="accepted"]');
    const revise = group?.querySelector<HTMLElement>('[data-decision="needs-revision"]');
    const reject = group?.querySelector<HTMLElement>('[data-decision="rejected"]');
    expect(accepted?.getAttribute('aria-pressed')).toBe('true');
    expect(revise?.getAttribute('aria-pressed')).toBe('false');

    click(revise);
    click(reject);
    expect(onDecision.mock.calls).toEqual([['a1', 'needs-revision'], ['a1', 'rejected']]);
  });

  it('is absent without a handler and on user messages', () => {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: 'Done' }), message({ id: 'u2' })]}
        streaming={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('.decide')).toHaveLength(0);
  });
});

describe('ChatList preview state', () => {
  const assistant = message({ id: 'a1', role: 'assistant', content: 'Applied' });

  it('shows status, the live-target label, and an enabled undo', () => {
    const onUndoPreview = vi.fn();
    const previews = new Map<string, MessagePreviewStatus>([
      ['a1', { status: 'applied', enabled: true, changeCount: 2 }],
    ]);
    const container = mount(
      <ChatList
        messages={[assistant]}
        streaming={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
        previews={previews}
        onUndoPreview={onUndoPreview}
      />,
    );

    const state = container.querySelector('.msg.assistant .preview-state');
    expect(state?.getAttribute('data-state')).toBe('applied');
    expect(state?.textContent).toContain('Applied');
    expect(state?.textContent).toContain('2 changes');
    const diff = container.querySelector('.preview-diff');
    expect(diff?.getAttribute('aria-label')).toBe('Applied to the live target');
    expect(diff?.querySelectorAll('.preview-slot')).toHaveLength(1);
    expect(diff?.textContent).toBe('Live target');

    const undo = container.querySelector<HTMLButtonElement>('.preview-undo');
    expect(undo?.disabled).toBe(false);
    click(undo);
    expect(onUndoPreview).toHaveBeenCalledWith('a1');
  });

  it('disables undo when nothing is applied and honours record lookups', () => {
    const previews: Readonly<Record<string, MessagePreviewStatus>> = {
      a1: { status: 'undone', errorCode: 'anchor-missing' },
    };
    const container = mount(
      <ChatList
        messages={[assistant]}
        streaming={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
        previews={previews}
        onUndoPreview={vi.fn()}
      />,
    );
    const state = container.querySelector('.preview-state');
    expect(state?.getAttribute('data-state')).toBe('undone');
    expect(state?.getAttribute('title')).toContain('anchor-missing');
    expect(container.querySelector<HTMLButtonElement>('.preview-undo')?.disabled).toBe(true);
  });

  it('renders preview state only for the message that owns it', () => {
    const container = mount(
      <ChatList
        messages={[assistant, message({ id: 'u2' })]}
        streaming={false}
        onCopy={vi.fn()}
        onTogglePin={vi.fn()}
        onRetry={vi.fn()}
        previews={{ u2: { status: 'applied' } }}
      />,
    );
    expect(container.querySelectorAll('.preview-row')).toHaveLength(0);
  });
});

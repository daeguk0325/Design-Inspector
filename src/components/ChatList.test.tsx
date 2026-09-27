import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CitationSnapshot, ChatMessage } from '../state/models.ts';
import type { DesignDecision } from '../preview/transaction.ts';
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
        onRevert={vi.fn()}
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
        onRevert={vi.fn()}
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
        onRevert={vi.fn()}
      />,
    );
    click(container.querySelector('.msg.user .actions .mini'));
    expect(onCopy).toHaveBeenCalledWith('make this roomier ({1})');
  });
});

describe('ChatList message actions', () => {
  it('offers Copy and Rewind as icons, with no Pin and no Retry', () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    const onRevert = vi.fn();
    const user = message({ id: 'm1', citations: [citation()] });
    const container = mount(
      <ChatList
        messages={[user]}
        streaming={false}
        onCopy={onCopy}
        onRevert={onRevert}
        onDecision={vi.fn()}
        previews={{ m1: { status: 'applied' } }}
      />,
    );

    const actions = container.querySelector('.msg.user .actions');
    const copy = actions?.querySelector('[aria-label^="Copy"]');
    expect(copy?.textContent?.trim()).toBe('Copy');
    click(copy);
    expect(onCopy).toHaveBeenCalledWith(user.content);
    expect(copy?.textContent?.trim()).toBe('Copied');

    const rewind = actions?.querySelector('[aria-label^="Rewind"]');
    expect(rewind).not.toBeNull();
    click(rewind);
    expect(onRevert).toHaveBeenCalledWith(user);
    // The Accept/Reject toggle is the only rollback affordance, so there is no
    // separate undo control to reach for.
    expect(container.querySelector('.preview-undo')).toBeNull();
    vi.useRealTimers();
  });
});

describe('ChatList decision controls', () => {
  function renderPreview(
    preview: MessagePreviewStatus,
    decision: ChatMessage['decision'] = undefined,
    onDecision: Mock<(messageId: string, decision: DesignDecision) => void> = vi.fn(),
  ): { container: HTMLElement; onDecision: Mock<(messageId: string, decision: DesignDecision) => void> } {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: 'Done', decision })]}
        streaming={false}
        onCopy={vi.fn()}
        onRevert={vi.fn()}
        onDecision={onDecision}
        previews={{ a1: preview }}
      />,
    );
    return { container, onDecision };
  }

  const pending = (overrides: Partial<MessagePreviewStatus> = {}): MessagePreviewStatus => ({
    status: 'applied',
    proposalState: 'pending',
    summaryLines: ['PrimaryButton: padding 12px'],
    ...overrides,
  });

  it('offers only Accept and Reject, and never Revise', () => {
    const { container, onDecision } = renderPreview(
      pending({ summaryLines: ['PrimaryButton: padding 12px'] }),
    );

    const group = container.querySelector('.msg.assistant .decide');
    expect(group?.getAttribute('role')).toBe('group');
    // The group names what it flips, so a screen reader is not left reading two
    // buttons called Accept and Reject with no subject.
    expect(group?.getAttribute('aria-label')).toBe("This answer's previewed change");
    const accepted = group?.querySelector<HTMLElement>('[data-decision="accepted"]');
    const reject = group?.querySelector<HTMLElement>('[data-decision="rejected"]');
    expect(accepted).not.toBeNull();
    expect(reject).not.toBeNull();
    // Revise was a state with no behaviour behind it.
    expect(group?.querySelector('[data-decision="needs-revision"]')).toBeNull();
    expect(group?.querySelectorAll('button')).toHaveLength(2);

    click(accepted);
    click(reject);
    expect(onDecision.mock.calls).toEqual([['a1', 'accepted'], ['a1', 'rejected']]);
  });

  it('reads Accept before the user has decided anything', () => {
    // The change is already on the page when the answer streams out, so the
    // toggle starts on Accept. Nothing has to be confirmed to see the change.
    const { container } = renderPreview(pending());
    const accepted = container.querySelector('.decide-btn[data-decision="accepted"]');
    const reject = container.querySelector('.decide-btn[data-decision="rejected"]');
    expect(accepted?.getAttribute('aria-pressed')).toBe('true');
    expect(reject?.getAttribute('aria-pressed')).toBe('false');
  });

  it('names the change on the left with the lines the next request carries', () => {
    const { container } = renderPreview(
      pending({ summaryLines: ['PrimaryButton: padding 12px 16px', 'PrimaryButton: border-radius 10px'] }),
    );

    const row = container.querySelector('.msg.assistant .preview-row');
    expect(row).not.toBeNull();
    const changes = [...container.querySelectorAll('.preview-change')].map((n) => n.textContent);
    expect(changes).toEqual(['PrimaryButton: padding 12px 16px', 'PrimaryButton: border-radius 10px']);
    // One row: the summary, then the toggle, and none of the old furniture.
    expect(row?.firstElementChild?.classList.contains('preview-state')).toBe(true);
    expect(row?.lastElementChild?.classList.contains('decide')).toBe(true);
    expect(container.querySelectorAll('.preview-row')).toHaveLength(1);
    expect(container.querySelector('.proposal')).toBeNull();
    expect(container.querySelector('.proposal-state')).toBeNull();
    expect(container.querySelector('.proposal-note')).toBeNull();
    expect(container.textContent).not.toContain('Waiting for you');
    expect(container.textContent).not.toContain('Live target');
    expect(container.querySelector('.preview-undo')).toBeNull();
  });

  it('keeps both halves of the toggle after a decision, so the mind can change', () => {
    const onDecision = vi.fn();
    const { container } = renderPreview(pending({ proposalState: 'rejected' }), 'rejected', onDecision);

    const group = container.querySelector('.msg.assistant .decide');
    const accepted = group?.querySelector<HTMLElement>('[data-decision="accepted"]');
    const reject = group?.querySelector<HTMLElement>('[data-decision="rejected"]');
    expect(accepted?.getAttribute('aria-pressed')).toBe('false');
    expect(reject?.getAttribute('aria-pressed')).toBe('true');
    // Flip-back stays reachable: a recorded decision is not a final one.
    click(accepted);
    expect(onDecision).toHaveBeenCalledWith('a1', 'accepted');

    const { container: acceptedRow } = renderPreview(
      pending({ proposalState: 'accepted', summaryLines: ['Card: gap 8px'] }),
      'accepted',
    );
    expect(acceptedRow.querySelector('.decide-btn[data-decision="accepted"]')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(acceptedRow.textContent).toContain('Card: gap 8px');
  });

  it('says so in the same row when the preview failed', () => {
    const { container } = renderPreview(
      pending({ status: 'rejected', errorCode: 'anchor-missing' }),
    );
    const state = container.querySelector('.msg.assistant .preview-state');
    expect(state?.getAttribute('data-state')).toBe('rejected');
    // A failure that read like a clean row is the one thing this row must not do.
    expect(state?.textContent).toContain('Not applied');
    expect(state?.textContent).toContain('anchor-missing');
    expect(state?.textContent).toContain('PrimaryButton: padding 12px');
    expect(container.querySelectorAll('.preview-row')).toHaveLength(1);
  });

  it('still says so when a failure left no change to name', () => {
    const { container } = renderPreview({ status: 'rejected', errorCode: 'anchor-missing' });
    expect(container.querySelector('.preview-row')).not.toBeNull();
    expect(container.querySelector('.preview-error')?.textContent).toBe('Not applied · anchor-missing');
  });

  it('offers no decision for an answer that proposed nothing', () => {
    const { container } = renderPreview({ status: 'applied' });
    expect(container.querySelectorAll('.decide')).toHaveLength(0);
    expect(container.querySelector('.preview-row')).toBeNull();
  });

  it('is absent without a handler and on user messages', () => {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: 'Done' }), message({ id: 'u2' })]}
        streaming={false}
        onCopy={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('.decide')).toHaveLength(0);
  });
});

describe('ChatList preview state', () => {
  const assistant = message({ id: 'a1', role: 'assistant', content: 'Applied' });

  it('says a change that is not on the page, and no live-target badge', () => {
    const previews = new Map<string, MessagePreviewStatus>([
      ['a1', { status: 'applied', enabled: true, changeCount: 2, summaryLines: ['Card: gap 8px'] }],
    ]);
    const container = mount(
      <ChatList
        messages={[assistant]}
        streaming={false}
        onCopy={vi.fn()}
        onRevert={vi.fn()}
        previews={previews}
        onDecision={vi.fn()}
      />,
    );

    const state = container.querySelector('.msg.assistant .preview-state');
    expect(state?.getAttribute('data-state')).toBe('applied');
    expect(state?.textContent).toContain('Card: gap 8px');
    // An applied change needs no status word: the toggle beside it already says
    // the change is kept, and the badge named nothing the user could act on.
    expect(state?.textContent).not.toContain('Applied');
    expect(container.querySelector('.preview-diff')).toBeNull();
    expect(container.textContent).not.toContain('Live target');
    expect(container.querySelector('.preview-undo')).toBeNull();
  });

  it('reports a status that is not applied and honours record lookups', () => {
    const previews: Readonly<Record<string, MessagePreviewStatus>> = {
      a1: { status: 'ambiguous', summaryLines: ['Card: gap 8px'] },
    };
    const container = mount(
      <ChatList
        messages={[assistant]}
        streaming={false}
        onCopy={vi.fn()}
        onRevert={vi.fn()}
        previews={previews}
      />,
    );
    const state = container.querySelector('.preview-state');
    expect(state?.getAttribute('data-state')).toBe('ambiguous');
    expect(state?.textContent).toContain('Ambiguous match');
    expect(state?.textContent).toContain('Card: gap 8px');
  });

  it('renders preview state only for the message that owns it', () => {
    const container = mount(
      <ChatList
        messages={[assistant, message({ id: 'u2' })]}
        streaming={false}
        onCopy={vi.fn()}
        onRevert={vi.fn()}
        previews={{ u2: { status: 'applied' } }}
      />,
    );
    expect(container.querySelectorAll('.preview-row')).toHaveLength(0);
  });
});

describe('ChatList thinking log', () => {
  function renderThinking(overrides: Partial<ChatMessage> = {}, streaming = false): HTMLElement {
    return mount(
      <ChatList
        messages={[message({
          id: 'a1',
          role: 'assistant',
          content: 'Done',
          status: 'completed',
          thinking: 'First I considered the padding.\nThen the radius.\nThen the color.\nThen the font.\nThen the gap.\nThen done.',
          ...overrides,
        })]}
        streaming={streaming}
        onCopy={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
  }

  it('shows the reasoning log above the answer, collapsed to a preview', () => {
    const container = renderThinking();
    const block = container.querySelector('.msg.assistant .thinking');
    expect(block).not.toBeNull();
    expect(block?.classList.contains('open')).toBe(false);
    // The toggle sits before the bubble in the message, because the model
    // thought first and wrote second.
    const msg = container.querySelector('.msg.assistant');
    expect(msg?.firstElementChild?.classList.contains('thinking')).toBe(true);
    const toggle = container.querySelector<HTMLButtonElement>('.thinking-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.thinking-body')?.textContent).toContain('First I considered');
  });

  it('opens the full trace on click and folds back to four lines on the next', () => {
    const container = renderThinking();
    const toggle = container.querySelector<HTMLButtonElement>('.thinking-toggle');
    click(toggle);
    expect(container.querySelector('.thinking')?.classList.contains('open')).toBe(true);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    click(toggle);
    expect(container.querySelector('.thinking')?.classList.contains('open')).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a live spinner in the toggle while the answer streams', () => {
    const container = renderThinking({ status: 'streaming', content: '' }, true);
    expect(container.querySelector('.thinking .spin')).not.toBeNull();
    expect(container.querySelector('.thinking-toggle')?.textContent).toContain('생각 중');
  });

  it('renders nothing when the model did not think', () => {
    const container = renderThinking({ thinking: undefined });
    expect(container.querySelector('.thinking')).toBeNull();
  });
});

describe('ChatList streaming motion', () => {
  it('animates dots instead of a frozen ellipsis before the first token', () => {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: '', status: 'streaming' })]}
        streaming
        onCopy={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    // The ring and the dots are the whole signal now. The words that used to
    // sit beside them were a second copy of the same status, and the bubble
    // already carries the motion, so nothing repeats it.
    expect(container.querySelector('.bubble .spin')).not.toBeNull();
    expect(container.querySelector('.bubble .typing-dots')).not.toBeNull();
    expect(container.querySelector('.typing-label')).toBeNull();
    expect(container.textContent).not.toContain('답변 작성 중');
  });

  it('keeps one set of motion when the bubble is still empty', () => {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: '', status: 'streaming' })]}
        streaming
        onCopy={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    // The status line would be the same ring and the same dots again, so it is
    // suppressed while the bubble is empty.
    expect(container.querySelector('.status-note')).toBeNull();
    expect(container.querySelectorAll('.spin')).toHaveLength(1);
    expect(container.querySelectorAll('.typing-dots')).toHaveLength(1);
  });

  it('moves the ring and the dots into the status line once the bubble has text', () => {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: 'half an', status: 'streaming' })]}
        streaming
        onCopy={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    // The bubble cannot hold the motion once a partial answer is in it, so it
    // moves rather than appearing twice.
    expect(container.querySelector('.bubble .spin')).toBeNull();
    expect(container.querySelectorAll('.status-live .spin')).toHaveLength(1);
    expect(container.querySelectorAll('.status-live .typing-dots')).toHaveLength(1);
    expect(container.querySelectorAll('.spin')).toHaveLength(1);
    expect(container.querySelectorAll('.typing-dots')).toHaveLength(1);
  });

  it('keeps a blinking caret at the end of a partial answer', () => {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: 'half an', status: 'streaming' })]}
        streaming
        onCopy={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(container.querySelector('.bubble .typing-caret')).not.toBeNull();
  });

  it('shows no motion once the answer is done', () => {
    const container = mount(
      <ChatList
        messages={[message({ id: 'a1', role: 'assistant', content: 'Done', status: 'completed' })]}
        streaming={false}
        onCopy={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(container.querySelector('.typing-dots')).toBeNull();
    expect(container.querySelector('.typing-caret')).toBeNull();
    expect(container.querySelector('.spin')).toBeNull();
  });
});

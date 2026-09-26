import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import type { ChatMessage, InspectorSession } from '../state/models.ts';
import type { PreviewTransaction } from '../preview/transaction.ts';
import { ProposalPanel } from './ProposalPanel.tsx';

type Change = PreviewTransaction['changes'][number];

function change(declarations: Record<string, string>, testId = 'cta'): Change {
  return {
    target: 1,
    anchor: {
      elementKey: `html:testid:${testId}`,
      routeKey: '/',
      mode: 'html',
      tagName: 'button',
      id: '',
      testId,
      path: '',
    },
    declarations,
  };
}

function transaction(overrides: Partial<PreviewTransaction> = {}): PreviewTransaction {
  return {
    id: 'tx-1',
    assistantId: 'a-1',
    userMessageId: 'u-1',
    sessionId: 's-1',
    targetUrl: 'http://target.test',
    routeKey: '/',
    changes: [change({ padding: '12px' })],
    enabled: true,
    status: 'applied',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a-1',
    role: 'assistant',
    content: '답변',
    citations: [
      {
        selectionId: 'sel-1',
        elementKey: 'html:testid:cta',
        component: 'PrimaryButton',
        file: null,
        line: null,
        mode: 'html',
        displayNumber: 1,
        styleFacts: { props: { padding: '4px' } },
      },
    ],
    status: 'completed',
    createdAt: 1,
    previewTransactionId: 'tx-1',
    ...overrides,
  };
}

function session(overrides: Partial<InspectorSession> = {}): InspectorSession {
  return {
    id: 's-1',
    title: 't',
    targetUrl: 'http://target.test',
    model: 'm',
    messages: [
      { id: 'u-1', role: 'user', content: '더 크게', citations: [], createdAt: 0 },
      { ...assistant(), decision: 'accepted' },
    ],
    previewTransactions: [transaction()],
    persistedActiveSelectionIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

let mounted: Array<{ root: Root; container: HTMLElement }> = [];
// Spelled out rather than ReturnType<typeof vi.fn>: vitest 4 types a bare
// vi.fn() as Mock<Procedure | Constructable>, which is not callable as a spy.
interface Hooks {
  copy: Mock<(text: string) => void>;
  close: Mock<() => void>;
}
let hooks: Hooks | null = null;

function Panel(props: { open: boolean; session: InspectorSession | null }) {
  return (
    <ProposalPanel
      open={props.open}
      session={props.session}
      onClose={() => hooks?.close()}
      onCopy={(text) => hooks?.copy(text)}
    />
  );
}

function mount(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(node));
  return container;
}

beforeEach(() => {
  hooks = { copy: vi.fn(), close: vi.fn() };
});

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ProposalPanel', () => {
  it('renders nothing while closed', () => {
    const container = mount(<Panel open={false} session={session()} />);
    expect(container.querySelector('.proposal-panel')).toBeNull();
  });

  it('accumulates accepted changes with their measured before value', () => {
    const container = mount(<Panel open session={session()} />);
    expect(container.querySelector('.proposal-group h3')?.textContent).toBe('PrimaryButton');
    const row = container.querySelector('.proposal-group li');
    expect(row?.querySelector('code')?.textContent).toBe('padding');
    expect(row?.querySelector('.proposal-before')?.textContent).toBe('4px');
    expect(row?.querySelector('.proposal-after')?.textContent).toBe('12px');
    expect(container.querySelector('.proposal-panel-sub')?.textContent).toContain('1개 컴포넌트 · 1건 승인');
  });

  it('counts proposals still waiting on a decision', () => {
    const s = session({
      messages: [
        { id: 'u-1', role: 'user', content: '더 크게', citations: [], createdAt: 0 },
        assistant(),
      ],
    });
    const container = mount(<Panel open session={s} />);
    expect(container.querySelector('.proposal-panel-sub')?.textContent).toContain('1건 대기 중');
  });

  it('says an unmeasured before value is unknown instead of showing a value', () => {
    const s = session({
      messages: [
        { id: 'u-1', role: 'user', content: '더 크게', citations: [], createdAt: 0 },
        {
          ...assistant({ decision: 'accepted' }),
          citations: [{ ...assistant().citations[0]!, styleFacts: undefined }],
        },
      ],
    });
    const container = mount(<Panel open session={s} />);
    expect(container.querySelector('.proposal-before')?.textContent).toBe('측정 없음');
  });

  it('shows the empty state and disables both copies with nothing accepted', () => {
    const container = mount(<Panel open session={null} />);
    expect(container.querySelector('.proposal-empty')).not.toBeNull();
    for (const button of container.querySelectorAll<HTMLButtonElement>('.proposal-panel-foot button')) {
      expect(button.disabled).toBe(true);
    }
  });

  it('copies the plain-text log on one button and the document on the other', () => {
    const container = mount(<Panel open session={session()} />);
    const [logButton, documentButton] = [
      ...container.querySelectorAll<HTMLButtonElement>('.proposal-panel-foot button'),
    ];
    act(() => logButton?.click());
    const log = String(hooks?.copy.mock.calls[0]?.[0] ?? '');
    expect(log).toContain('PrimaryButton');
    expect(log).toContain('padding: 4px → 12px');
    expect(log).not.toContain('|');

    act(() => documentButton?.click());
    const doc = String(hooks?.copy.mock.calls[1]?.[0] ?? '');
    expect(doc).toContain('# UI 수정 제안서');
    expect(doc).toContain('| `padding` | `4px` | `12px` |');
  });

  it('closes on demand', () => {
    const container = mount(<Panel open session={session()} />);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close change log"]')?.click());
    expect(hooks?.close).toHaveBeenCalledTimes(1);
  });
});

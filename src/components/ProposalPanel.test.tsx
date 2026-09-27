import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import type { ChatMessage, InspectorSession } from '../state/models.ts';
import type { PreviewTransaction } from '../preview/transaction.ts';
import { clearSourceCache } from '../target/sourceCache.ts';
import { ProposalPanel } from './ProposalPanel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** The same session, from a target that reported where the element lives. */
function citedSession(overrides: Partial<InspectorSession> = {}): InspectorSession {
  return session({
    messages: [
      { id: 'u-1', role: 'user', content: '더 크게', citations: [], createdAt: 0 },
      {
        ...assistant({
          citations: [{ ...assistant().citations[0]!, file: 'src/Button.tsx', line: 10 }],
        }),
        decision: 'accepted',
      },
    ],
    ...overrides,
  });
}

function sourceBody(path: string, startLine: number, lines: string[]): Response {
  return new Response(JSON.stringify({ path, startLine, totalLines: 200, lines }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A stand-in for the supervisor's source route, keyed off its own query.
 *
 * The body follows the request rather than being a fixed fixture, so a panel
 * that asked about the wrong file would be caught here rather than pass on a
 * snippet that happened to match.
 */
function sourceRoute(): Mock<(input: RequestInfo | URL) => Promise<Response>> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const query = new URL(String(input)).searchParams;
    const line = Number(query.get('line') ?? '0');
    return sourceBody(query.get('path') ?? '', Math.max(1, line - 1), [
      `// cited at line ${line}`,
      'export function Button() {',
      '  return <button />;',
      '}',
    ]);
  });
}

/** A refused read, as the supervisor reports one. */
function refused(reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
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

/** Let the source read settle: the citation lands through a promise chain. */
async function settle(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Click a footer button and return what it handed to `onCopy`. 0 is 내역, 1 is 제안서. */
function copyFrom(container: HTMLElement, which: 0 | 1): string {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.proposal-panel-foot button')];
  act(() => buttons[which]?.click());
  return String(hooks?.copy.mock.calls.at(-1)?.[0] ?? '');
}

/** Open the panel on a session, let the source read land, and copy its document. */
async function documentCopy(sess: InspectorSession | null): Promise<string> {
  const container = mount(<Panel open session={sess} />);
  await settle();
  return copyFrom(container, 1);
}

beforeEach(() => {
  hooks = { copy: vi.fn(), close: vi.fn() };
});

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  document.body.innerHTML = '';
  // The source cache is module state: an entry one test fetched must not
  // answer the next test's read, or the fetch counts below would be lies.
  clearSourceCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it('does not tell the reader that the next message rolls a pending proposal back', () => {
    // The next request is no longer a verdict: an undecided proposal stays
    // undecided and keeps its change on the page, so the panel has to say that
    // rather than the opposite.
    const container = mount(<Panel open session={null} />);
    const empty = container.querySelector('.proposal-empty')?.textContent ?? '';
    expect(empty).not.toContain('되돌려');
    expect(empty).toContain('그대로 남아 있습니다');
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

/**
 * The source the document cites.
 *
 * This panel does not display the source; it fetches it so the document it
 * hands over can say where to edit. So the rules below are about the fetch
 * happening only when there is something to fetch, and about the panel's own
 * copy — the change log — staying exactly what it was.
 */
describe('ProposalPanel source for the document', () => {
  it('reads the cited file and puts its location in the copied document', async () => {
    const fetchMock = sourceRoute();
    vi.stubGlobal('fetch', fetchMock);
    const container = mount(<Panel open session={citedSession()} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const asked = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(asked).toContain('/api/target/source?');
    expect(asked).toContain('path=src%2FButton.tsx');
    const doc = copyFrom(container, 1);
    // The window starts one line above the cited line, and the document says
    // so rather than pointing at the cited line itself.
    expect(doc).toContain('**참고 위치** `src/Button.tsx:9`');
    expect(doc).toContain('export function Button() {');
  });

  it('asks for no source at all when no change carries a file', async () => {
    // A target that sets no `data-inspector-file` has no source to read, and a
    // request per change for nothing would be a request loop.
    const fetchMock = sourceRoute();
    vi.stubGlobal('fetch', fetchMock);
    const container = mount(<Panel open session={session()} />);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('.proposal-group h3')?.textContent).toBe('PrimaryButton');
    expect(copyFrom(container, 1)).not.toContain(' 참고 위치');
  });

  it('copies the change log without any of the source text', async () => {
    // The log is the panel's own artifact: a paste into a chat or a ticket
    // wants the measured values, not forty lines of somebody's source.
    vi.stubGlobal('fetch', sourceRoute());
    const container = mount(<Panel open session={citedSession()} />);
    await settle();
    const log = copyFrom(container, 0);
    expect(log).toBe(
      ['변경 내역', '', 'PrimaryButton', '  padding: 4px → 12px', ''].join('\n'),
    );
    expect(log).not.toContain('```');
    expect(log).not.toContain('참고 위치');
  });

  it('leaves the document as it was when the file cannot be read', async () => {
    // A refusal is not an error to show: the document is an artifact to hand
    // over, and a section that says "unreadable" would read as a finding.
    vi.stubGlobal('fetch', vi.fn(async () => refused('outside-root')));
    const afterRefusal = await documentCopy(citedSession());
    // The same session, from a target that reports no location at all, is the
    // reference: a file that could not be read must look like a file that was
    // never asked about.
    vi.stubGlobal('fetch', sourceRoute());
    const withoutMetadata = await documentCopy(session());
    expect(afterRefusal).toBe(withoutMetadata);
    expect(afterRefusal).not.toContain(' 참고 위치');
    expect(afterRefusal).not.toContain('```');
    expect(afterRefusal).toContain('| `padding` | `4px` | `12px` |');
  });

  it('leaves the document as it was when the supervisor is not there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no supervisor');
      }),
    );
    const doc = await documentCopy(citedSession());
    expect(doc).not.toContain(' 참고 위치');
    expect(doc).toContain('# UI 수정 제안서');
  });
});

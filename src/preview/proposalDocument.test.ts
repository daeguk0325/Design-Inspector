import { describe, expect, it } from 'vitest';
import type { ChatMessage, InspectorSession } from '../state/models.ts';
import type { PreviewTransaction } from './transaction.ts';
import { PROPOSAL_DOCUMENT_TITLE, buildProposalDocument } from './proposalDocument.ts';

type Change = PreviewTransaction['changes'][number];

function change(declarations: Record<string, string>, testId = 'card'): Change {
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
    content: 'prose the implementer must never receive instead of values',
    citations: [
      {
        selectionId: 'sel-1',
        elementKey: 'html:testid:card',
        component: 'PrimaryButton',
        file: 'src/Button.tsx',
        line: 10,
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
    title: 'test',
    targetUrl: 'http://target.test',
    model: 'm',
    messages: [
      { id: 'u-1', role: 'user', content: '버튼을 더 크게', citations: [], createdAt: 0 },
      { ...assistant(), decision: 'accepted' },
    ],
    previewTransactions: [transaction()],
    persistedActiveSelectionIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('proposal document', () => {
  it('states the request and every accepted change with its measured before value', () => {
    const doc = buildProposalDocument(session());
    expect(doc.title).toBe(PROPOSAL_DOCUMENT_TITLE);
    expect(doc.markdown).toContain('# UI 수정 제안서');
    expect(doc.markdown).toContain('버튼을 더 크게');
    expect(doc.markdown).toContain('### PrimaryButton');
    expect(doc.markdown).toContain('| `padding` | `4px` | `12px` |');
    expect(doc.componentCount).toBe(1);
    expect(doc.changeCount).toBe(1);
  });

  it('says a before value is unknown instead of inventing a default', () => {
    const s = session({
      messages: [
        { id: 'u-1', role: 'user', content: 'r', citations: [], createdAt: 0 },
        {
          ...assistant({ decision: 'accepted' }),
          citations: [{ ...assistant().citations[0]!, styleFacts: undefined }],
        },
      ],
    });
    expect(buildProposalDocument(s).markdown).toContain('| `padding` | (측정 없음) | `12px` |');
  });

  it('lists a rejected direction so the implementer does not re-propose it', () => {
    const s = session({
      messages: [
        { id: 'u-1', role: 'user', content: 'r', citations: [], createdAt: 0 },
        { ...assistant(), decision: 'rejected' },
      ],
    });
    const doc = buildProposalDocument(s);
    expect(doc.markdown).toContain('## 반영하지 않은 방향');
    expect(doc.markdown).toContain('card: padding 12px');
    expect(doc.rejectedCount).toBe(1);
    expect(doc.changeCount).toBe(0);
  });

  it('never carries the assistant prose into the document', () => {
    const noisy = 'background-color: #fff; '.repeat(200);
    const doc = buildProposalDocument(
      session({
        messages: [
          { id: 'u-1', role: 'user', content: 'r', citations: [], createdAt: 0 },
          { ...assistant({ content: noisy, decision: 'accepted' }) },
        ],
      }),
    );
    expect(doc.markdown).not.toContain('background-color');
    expect(doc.markdown).not.toContain('#fff');
  });

  it('groups several components and keeps both in one document', () => {
    const s = session({
      messages: [
        { id: 'u-1', role: 'user', content: 'r', citations: [], createdAt: 0 },
        { ...assistant({ decision: 'accepted' }) },
        {
          ...assistant({
            id: 'a-2',
            previewTransactionId: 'tx-2',
            decision: 'accepted',
            citations: [
              {
                ...assistant().citations[0]!,
                selectionId: 'sel-2',
                elementKey: 'html:testid:nav',
                component: 'NavBar',
                displayNumber: 1,
                styleFacts: { props: { gap: '4px' } },
              },
            ],
          }),
        },
      ],
      previewTransactions: [
        transaction(),
        transaction({ id: 'tx-2', assistantId: 'a-2', changes: [change({ gap: '16px' }, 'nav')] }),
      ],
    });
    const doc = buildProposalDocument(s);
    expect(doc.componentCount).toBe(2);
    expect(doc.changeCount).toBe(2);
    expect(doc.markdown).toContain('### PrimaryButton');
    expect(doc.markdown).toContain('### NavBar');
    expect(doc.markdown).toContain('| `gap` | `4px` | `16px` |');
  });

  it('adds the checks the changes actually imply', () => {
    const spacing = buildProposalDocument(
      session({
        messages: [
          { id: 'u-1', role: 'user', content: 'r', citations: [], createdAt: 0 },
          { ...assistant({ decision: 'accepted' }) },
        ],
        previewTransactions: [transaction({ changes: [change({ padding: '12px', gap: '8px' })] })],
      }),
    );
    expect(spacing.markdown).toContain('간격 변경 시');

    const colour = buildProposalDocument(
      session({
        messages: [
          { id: 'u-1', role: 'user', content: 'r', citations: [], createdAt: 0 },
          {
            ...assistant({ decision: 'accepted' }),
            citations: [
              { ...assistant().citations[0]!, styleFacts: { props: { color: '#000' } } },
            ],
          },
        ],
        previewTransactions: [transaction({ changes: [change({ color: '#fff' })] })],
      }),
    );
    expect(colour.markdown).toContain('명도 대비');
  });

  it('produces a valid document with nothing accepted', () => {
    const s = session({
      messages: [{ id: 'u-1', role: 'user', content: 'r', citations: [], createdAt: 0 }],
      previewTransactions: [],
    });
    const doc = buildProposalDocument(s);
    expect(doc.changeCount).toBe(0);
    expect(doc.markdown).toContain('(승인된 변경 없음)');
    expect(doc.markdown).toContain('## 구현 시 확인 사항');
    expect(doc.markdown.endsWith('\n')).toBe(true);
    expect(doc.markdown).not.toContain('\n\n\n');
  });

  it('produces a valid document for a missing session', () => {
    const doc = buildProposalDocument(null);
    expect(doc.changeCount).toBe(0);
    expect(doc.markdown).toContain('(원본 요청 없음)');
    expect(doc.markdown).toContain('(승인된 변경 없음)');
  });

  it('is deterministic for the same session', () => {
    const s = session();
    expect(buildProposalDocument(s).markdown).toBe(buildProposalDocument(s).markdown);
  });
});

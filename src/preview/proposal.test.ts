import { describe, expect, it } from 'vitest';
import type { ChatMessage, InspectorSession } from '../state/models.ts';
import type { PreviewAnchor, PreviewTransaction } from './transaction.ts';
import {
  buildChangeLog,
  changeLogGroupsForSession,
  decisionContextLines,
  groupChangeLog,
  pendingForSession,
  proposalFor,
  proposalState,
  proposalsIn,
  proposalSummaryLines,
} from './proposal.ts';

function anchor(overrides: Partial<PreviewAnchor> = {}): PreviewAnchor {
  return {
    elementKey: 'html:testid:card',
    routeKey: '/',
    mode: 'html',
    tagName: 'button',
    id: '',
    testId: 'card',
    path: '',
    ...overrides,
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
    changes: [{ target: 1, anchor: anchor(), declarations: { padding: '12px' } }],
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
    content: 'answer text',
    citations: [
      {
        selectionId: 'sel-1',
        elementKey: 'html:testid:card',
        component: 'PrimaryButton',
        file: 'src/Button.tsx',
        line: 10,
        mode: 'html',
        displayNumber: 1,
        styleFacts: { props: { padding: '4px', 'border-radius': '4px' } },
      },
    ],
    status: 'completed',
    createdAt: 1,
    previewTransactionId: 'tx-1',
    ...overrides,
  };
}

function user(content = 'make it bigger'): ChatMessage {
  return { id: 'u-1', role: 'user', content, citations: [], createdAt: 0 };
}

function session(overrides: Partial<InspectorSession> = {}): InspectorSession {
  return {
    id: 's-1',
    title: 'test',
    targetUrl: 'http://target.test',
    model: 'm',
    messages: [user(), assistant()],
    previewTransactions: [transaction()],
    persistedActiveSelectionIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('proposal state', () => {
  it('treats an applied but undecided proposal as pending', () => {
    expect(proposalState(assistant())).toBe('pending');
    expect(proposalState(assistant({ decision: 'accepted' }))).toBe('accepted');
    expect(proposalState(assistant({ decision: 'rejected' }))).toBe('rejected');
    expect(proposalState(user())).toBe('rejected');
  });

  it('only proposes for assistant messages that carry a live transaction', () => {
    expect(proposalFor(assistant(), [transaction()])?.state).toBe('pending');
    expect(proposalFor(assistant(), [])).toBeNull();
    expect(proposalFor(assistant({ previewTransactionId: undefined }), [transaction()])).toBeNull();
    expect(proposalFor(user(), [transaction()])).toBeNull();
  });

  it('lists the pending proposals separately from the settled ones', () => {
    const settled = { messages: [user(), assistant({ decision: 'accepted' })], previewTransactions: [transaction()] };
    expect(pendingForSession(session()).map((p) => p.messageId)).toEqual(['a-1']);
    expect(pendingForSession(session(settled))).toEqual([]);
    expect(pendingForSession(null)).toEqual([]);
  });

  it('keeps session order so the log reads in the order the work happened', () => {
    const s = session({
      messages: [
        user(),
        assistant(),
        assistant({
          id: 'a-2',
          decision: 'accepted',
          previewTransactionId: 'tx-2',
          createdAt: 5,
        }),
      ],
      previewTransactions: [transaction(), transaction({ id: 'tx-2', assistantId: 'a-2' })],
    });
    expect(proposalsIn(s.messages, s.previewTransactions).map((p) => p.transactionId)).toEqual([
      'tx-1',
      'tx-2',
    ]);
  });
});

describe('decision context lines', () => {
  it('describes the change, not the answer text', () => {
    const lines = decisionContextLines(session().messages, session().previewTransactions);
    // pending is skipped entirely: it is not a decision yet.
    expect(lines).toEqual([]);
  });

  it('marks an accepted change with the component and the declaration', () => {
    const s = session();
    const lines = decisionContextLines(
      [...s.messages.slice(0, 1), { ...s.messages[1]!, decision: 'accepted' as const }],
      s.previewTransactions,
    );
    expect(lines).toEqual(['- [accept] PrimaryButton: padding 12px']);
  });

  it('marks a rejected change and says it was reverted', () => {
    const s = session();
    const lines = decisionContextLines(
      [...s.messages.slice(0, 1), { ...s.messages[1]!, decision: 'rejected' as const }],
      s.previewTransactions,
    );
    expect(lines).toEqual(['- [reject] PrimaryButton: padding 12px — reverted']);
  });

  it('never carries the answer text, even a long one', () => {
    const s = session();
    const noisy = 'background-color: #fff; '.repeat(200);
    const lines = decisionContextLines(
      [{ ...s.messages[1]!, content: noisy, decision: 'accepted' as const }],
      s.previewTransactions,
    );
    expect(lines.join('\n')).not.toContain('background-color');
    expect(lines.join('\n')).not.toContain('#fff');
  });

  it('falls back to the test id, then the id, then the tag when no component is known', () => {
    const s = session();
    const noComponent = {
      ...s.messages[1]!,
      decision: 'accepted' as const,
      citations: [{ ...s.messages[1]!.citations[0]!, component: null }],
    };
    expect(decisionContextLines([noComponent], s.previewTransactions)).toEqual([
      '- [accept] card: padding 12px',
    ]);
    const byId = transaction({
      changes: [
        {
          target: 1,
          anchor: anchor({ testId: '', id: 'save' }),
          declarations: { gap: '8px' },
        },
      ],
    });
    expect(
      decisionContextLines(
        [{ ...noComponent, previewTransactionId: 'tx-1' }],
        [byId],
      ),
    ).toEqual(['- [accept] #save: gap 8px']);
  });

  it('emits one line per change so a wide proposal stays readable', () => {
    const wide = transaction({
      changes: [
        { target: 1, anchor: anchor(), declarations: { padding: '12px' } },
        { target: 1, anchor: anchor(), declarations: { gap: '8px' } },
      ],
    });
    const s = session({
      messages: [user(), { ...assistant(), decision: 'accepted' }],
      previewTransactions: [wide],
    });
    expect(decisionContextLines(s.messages, s.previewTransactions)).toEqual([
      '- [accept] PrimaryButton: padding 12px',
      '- [accept] PrimaryButton: gap 8px',
    ]);
  });

  it('bounds how much the log can inject', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      transaction({
        id: `tx-${i}`,
        assistantId: `a-${i}`,
        changes: [
          {
            target: 1,
            anchor: anchor(),
            declarations: { [`--pad-${i}`]: '1px' } as Record<string, string>,
          },
        ],
      }),
    );
    const messages = many.map((t) => ({
      ...assistant({ id: t.assistantId, previewTransactionId: t.id, decision: 'accepted' as const }),
    }));
    const lines = decisionContextLines(messages, many);
    expect(lines.length).toBeLessThanOrEqual(24);
  });
});

describe('change log', () => {
  it('carries the measured value each change replaced', () => {
    const s = session({ messages: [user(), { ...assistant(), decision: 'accepted' }] });
    expect(buildChangeLog(s.messages, s.previewTransactions)).toEqual([
      {
        messageId: 'a-1',
        transactionId: 'tx-1',
        order: 1,
          component: 'PrimaryButton',
          elementKey: 'html:testid:card',
          file: 'src/Button.tsx',
          line: 10,
          property: 'padding',
          before: '4px',
          after: '12px',
        },
      ]);
    });

    it('carries the source location the target reported, so the document can say where to edit', () => {
      const cited = {
        ...assistant().citations[0]!,
        file: 'src/components/Button.tsx',
        line: 42,
      };
      const s = session({
        messages: [
          user(),
          { ...assistant({ decision: 'accepted' }), citations: [cited] },
        ],
      });
      const [entry] = buildChangeLog(s.messages, s.previewTransactions);
      expect(entry).toMatchObject({ file: 'src/components/Button.tsx', line: 42 });
      const [group] = groupChangeLog(s.messages, s.previewTransactions);
      expect(group).toMatchObject({ file: 'src/components/Button.tsx', line: 42 });
    });

    it('leaves the location null when the target reported none', () => {
      const bare = {
        ...assistant().citations[0]!,
        file: null,
        line: null,
      };
      const s = session({
        messages: [{ ...assistant({ decision: 'accepted' }), citations: [bare] }],
      });
      const [group] = groupChangeLog(s.messages, s.previewTransactions);
      expect(group?.file).toBeNull();
      expect(group?.line).toBeNull();
    });

  it('leaves an unmeasured before value null rather than guessing', () => {
    const s = session({
      messages: [
        user(),
        {
          ...assistant({ decision: 'accepted' }),
          citations: [
            {
              ...assistant().citations[0]!,
              styleFacts: { props: { 'border-radius': '4px' } },
            },
          ],
        },
      ],
      previewTransactions: [
        transaction({
          changes: [
            {
              target: 1,
              anchor: anchor(),
              declarations: { padding: '12px' },
            },
          ],
        }),
      ],
    });
    expect(buildChangeLog(s.messages, s.previewTransactions)[0]?.before).toBeNull();
  });

  it('excludes rejected and still-pending proposals', () => {
    const rejected = session({ messages: [user(), { ...assistant(), decision: 'rejected' }] });
    const pending = session();
    expect(buildChangeLog(rejected.messages, rejected.previewTransactions)).toEqual([]);
    expect(buildChangeLog(pending.messages, pending.previewTransactions)).toEqual([]);
  });

  it('folds the log per component in first-seen order', () => {
    const s = session({
      messages: [user(), { ...assistant(), decision: 'accepted' }],
      previewTransactions: [
        transaction({
          changes: [
            { target: 1, anchor: anchor(), declarations: { padding: '12px' } },
            { target: 1, anchor: anchor(), declarations: { gap: '8px' } },
          ],
        }),
      ],
    });
    const groups = groupChangeLog(s.messages, s.previewTransactions);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.component).toBe('PrimaryButton');
    expect(groups[0]?.entries.map((e) => e.property)).toEqual(['padding', 'gap']);
  });

  it('summarises a proposal the same way the prompt does', () => {
    const s = session();
    const proposal = proposalFor({ ...assistant(), decision: 'accepted' }, s.previewTransactions);
    expect(proposal).not.toBeNull();
    expect(proposalSummaryLines(proposal!)).toEqual(['PrimaryButton: padding 12px']);
  });

  it('returns nothing for a missing session', () => {
    expect(buildChangeLog([], [])).toEqual([]);
    expect(changeLogGroupsForSession(null)).toEqual([]);
  });
});

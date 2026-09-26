import { describe, expect, it } from 'vitest';
import type { ChatMessage, InspectorSession } from '../state/models.ts';
import type { SourceSnippet } from '../target/source.ts';
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

/**
 * The cited source, quoted where the change is.
 *
 * The document is handed to whoever implements the change, so the numbers in
 * it have to be actionable: "set the padding to 16px" leaves the reader
 * hunting, while the same sentence next to the file and the lines turns it
 * into an edit. Everything below is about that citation being honest — it
 * only appears where a file was actually read, and it never rewrites the
 * measured table the document already carried.
 */
describe('proposal document source citation', () => {
  // The default session's citation is `src/Button.tsx:10`, and that pair is the
  // key: the cited line asked the question, the window is the answer.
  const KEY = 'src/Button.tsx:10';

  /** One fetched window, keyed the way `sourceSnippets` keys its result. */
  function cited(
    lines: string[],
    overrides: Partial<SourceSnippet> = {},
  ): Map<string, SourceSnippet> {
    const startLine = overrides.startLine ?? 3;
    return new Map([
      [
        KEY,
        {
          path: 'src/Button.tsx',
          startLine,
          endLine: startLine + lines.length - 1,
          totalLines: 200,
          lines,
          ...overrides,
        },
      ],
    ]);
  }

  /** The table rows, so "the snippet is additive" can be asserted directly. */
  function tableRows(markdown: string): string[] {
    return markdown.split('\n').filter((line) => line.startsWith('|'));
  }

  /** Every line that begins with a fence, which is how a quoted one shows up. */
  function fenceLines(markdown: string): string[] {
    return markdown.split('\n').filter((line) => line.trimStart().startsWith('```'));
  }

  /** The lines between the opener and the closer, verbatim and in order. */
  function quotedLines(markdown: string): string[] {
    const afterOpener = markdown.split('```tsx\n')[1] ?? '';
    return afterOpener.slice(0, afterOpener.lastIndexOf('\n```')).split('\n');
  }

  // Joined explicitly rather than written as a template literal: this file is
  // checked out with CRLF on some machines, and a literal would then carry \r
  // into a document that is defined to end every line with a bare \n.
  const WITHOUT_SNIPPETS = [
    '# UI 수정 제안서',
    '',
    '## 목적',
    '버튼을 더 크게',
    '',
    '## 변경 내역',
    '아래 값은 검수 시점에 실제로 측정된 값이며, 미리보기에서 실제 적용된 값입니다.',
    '',
    '### PrimaryButton',
    '',
    '| 속성 | 변경 전 (측정값) | 변경 후 |',
    '| --- | --- | --- |',
    '| `padding` | `4px` | `12px` |',
    '',
    '## 구현 시 확인 사항',
    '- 간격 변경 시 조밀한 레이아웃과 긴 텍스트 입력 사례를 함께 확인하세요.',
    '',
  ].join('\n');

  it('is the same document as before when no source was fetched', () => {
    // The feature is additive on purpose: a document that gained a citation
    // would have to be re-read by anyone who already knows this format.
    const doc = buildProposalDocument(session());
    expect(doc.markdown).toBe(WITHOUT_SNIPPETS);
    expect(doc.markdown).not.toContain(' 참고 위치');
    expect(doc.markdown).not.toContain('```tsx');
  });

  it('is the same document for an empty map as for no map at all', () => {
    expect(buildProposalDocument(session(), new Map()).markdown).toBe(WITHOUT_SNIPPETS);
  });

  it('quotes the cited lines under the component they belong to', () => {
    const doc = buildProposalDocument(
      session(),
      cited(['export function Button() {', '  return <button />;', '}']),
    );
    expect(doc.markdown).toContain('### PrimaryButton');
    // The heading states where the edit goes, using the window's own first line
    // rather than the cited one: line 10 is inside the block that starts at 3.
    expect(doc.markdown).toContain('**참고 위치** `src/Button.tsx:3`');
    // The lines are quoted verbatim and in order: an implementer reading them
    // has to find the same text they would see in the file.
    expect(quotedLines(doc.markdown)).toEqual([
      'export function Button() {',
      '  return <button />;',
      '}',
    ]);
    // The citation hangs off the component section, after its table.
    expect(doc.markdown.indexOf('| `padding` | `4px` | `12px` |')).toBeLessThan(
      doc.markdown.indexOf('**참고 위치**'),
    );
  });

  it('attaches a snippet only to the key it was fetched for', () => {
    // A window around a different line is a different place in the file, and
    // attaching it to this component would point the reader at the wrong code.
    const elsewhere: SourceSnippet = {
      path: 'src/Button.tsx',
      startLine: 11,
      endLine: 11,
      totalLines: 200,
      lines: ['const other = 1;'],
    };
    const doc = buildProposalDocument(session(), new Map([['src/Button.tsx:11', elsewhere]]));
    expect(doc.markdown).toBe(WITHOUT_SNIPPETS);
  });

  it('attaches nothing when the target reported no file', () => {
    // The bridge never invents a location, so the document has nothing to cite
    // — and nothing may be borrowed from a neighbouring component.
    const s = session({
      messages: [
        { id: 'u-1', role: 'user', content: '버튼을 더 크게', citations: [], createdAt: 0 },
        {
          ...assistant({ decision: 'accepted' }),
          citations: [{ ...assistant().citations[0]!, file: null, line: null }],
        },
      ],
    });
    const doc = buildProposalDocument(
      s,
      cited(['export function Button() {', '}', 'export const other = 1;'], { startLine: 10 }),
    );
    expect(doc.markdown).toBe(WITHOUT_SNIPPETS);
  });

  it('quotes at most the first forty lines of a long file window', () => {
    // A snippet is context for one change, not the file: past this it is a
    // dump, and the document is meant to be read.
    const long = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
    const doc = buildProposalDocument(session(), cited(long));
    const quoted = quotedLines(doc.markdown);
    expect(quoted).toHaveLength(40);
    expect(quoted[0]).toBe('line 1');
    expect(quoted[39]).toBe('line 40');
    expect(doc.markdown).not.toContain('line 41');
  });

  it('grows the fence so a quoted line cannot close the block', () => {
    // A markdown file legitimately contains a fence, and a bare ``` inside a
    // ``` block is a valid CommonMark closer — so a fixed three-backtick fence
    // would end the quote early and render the rest of it as prose. The fence is
    // therefore sized to one more than the longest backtick run in the quote.
    const fenced = ['const README = `', '```', 'const a = 1;', '````', '`;'];
    const doc = buildProposalDocument(session(), cited(fenced));
    const fences = fenceLines(doc.markdown);
    // Longest run in the quote is 4, so the document brackets it with 5.
    expect(fences[0]).toBe('`````tsx');
    expect(fences.at(-1)).toBe('`````');
    // Every quoted line is present, in order, between them.
    const opener = doc.markdown.indexOf('`````tsx\n');
    const closer = doc.markdown.indexOf('\n`````\n', opener);
    const quoted = doc.markdown.slice(opener + '`````tsx\n'.length, closer).split('\n');
    expect(quoted).toEqual(fenced);
  });

  it('uses a plain three-backtick fence when the quote has no fence in it', () => {
    const plain = ['const a = 1;', 'const b = 2;'];
    const doc = buildProposalDocument(session(), cited(plain));
    expect(doc.markdown).toContain('```tsx');
    expect(fenceLines(doc.markdown)[0]).toBe('```tsx');
  });

  it('leaves the change table exactly as it was', () => {
    const quoted = buildProposalDocument(session(), cited(['export function Button() {', '}']));
    const bare = buildProposalDocument(session());
    expect(tableRows(quoted.markdown)).toEqual(tableRows(bare.markdown));
    // Counts are what the panel shows too, so a citation cannot change them.
    expect(quoted.componentCount).toBe(bare.componentCount);
    expect(quoted.changeCount).toBe(bare.changeCount);
  });
});

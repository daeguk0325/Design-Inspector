// Session/message model tests (§§17, 18, 19.6): raw vs transmission, pin order.
import { describe, expect, it } from 'vitest';
import { latestUserRequest } from './models.ts';
import type { ChatMessage, InspectorSession } from './models.ts';
import { buildTransmissionPrompt } from '../ollama/client.ts';
import {
  parsePreviewTransaction,
  sanitizePreviewTransactions,
} from '../preview/transaction.ts';
import type { PreviewAnchor, PreviewTransaction } from '../preview/transaction.ts';

const anchor: PreviewAnchor = {
  elementKey: 'button.save',
  routeKey: '/checkout',
  mode: 'html',
  tagName: 'button',
  id: 'save-btn',
  testId: 'save-button',
  path: 'main>form>button',
};

const validTransaction: PreviewTransaction = {
  id: 'tx-1',
  assistantId: 'msg-a',
  userMessageId: 'msg-u',
  sessionId: 'sess-1',
  targetUrl: 'http://localhost:3000/checkout',
  routeKey: '/checkout',
  changes: [
    {
      target: 3,
      anchor,
      declarations: { color: 'rgb(20, 20, 20)', 'font-size': '16px' },
    },
  ],
  enabled: true,
  status: 'applied',
  createdAt: 1_000,
  updatedAt: 2_000,
};

describe('message model', () => {
  it('latestUserRequest returns raw text (never transmission prefix)', () => {
    const s = {
      id: 's',
      title: 't',
      targetUrl: '',
      model: '',
      messages: [
        { id: 'a', role: 'user' as const, content: '({1}) looks like a citation but is raw user text', citations: [], createdAt: 1 },
      ],
      previewTransactions: [],
      persistedActiveSelectionIds: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(latestUserRequest(s)).toBe('({1}) looks like a citation but is raw user text');
  });

  it('maps a contact sheet and individual images to citation numbers', () => {
    const prompt = buildTransmissionPrompt(
      'make this coherent',
      [{
        selectionId: 'sel-7',
        elementKey: 'button',
        component: 'SaveButton',
        file: 'src/Save.tsx',
        line: 8,
        mode: 'html',
        displayNumber: 7,
      }],
      { endpoint: 'http://localhost:11434', model: 'vision', images: ['sheet', 'crop'], citationNumbers: [null, 7] },
    );
    expect(prompt).toContain('({7}) SaveButton');
    expect(prompt).toContain('Image 1: numbered contact sheet');
    expect(prompt).toContain('Image 2: citation ({7}) individual crop');
    expect(prompt).toContain('untrusted visual data');
  });

  it('transmission prompt embeds citations; persisted raw stays clean', () => {
    const raw = 'make it blue';
    const tx = buildTransmissionPrompt(raw, [
      {
        selectionId: 'sel-1',
        elementKey: 'k',
        component: 'Button',
        file: 'src/B.tsx',
        line: 12,
        mode: 'html',
        displayNumber: 1,
      },
    ]);
    expect(tx).toContain('Button');
    expect(tx).toContain(raw);
    expect(raw).toBe('make it blue');
  });
});

describe('message model extensions', () => {
  it('carries an optional decision and previewTransactionId on a message', () => {
    const message: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'proposed change',
      citations: [],
      status: 'completed',
      createdAt: 5,
      decision: 'accepted',
      previewTransactionId: 'tx-1',
    };
    expect(message.decision).toBe('accepted');
    expect(message.previewTransactionId).toBe('tx-1');
  });

  it('leaves decision and previewTransactionId undefined when not set', () => {
    const message: ChatMessage = {
      id: 'm2',
      role: 'user',
      content: 'plain',
      citations: [],
      createdAt: 5,
    };
    expect(message.decision).toBeUndefined();
    expect(message.previewTransactionId).toBeUndefined();
  });

  it('keeps preview transactions alongside messages on a session', () => {
    const session: InspectorSession = {
      id: 's1',
      title: 'T',
      targetUrl: '',
      model: '',
      messages: [
        {
          id: 'a',
          role: 'user',
          content: 'make it blue',
          citations: [],
          createdAt: 1,
        },
      ],
      previewTransactions: [validTransaction],
      persistedActiveSelectionIds: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(session.previewTransactions ?? []).toHaveLength(1);
    expect(latestUserRequest(session)).toBe('make it blue');
  });
});

describe('preview transaction validators', () => {
  it('accepts a well-formed transaction unchanged', () => {
    expect(parsePreviewTransaction(validTransaction)).toEqual(validTransaction);
  });

  it('sanitizes a valid transaction to an equal value', () => {
    expect(sanitizePreviewTransactions([validTransaction])).toEqual([validTransaction]);
  });

  it('drops invalid transactions individually and keeps valid ones', () => {
    const second: PreviewTransaction = {
      ...validTransaction,
      id: 'tx-2',
      status: 'pending-rebind',
    };
    const result = sanitizePreviewTransactions([
      validTransaction,
      { nope: true },
      second,
      null,
      'garbage',
      [],
    ]);
    expect(result.map((t) => t.id)).toEqual(['tx-1', 'tx-2']);
  });

  it('rejects base64 image payloads on a change', () => {
    const withBase64 = {
      ...validTransaction,
      changes: [{ ...validTransaction.changes[0]!, base64: 'AAAABBBBCCCC' }],
    };
    expect(sanitizePreviewTransactions([withBase64])).toEqual([]);
  });

  it('rejects style-text fields on a transaction', () => {
    expect(
      sanitizePreviewTransactions([{ ...validTransaction, styleText: 'button{color:red}' }]),
    ).toEqual([]);
    expect(sanitizePreviewTransactions([{ ...validTransaction, css: 'color:red' }])).toEqual([]);
  });

  it('rejects anchors that are not html mode or miss identity fields', () => {
    const badMode: PreviewTransaction = {
      ...validTransaction,
      changes: [{ ...validTransaction.changes[0]!, anchor: { ...anchor, mode: '3d' as 'html' } }],
    };
    const missingKey: PreviewTransaction = {
      ...validTransaction,
      changes: [{ ...validTransaction.changes[0]!, anchor: { ...anchor, elementKey: '' } }],
    };
    expect(sanitizePreviewTransactions([badMode])).toEqual([]);
    expect(sanitizePreviewTransactions([missingKey])).toEqual([]);
  });

  it('enforces citation number bounds', () => {
    const zero = { ...validTransaction, changes: [{ ...validTransaction.changes[0]!, target: 0 }] };
    const huge = {
      ...validTransaction,
      changes: [{ ...validTransaction.changes[0]!, target: 10_000 }],
    };
    const fractional = {
      ...validTransaction,
      changes: [{ ...validTransaction.changes[0]!, target: 2.9 }],
    };
    expect(sanitizePreviewTransactions([zero])).toEqual([]);
    expect(sanitizePreviewTransactions([huge])).toEqual([]);
    expect(sanitizePreviewTransactions([fractional])).toEqual([
      { ...validTransaction, changes: [{ ...validTransaction.changes[0]!, target: 2 }] },
    ]);
  });

  it('rejects invalid declarations and oversized strings', () => {
    const badDeclaration: PreviewTransaction = {
      ...validTransaction,
      changes: [
        {
          ...validTransaction.changes[0]!,
          declarations: { color: 'url(data:image/png;base64,x)' },
        },
      ],
    };
    const longElementKey: PreviewTransaction = {
      ...validTransaction,
      changes: [
        {
          ...validTransaction.changes[0]!,
          anchor: { ...anchor, elementKey: 'k'.repeat(5_000) },
        },
      ],
    };
    expect(sanitizePreviewTransactions([badDeclaration])).toEqual([]);
    expect(sanitizePreviewTransactions([longElementKey])).toEqual([]);
  });

  it('rejects unknown runtime statuses and non-boolean enabled flags', () => {
    expect(
      sanitizePreviewTransactions([{ ...validTransaction, status: 'live' as 'applied' }]),
    ).toEqual([]);
    expect(
      sanitizePreviewTransactions([{ ...validTransaction, enabled: 'yes' as unknown as boolean }]),
    ).toEqual([]);
  });

  it('requires transaction identity fields', () => {
    expect(sanitizePreviewTransactions([{ ...validTransaction, id: '' }])).toEqual([]);
    expect(sanitizePreviewTransactions([{ ...validTransaction, assistantId: undefined }])).toEqual([]);
    expect(sanitizePreviewTransactions([{ ...validTransaction, sessionId: 42 }])).toEqual([]);
  });

  it('rejects negative timestamps and keeps a valid errorCode', () => {
    expect(sanitizePreviewTransactions([{ ...validTransaction, createdAt: -1 }])).toEqual([]);
    expect(sanitizePreviewTransactions([{ ...validTransaction, errorCode: 'anchor-missing' }])).toEqual([
      { ...validTransaction, errorCode: 'anchor-missing' },
    ]);
  });

  it('returns an empty array for non-array input', () => {
    expect(sanitizePreviewTransactions(undefined)).toEqual([]);
    expect(sanitizePreviewTransactions('nope')).toEqual([]);
    expect(sanitizePreviewTransactions({})).toEqual([]);
  });
});

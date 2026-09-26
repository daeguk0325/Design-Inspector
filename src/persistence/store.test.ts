// Persistence tests (§§15, 22.4): versioning, v1→v2 migration, corruption recovery, quota.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyShape,
  loadPersisted,
  loadSettings,
  savePersisted,
  saveSettings,
  SCHEMA_VERSION,
  SETTINGS_KEY,
  STORAGE_KEY,
} from './store.ts';
import { DEFAULT_GENERATION } from './store.ts';
import type { PreviewAnchor, PreviewTransaction } from '../preview/transaction.ts';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const anchor: PreviewAnchor = {
  elementKey: 'button.save',
  routeKey: '/checkout',
  mode: 'html',
  tagName: 'button',
  id: 'save-btn',
  testId: 'save-button',
  path: 'main>form>button',
};

const transaction: PreviewTransaction = {
  id: 'tx-1',
  assistantId: 'msg-a',
  userMessageId: 'msg-u',
  sessionId: 's1',
  targetUrl: 'http://localhost:3000/checkout',
  routeKey: '/checkout',
  changes: [
    {
      target: 2,
      anchor,
      declarations: { color: 'red', 'font-size': '16px' },
    },
  ],
  enabled: true,
  status: 'applied',
  createdAt: 1,
  updatedAt: 2,
};

function envelopeV2(data: unknown): string {
  return JSON.stringify({ version: SCHEMA_VERSION, data });
}

describe('persistence', () => {
  it('round-trips sessions and current id at the current schema version', () => {
    const shape = {
      sessions: [
        {
          id: 's1',
          title: 'T',
          targetUrl: 'http://localhost:3000/',
          model: 'm',
          messages: [],
          previewTransactions: [],
          persistedActiveSelectionIds: ['sel-1'],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      currentSessionId: 's1',
    };
    expect(savePersisted(shape)).toBe('ok');
    const loaded = loadPersisted();
    expect(loaded.shape).toEqual(shape);
    expect(loaded.migrated).toBe(false);
    expect(loaded.recoveredFromCorruption).toBe(false);
  });

  it('writes the current schema version into the envelope', () => {
    expect(SCHEMA_VERSION).toBe(2);
    savePersisted({ sessions: [], currentSessionId: null });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { version: number };
    expect(stored.version).toBe(2);
  });

  it('round-trips a valid preview transaction through save and load', () => {
    const shape = {
      sessions: [
        {
          id: 's1',
          title: 'T',
          targetUrl: 'http://localhost:3000/checkout',
          model: 'm',
          messages: [],
          previewTransactions: [transaction],
          persistedActiveSelectionIds: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      currentSessionId: 's1',
    };
    expect(savePersisted(shape)).toBe('ok');
    const loaded = loadPersisted();
    expect(loaded.shape.sessions[0]?.previewTransactions).toEqual([transaction]);
    expect(loaded.migrated).toBe(false);
  });

  it('defaults a stored session without transactions to an empty list', () => {
    localStorage.setItem(
      STORAGE_KEY,
      envelopeV2({
        sessions: [
          { id: 's1', title: 'T', targetUrl: '', model: '', messages: [], createdAt: 0, updatedAt: 0 },
        ],
        currentSessionId: 's1',
      }),
    );
    const loaded = loadPersisted();
    expect(loaded.shape.sessions[0]?.previewTransactions).toEqual([]);
    expect(loaded.migrated).toBe(false);
  });

  it('sanitizes persisted transactions and drops invalid ones individually', () => {
    const second = { ...transaction, id: 'tx-2', status: 'stale-binding' };
    localStorage.setItem(
      STORAGE_KEY,
      envelopeV2({
        sessions: [
          {
            id: 's1',
            title: 'T',
            targetUrl: '',
            model: '',
            messages: [],
            previewTransactions: [transaction, { broken: true }, second],
            persistedActiveSelectionIds: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        currentSessionId: 's1',
      }),
    );
    const loaded = loadPersisted();
    expect(loaded.shape.sessions[0]?.previewTransactions?.map((t) => t.id)).toEqual([
      'tx-1',
      'tx-2',
    ]);
  });

  it('drops persisted transactions carrying base64 or style-text fields', () => {
    const withBase64 = {
      ...transaction,
      id: 'tx-b64',
      changes: [{ ...transaction.changes[0]!, base64: 'AAAABBBB' }],
    };
    const withStyleText = { ...transaction, id: 'tx-style', styleText: 'button{color:red}' };
    localStorage.setItem(
      STORAGE_KEY,
      envelopeV2({
        sessions: [
          {
            id: 's1',
            title: 'T',
            targetUrl: '',
            model: '',
            messages: [],
            previewTransactions: [transaction, withBase64, withStyleText],
            persistedActiveSelectionIds: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        currentSessionId: 's1',
      }),
    );
    const loaded = loadPersisted();
    expect(loaded.shape.sessions[0]?.previewTransactions?.map((t) => t.id)).toEqual(['tx-1']);
  });

  it('preserves message decision and previewTransactionId at the current version', () => {
    localStorage.setItem(
      STORAGE_KEY,
      envelopeV2({
        sessions: [
          {
            id: 's1',
            title: 'T',
            targetUrl: '',
            model: '',
            messages: [
              {
                id: 'm1',
                role: 'assistant',
                content: 'done',
                citations: [],
                pinned: false,
                pinnedAt: null,
                status: 'completed',
                createdAt: 1,
                decision: 'accepted',
                previewTransactionId: 'tx-1',
              },
              {
                id: 'm2',
                role: 'assistant',
                content: 'nope',
                citations: [],
                pinned: false,
                pinnedAt: null,
                status: 'completed',
                createdAt: 2,
                decision: 'bogus',
              },
            ],
            persistedActiveSelectionIds: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        currentSessionId: 's1',
      }),
    );
    const messages = loadPersisted().shape.sessions[0]?.messages ?? [];
    expect(messages[0]?.decision).toBe('accepted');
    expect(messages[0]?.previewTransactionId).toBe('tx-1');
    expect(messages[1]?.decision).toBeUndefined();
  });

  it('recovers deterministically from malformed stored state', () => {
    localStorage.setItem(STORAGE_KEY, '{broken json');
    const loaded = loadPersisted();
    expect(loaded.shape).toEqual(emptyShape());
    expect(loaded.recoveredFromCorruption).toBe(true);
  });

  it('migrates legacy unversioned shapes instead of dropping them', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessions: [{ id: 's', title: 'T', messages: [] }], currentSessionId: 's' }),
    );
    const loaded = loadPersisted();
    expect(loaded.migrated).toBe(true);
    expect(loaded.recoveredFromCorruption).toBe(false);
    expect(loaded.shape.sessions[0]?.id).toBe('s');
    expect(loaded.shape.sessions[0]?.previewTransactions).toEqual([]);
  });

  it('migrates a v1 envelope: empty transactions and interrupted streaming messages', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        data: {
          sessions: [
            {
              id: 's1',
              title: 'T',
              targetUrl: '',
              model: '',
              messages: [
                {
                  id: 'a',
                  role: 'assistant',
                  content: '…',
                  citations: [],
                  pinned: false,
                  status: 'streaming',
                  createdAt: 0,
                },
              ],
              previewTransactions: [{ legacy: true }],
              persistedActiveSelectionIds: [],
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          currentSessionId: 's1',
        },
      }),
    );
    const loaded = loadPersisted();
    expect(loaded.migrated).toBe(true);
    expect(loaded.recoveredFromCorruption).toBe(false);
    expect(loaded.shape.sessions[0]?.messages[0]?.status).toBe('interrupted');
    expect(loaded.shape.sessions[0]?.previewTransactions).toEqual([]);
  });

  it('normalizes malformed messages during migration', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        data: {
          sessions: [
            {
              id: 's1',
              title: 'T',
              messages: [
                {
                  id: 'a',
                  role: 'assistant',
                  content: 123,
                  citations: 'nope',
                  pinned: 'yes',
                  status: 'weird',
                  decision: 'rejected',
                },
              ],
              createdAt: 'x',
              updatedAt: null,
            },
          ],
          currentSessionId: 's1',
        },
      }),
    );
    const session = loadPersisted().shape.sessions[0];
    expect(session?.messages[0]).toEqual({
      id: 'a',
      role: 'assistant',
      content: '',
      citations: [],
      status: 'completed',
      createdAt: 0,
      decision: 'rejected',
    });
    expect(session?.createdAt).toBe(0);
    expect(session?.updatedAt).toBe(0);
  });

  it('drops the removed pin fields instead of resurrecting them', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        data: {
          sessions: [
            {
              id: 's1',
              title: 'T',
              messages: [
                {
                  id: 'a',
                  role: 'user',
                  content: 'hi',
                  citations: [],
                  pinned: true,
                  pinnedAt: 1234,
                  createdAt: 5,
                },
              ],
              previewTransactions: [],
              persistedActiveSelectionIds: [],
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          currentSessionId: 's1',
        },
      }),
    );
    const message = loadPersisted().shape.sessions[0]?.messages[0];
    expect(message).toBeDefined();
    expect(message).not.toHaveProperty('pinned');
    expect(message).not.toHaveProperty('pinnedAt');
    expect(message).toEqual({ id: 'a', role: 'user', content: 'hi', citations: [], createdAt: 5 });
  });

  it('keeps non-streaming v1 assistant statuses during migration', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        data: {
          sessions: [
            {
              id: 's1',
              title: 'T',
              messages: [
                { id: 'a', role: 'assistant', content: 'ok', citations: [], status: 'completed' },
                { id: 'u', role: 'user', content: 'hi', citations: [] },
              ],
            },
          ],
          currentSessionId: 's1',
        },
      }),
    );
    const messages = loadPersisted().shape.sessions[0]?.messages ?? [];
    expect(messages[0]?.status).toBe('completed');
    expect(messages[1]?.status).toBeUndefined();
  });

  it('marks a current-version streaming message interrupted after reload', () => {
    localStorage.setItem(
      STORAGE_KEY,
      envelopeV2({
        sessions: [
          {
            id: 's1',
            title: 'T',
            messages: [
              { id: 'a', role: 'assistant', content: '…', citations: [], status: 'streaming' },
            ],
          },
        ],
        currentSessionId: 's1',
      }),
    );
    const loaded = loadPersisted();
    expect(loaded.migrated).toBe(false);
    expect(loaded.shape.sessions[0]?.messages[0]?.status).toBe('interrupted');
  });

  it('recovers when an old envelope carries unusable data', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, data: { sessions: 'not-an-array' } }),
    );
    const loaded = loadPersisted();
    expect(loaded.shape).toEqual(emptyShape());
    expect(loaded.recoveredFromCorruption).toBe(true);
  });

  it('recovers from a future schema version instead of guessing', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 99, data: { sessions: [{ id: 's', title: 'T' }] } }),
    );
    const loaded = loadPersisted();
    expect(loaded.shape).toEqual(emptyShape());
    expect(loaded.recoveredFromCorruption).toBe(true);
  });

  it('falls back to the first session when currentSessionId is stale', () => {
    localStorage.setItem(
      STORAGE_KEY,
      envelopeV2({
        sessions: [{ id: 's1', title: 'T' }, { id: 's2', title: 'U' }],
        currentSessionId: 'gone',
      }),
    );
    expect(loadPersisted().shape.currentSessionId).toBe('s1');
  });

  it('reports quota-exceeded instead of throwing', () => {
    const err = new DOMException('full', 'QuotaExceededError');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw err;
    });
    expect(savePersisted({ sessions: [], currentSessionId: null })).toBe('quota-exceeded');
  });

  it('marks in-flight assistant messages as interrupted after reload', () => {
    const shape = {
      sessions: [
        {
          id: 's1',
          title: 'T',
          targetUrl: '',
          model: '',
          messages: [
            {
              id: 'a',
              role: 'assistant',
              content: '…',
              citations: [],
              pinned: false,
              status: 'streaming',
              createdAt: 0,
            },
          ],
          persistedActiveSelectionIds: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      currentSessionId: 's1',
    };
    // Store as legacy shape to force migration path.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
    const loaded = loadPersisted();
    expect(loaded.shape.sessions[0]?.messages[0]).toMatchObject({ status: 'interrupted' });
  });
});

describe('settings', () => {
  it('defaults autoCssPreview to true when nothing is stored', () => {
    expect(loadSettings()).toEqual({
      ollamaBaseUrl: 'http://localhost:11434',
      globalModel: '',
      autoCssPreview: true,
      generation: DEFAULT_GENERATION,
    });
  });

  it('preserves autoCssPreview false across save and load', () => {
    expect(
      saveSettings({
        ollamaBaseUrl: 'http://localhost:11434',
        globalModel: 'm',
        autoCssPreview: false,
        generation: DEFAULT_GENERATION,
      }),
    ).toBe('ok');
    expect(loadSettings().autoCssPreview).toBe(false);
  });

  it('preserves autoCssPreview true across save and load', () => {
    saveSettings({
      ollamaBaseUrl: 'http://host:1234',
      globalModel: 'm',
      autoCssPreview: true,
      generation: DEFAULT_GENERATION,
    });
    expect(loadSettings()).toEqual({
      ollamaBaseUrl: 'http://host:1234',
      globalModel: 'm',
      autoCssPreview: true,
      generation: DEFAULT_GENERATION,
    });
  });

  it('falls back to true when the stored flag is not a boolean', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ollamaBaseUrl: 'x', globalModel: 'y', autoCssPreview: 'nope' }),
    );
    expect(loadSettings().autoCssPreview).toBe(true);
  });

  it('recovers defaults from corrupt settings', () => {
    localStorage.setItem(SETTINGS_KEY, '{broken');
    expect(loadSettings().autoCssPreview).toBe(true);
  });

  it('reports a write failure instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('nope');
    });
    expect(
      saveSettings({
        ollamaBaseUrl: 'x',
        globalModel: '',
        autoCssPreview: false,
        generation: DEFAULT_GENERATION,
      }),
    ).toBe('failed');
  });

  it('preserves non-default generation settings across save and load', () => {
    const generation = { ...DEFAULT_GENERATION, numCtx: 65536, think: 'high' as const, temperature: 0.35 };
    expect(
      saveSettings({
        ollamaBaseUrl: 'http://host:1234',
        globalModel: 'm',
        autoCssPreview: true,
        generation,
      }),
    ).toBe('ok');
    expect(loadSettings().generation).toEqual(generation);
  });

  it('fills generation defaults for a settings blob written by an older build', () => {
    // No `generation` key at all, which is what every pre-existing install has.
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ollamaBaseUrl: 'x', globalModel: 'y', autoCssPreview: true }),
    );
    expect(loadSettings().generation).toEqual(DEFAULT_GENERATION);
  });

  it('clamps a hand-edited generation value that is out of range', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ollamaBaseUrl: 'x',
        globalModel: 'y',
        autoCssPreview: true,
        generation: { numCtx: 999_999, repeatPenalty: 'high', think: 'insane' },
      }),
    );
    const loaded = loadSettings().generation;
    expect(loaded.numCtx).toBe(65536);
    expect(loaded.repeatPenalty).toBe(DEFAULT_GENERATION.repeatPenalty);
    expect(loaded.think).toBe(DEFAULT_GENERATION.think);
  });
});

// `useSessions` had no test file, which is where the retarget defect lived: the
// function that changes a session's target URL and clears the live selection set
// while leaving every preview transaction pointing at the page it was authored
// for. The controller now refuses to apply those, but the store also has to stop
// describing them as live, or the UI shows a row that is on when nothing is on
// the page.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSessions } from './useSessions.ts';
import type { SessionsApi } from './useSessions.ts';
import type { InspectorSession } from '../state/models.ts';
import type { PreviewTransaction } from '../preview/transaction.ts';
import { STORAGE_KEY, SETTINGS_KEY } from '../persistence/store.ts';

const ANCHOR = {
  elementKey: 'button.primary',
  routeKey: '/orders',
  mode: 'html' as const,
  tagName: 'button',
  id: 'primary',
  testId: 'primary-button',
  path: '/orders',
};

function transaction(overrides: Partial<PreviewTransaction> = {}): PreviewTransaction {
  return {
    id: 'pv-1',
    assistantId: 'a1',
    userMessageId: 'u1',
    sessionId: 's1',
    targetUrl: 'http://localhost:3000/orders',
    routeKey: '/orders',
    changes: [{ target: 1, anchor: ANCHOR, declarations: { color: '#111111' } }],
    enabled: true,
    status: 'applied',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function session(overrides: Partial<InspectorSession> = {}): InspectorSession {
  return {
    id: 's1',
    title: 'T',
    targetUrl: 'http://localhost:3000/orders',
    model: 'm',
    messages: [],
    previewTransactions: [transaction()],
    persistedActiveSelectionIds: ['sel-1'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let api: SessionsApi | null = null;
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function render(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <Probe />,
    );
  });
}

function Probe(): null {
  api = useSessions();
  return null;
}

function seed(sessions: InspectorSession[], currentId: string): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 2, data: { sessions, currentSessionId: currentId } }),
  );
}

function current(): InspectorSession | null {
  return api?.current ?? null;
}

beforeEach(() => {
  localStorage.clear();
  api = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  localStorage.clear();
});

describe('retargetSession', () => {
  it('I3: marks live transactions stale when the target page materially changes', () => {
    seed([session()], 's1');
    render();
    expect(current()?.previewTransactions[0]?.status).toBe('applied');

    act(() => {
      api!.retargetSession('s1', 'http://localhost:3000/checkout');
    });

    const moved = current()!;
    expect(moved.targetUrl).toBe('http://localhost:3000/checkout');
    expect(moved.persistedActiveSelectionIds).toEqual([]);
    // Kept, not deleted: history is the record of what was decided, and a row
    // that names the binding it belongs to is more use than a vanished row.
    expect(moved.previewTransactions).toHaveLength(1);
    expect(moved.previewTransactions[0]?.status).toBe('stale-binding');
    expect(moved.previewTransactions[0]?.enabled).toBe(false);
  });

  it('leaves transactions alone when only the query string changes', () => {
    seed([session()], 's1');
    render();

    act(() => {
      api!.retargetSession('s1', 'http://localhost:3000/orders?ref=preview');
    });

    const moved = current()!;
    expect(moved.targetUrl).toContain('ref=preview');
    // Same page: the anchors still resolve, so the preview is still valid and
    // marking it stale would throw away a working change over a query param.
    expect(moved.previewTransactions[0]?.status).toBe('applied');
    expect(moved.previewTransactions[0]?.enabled).toBe(true);
    expect(moved.persistedActiveSelectionIds).toEqual(['sel-1']);
  });

  it('does not re-enable a transaction that was already undone', () => {
    seed(
      [session({ previewTransactions: [transaction({ status: 'undone', enabled: false })] })],
      's1',
    );
    render();

    act(() => {
      api!.retargetSession('s1', 'http://localhost:3000/checkout');
    });

    const stored = current()!.previewTransactions[0]!;
    expect(stored.status).toBe('undone');
    expect(stored.enabled).toBe(false);
  });

  it('leaves other sessions untouched', () => {
    seed([session(), session({ id: 's2', title: 'Other' })], 's1');
    render();

    act(() => {
      api!.retargetSession('s2', 'http://localhost:3000/checkout');
    });

    const other = api!.sessions.find((s) => s.id === 's2')!;
    expect(other.previewTransactions[0]?.status).toBe('stale-binding');
    const mine = api!.sessions.find((s) => s.id === 's1')!;
    expect(mine.previewTransactions[0]?.status).toBe('applied');
  });

  it('survives a reload: the stale marking is persisted, not recomputed away', () => {
    seed([session()], 's1');
    render();
    act(() => {
      api!.retargetSession('s1', 'http://localhost:3000/checkout');
    });

    act(() => {
      root!.render(<Probe />);
    });
    api = null;
    act(() => {
      root!.render(<Probe />);
    });
    expect(current()?.previewTransactions[0]?.status).toBe('stale-binding');
  });
});

describe('settings persistence', () => {
  it('defaults autoCssPreview to true, which is what the architecture doc must say', () => {
    localStorage.removeItem(SETTINGS_KEY);
    seed([session()], 's1');
    render();
    expect(api!.settings.autoCssPreview).toBe(true);
  });
});

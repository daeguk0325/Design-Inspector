// Selection reconciliation tests (§22.2): the live snapshot rules export eligibility.
import { describe, expect, it } from 'vitest';
import type { LiveSnapshot, SelectionRecord } from '../protocol/types.ts';
import { reconcileActiveSelections, sortByFirstAdded } from './reconcile.ts';

function rec(id: string, order: number, key = `k-${id}`): SelectionRecord {
  return {
    selectionId: id,
    elementKey: key,
    component: `Comp-${id}`,
    file: 'src/App.tsx',
    line: order,
    mode: 'html',
    state: 'active',
    order,
  };
}

function snap(recs: SelectionRecord[], order: string[]): LiveSnapshot {
  return {
    connectionId: 'c',
    documentGeneration: 'd',
    inspectorFrozen: true,
    mode: 'html',
    selections: recs,
    activeOrder: order,
  };
}

describe('reconcileActiveSelections', () => {
  it('keeps only live-active ids; drops stale without deleting history', () => {
    const r = reconcileActiveSelections(['a', 'stale-x'], snap([rec('a', 0)], ['a']));
    expect(r.active.map((x) => x.selectionId)).toEqual(['a']);
    expect(r.droppedStaleIds).toEqual(['stale-x']);
  });

  it('returns empty active set with no snapshot (reload before handshake)', () => {
    const r = reconcileActiveSelections(['a'], null);
    expect(r.active).toEqual([]);
    expect(r.droppedStaleIds).toEqual(['a']);
  });

  it('dedupes by selectionId and compacts display numbering 1..N', () => {
    const r = reconcileActiveSelections(
      ['a', 'b', 'a'],
      snap([rec('a', 1), rec('b', 0)], ['a', 'b']),
    );
    expect(r.active.map((x) => x.selectionId).sort()).toEqual(['a', 'b']);
    expect(r.displayNumbers.get('a')).toBe(1);
    expect(r.displayNumbers.get('b')).toBe(2);
  });

  it('excludes toggled-off selections from future exports', () => {
    // Toggle-off: bridge snapshot no longer lists the id as active.
    const r = reconcileActiveSelections(['a', 'b'], snap([rec('b', 1)], ['b']));
    expect(r.active.map((x) => x.selectionId)).toEqual(['b']);
    expect(r.droppedStaleIds).toEqual(['a']);
  });

  it('clear-all empties the exportable set', () => {
    const r = reconcileActiveSelections(['a', 'b'], snap([], []));
    expect(r.active).toEqual([]);
    expect(r.activeOrder).toEqual([]);
  });

  it('sortByFirstAdded uses deterministic first-added order for export', () => {
    const out = sortByFirstAdded([rec('b', 5), rec('a', 2), rec('c', 9)]);
    expect(out.map((x) => x.selectionId)).toEqual(['a', 'b', 'c']);
  });
});

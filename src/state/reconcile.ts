// Reconciliation: persisted activeSelectionIds vs Bridge live snapshot (§§3.3, 15.2).
// Persisted IDs not present in the live snapshot MUST NOT be exported as active.
// Historical citations are never deleted by reconciliation (§4.4).

import type { LiveSnapshot, SelectionRecord } from '../protocol/types.ts';

export interface Reconciled {
  active: SelectionRecord[];
  /** Canonical display order for the tray (compacted 1..N, §6.3). */
  activeOrder: string[];
  /** Map selectionId -> display number. */
  displayNumbers: Map<string, number>;
  droppedStaleIds: string[];
}

export function reconcileActiveSelections(
  persistedIds: string[],
  snapshot: LiveSnapshot | null,
): Reconciled {
  if (!snapshot) {
    return {
      active: [],
      activeOrder: [],
      displayNumbers: new Map(),
      droppedStaleIds: [...persistedIds],
    };
  }
  const liveById = new Map(snapshot.selections.map((s) => [s.selectionId, s]));
  const liveActiveIds = new Set(
    snapshot.activeOrder.filter((id) => {
      const r = liveById.get(id);
      return r !== undefined && r.state === 'active';
    }),
  );
  // Dedupe persisted ids, keep only those live-active (§19.4).
  const seen = new Set<string>();
  const active: SelectionRecord[] = [];
  const droppedStaleIds: string[] = [];
  for (const id of persistedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const rec = liveById.get(id);
    if (rec && rec.state === 'active' && liveActiveIds.has(id)) {
      active.push(rec);
    } else {
      droppedStaleIds.push(id);
    }
  }
  // Deterministic tray order: snapshot activeOrder filtered to reconciled set,
  // then any reconciled-but-unordered records appended by first-added order.
  const activeIds = new Set(active.map((r) => r.selectionId));
  const activeOrder: string[] = snapshot.activeOrder.filter((id) =>
    activeIds.has(id),
  );
  const unordered = active
    .filter((r) => !activeOrder.includes(r.selectionId))
    .sort((a, b) => a.order - b.order);
  for (const r of unordered) activeOrder.push(r.selectionId);

  const displayNumbers = new Map<string, number>();
  activeOrder.forEach((id, i) => displayNumbers.set(id, i + 1));

  // Export order = first-added order (§6.2), but UI numbering = activeOrder.
  return { active, activeOrder, displayNumbers, droppedStaleIds };
}

/** Sort active records by first-added order for Components export (§6.2). */
export function sortByFirstAdded(records: SelectionRecord[]): SelectionRecord[] {
  return [...records].sort((a, b) => a.order - b.order);
}

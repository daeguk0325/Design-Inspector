// Session store: CRUD + persistence + deterministic restore (§15).
// Model precedence (§16.1): global model is the default for NEW sessions;
// each session stores its own model; changing the global default never
// retroactively changes existing sessions.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InspectorSession } from '../state/models.ts';
import { latestUserRequest, makeId } from '../state/models.ts';
import {
  emptyShape,
  loadPersisted,
  loadSettings,
  savePersisted,
  saveSettings,
} from '../persistence/store.ts';
import { isMateriallyDifferentTarget } from '../url/policy.ts';

export { latestUserRequest };

export function useSessions() {
  const [sessions, setSessions] = useState<InspectorSession[]>(() => loadPersisted().shape.sessions);
  const [currentId, setCurrentId] = useState<string | null>(
    () => loadPersisted().shape.currentSessionId,
  );
  const [settings, setSettings] = useState(() => loadSettings());
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  // Persist on change (last-write-wins multi-tab policy).
  useEffect(() => {
    const outcome = savePersisted({ sessions, currentSessionId: currentId });
    if (outcome === 'quota-exceeded') {
      setStorageWarning('Storage quota exceeded — oldest sessions may not persist.');
    } else if (outcome === 'failed') {
      setStorageWarning('Could not persist sessions.');
    } else {
      setStorageWarning(null);
    }
  }, [sessions, currentId]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const current: InspectorSession | null = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId],
  );

  const createSession = useCallback(
    (targetUrl: string, title?: string) => {
      const s: InspectorSession = {
        id: makeId('sess'),
        title: title ?? `Session ${sessions.length + 1}`,
        targetUrl,
        model: settings.globalModel,
        messages: [],
        previewTransactions: [],
        persistedActiveSelectionIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setSessions((prev) => [s, ...prev]);
      setCurrentId(s.id);
      return s.id;
    },
    [sessions.length, settings.globalModel],
  );

  const renameSession = useCallback((id: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title, updatedAt: Date.now() } : s)),
    );
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (currentId === id) {
        setCurrentId((cur) => {
          if (cur !== id) return cur;
          const rest = sessions.filter((s) => s.id !== id);
          return rest[0]?.id ?? null;
        });
      }
    },
    [currentId, sessions],
  );

  const bulkDelete = useCallback(
    (ids: string[]) => {
      const set = new Set(ids);
      setSessions((prev) => prev.filter((s) => !set.has(s.id)));
      if (currentId && set.has(currentId)) {
        const rest = sessions.filter((s) => !set.has(s.id));
        setCurrentId(rest[0]?.id ?? null);
      }
    },
    [currentId, sessions],
  );

  const switchSession = useCallback((id: string) => {
    // Live selections are rebound via Bridge snapshot; never leak across sessions (§14.5).
    setCurrentId(id);
  }, []);

  const updateSession = useCallback((id: string, patch: (s: InspectorSession) => InspectorSession) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? patch(s) : s)));
  }, []);

  const retargetSession = useCallback(
    (id: string, newUrl: string) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          if (isMateriallyDifferentTarget(s.targetUrl, newUrl)) {
            // §14.4: materially different target invalidates live selection set.
            return { ...s, targetUrl: newUrl, persistedActiveSelectionIds: [], updatedAt: Date.now() };
          }
          return { ...s, targetUrl: newUrl, updatedAt: Date.now() };
        }),
      );
    },
    [],
  );

  const ensureSession = useCallback((): InspectorSession | null => {
    if (current) return current;
    if (sessions.length > 0) {
      setCurrentId(sessions[0]!.id);
      return sessions[0]!;
    }
    return null;
  }, [current, sessions]);

  return {
    sessions,
    current,
    currentId,
    settings,
    setSettings,
    storageWarning,
    createSession,
    renameSession,
    deleteSession,
    bulkDelete,
    switchSession,
    updateSession,
    retargetSession,
    ensureSession,
    empty: sessions.length === 0,
    initialLoad: emptyShape,
  };
}

export type SessionsApi = ReturnType<typeof useSessions>;

import { useState } from 'react';
import type { SessionsApi } from '../hooks/useSessions.ts';

interface Props {
  api: SessionsApi;
  open: boolean;
  onClose: () => void;
}

export function SessionsDrawer({ api, open, onClose }: Props) {
  const [confirmBulk, setConfirmBulk] = useState(false);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" aria-label="Sessions">
        <div className="drawer-head">
          <span style={{ flex: 1 }}>Sessions</span>
          <button type="button" className="iconbtn" aria-label="Close sessions" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body">
          <button
            type="button"
            className="btn primary small"
            onClick={() => api.createSession(api.current?.targetUrl ?? api.sessions[0]?.targetUrl ?? 'http://127.0.0.1:3000', 'Target session')}
          >
            + New session
          </button>
          {api.sessions.length === 0 && (
            <p className="muted">No sessions yet. Create one to start inspecting.</p>
          )}
          {api.sessions.map((s) => (
            <div className={`sess ${s.id === api.currentId ? 'active' : ''}`} key={s.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="t">{s.title}</div>
                <div className="u">{s.targetUrl || '(no target)'}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {s.messages.length} messages · model {s.model || '(default)'}
                </div>
              </div>
              <button type="button" className="btn small" onClick={() => api.switchSession(s.id)} disabled={s.id === api.currentId}>
                Open
              </button>
              <button
                type="button"
                className="mini"
                aria-label={`Rename ${s.title}`}
                onClick={() => {
                  const next = window.prompt('Rename session', s.title);
                  if (next && next.trim()) api.renameSession(s.id, next.trim());
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="mini"
                aria-label={`Delete ${s.title}`}
                onClick={() => {
                  if (window.confirm(`Delete "${s.title}"? Messages and pins are removed.`)) api.deleteSession(s.id);
                }}
              >
                Delete
              </button>
            </div>
          ))}
          {api.sessions.length > 1 && (
            <div>
              {!confirmBulk ? (
                <button type="button" className="btn small" onClick={() => setConfirmBulk(true)}>
                  Bulk delete…
                </button>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="muted">Delete all {api.sessions.length} sessions?</span>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      api.bulkDelete(api.sessions.map((s) => s.id));
                      setConfirmBulk(false);
                    }}
                  >
                    Confirm
                  </button>
                  <button type="button" className="mini" onClick={() => setConfirmBulk(false)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
          {api.storageWarning && <p className="status-note err">{api.storageWarning}</p>}
        </div>
      </aside>
    </>
  );
}

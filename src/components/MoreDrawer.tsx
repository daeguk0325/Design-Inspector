import { useEffect, useState } from 'react';
import type { LiveSnapshot } from '../protocol/types.ts';
import { buildRawTranscript } from '../export/serialize.ts';
import type { InspectorSession } from '../state/models.ts';
import { getTargetStatus } from '../supervisor/client.ts';
import type { TargetStatus } from '../supervisor/client.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  session: InspectorSession | null;
  snapshot: LiveSnapshot | null;
  status: string;
  onCopyRaw: () => void;
  copiedRaw: boolean;
}

/** Secondary developer utilities — quiet, behind ⋯ (§20.11). */
export function MoreDrawer({ open, onClose, session, snapshot, status, onCopyRaw, copiedRaw }: Props) {
  const [target, setTarget] = useState<TargetStatus | null>(null);
  const [supervisorSeen, setSupervisorSeen] = useState<boolean | null>(null);

  // Poll the supervisor only while the drawer is open (loopback, cheap).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function poll() {
      const s = await getTargetStatus();
      if (!cancelled) {
        setTarget(s);
        setSupervisorSeen(s !== null);
      }
    }
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open ]);

  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" aria-label="Diagnostics and developer tools">
        <div className="drawer-head">
          <span style={{ flex: 1 }}>Inspect &amp; verify</span>
          <button type="button" className="iconbtn" aria-label="Close tools" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body">
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Connection</h4>
            <p className="muted mono">
              status: {status}
              <br />
              connectionId: {snapshot?.connectionId ?? '(none)'}
              <br />
              generation: {snapshot?.documentGeneration ?? '(none)'}
              <br />
              frozen: {String(snapshot?.inspectorFrozen ?? false)} · mode: {snapshot?.mode ?? '(—)'}
              <br />
              live selections: {snapshot?.selections.length ?? 0}
              <br />
              visual crops: {snapshot?.capabilities?.selectionCrop ? 'available' : 'unavailable'}
              <br />
              style preview: {snapshot?.capabilities?.cssPreview ? 'available' : 'unavailable'}
              <br />
              route: {snapshot?.routeKey ?? '(unknown)'} · epoch {snapshot?.routeEpoch ?? '—'}
            </p>
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Target dev server</h4>
            {supervisorSeen === false ? (
              <p className="muted">
                Supervisor not detected. Start App A with{' '}
                <span className="mono">npm run dev</span> (not{' '}
                <span className="mono">dev:web</span>) to see live target status and logs here.
              </p>
            ) : !target ? (
              <p className="muted">Checking supervisor…</p>
            ) : (
              <>
                <p className="muted mono">
                  state: {target.state}
                  <br />
                  dir: {target.dir ?? '(none)'}
                  <br />
                  command: {target.script ? `npm run ${target.script}` : '(none)'}
                  {target.port !== null ? ` · port: ${target.port}` : ''}
                  <br />
                  target: {target.targetUrl ?? '(none)'}
                   <br />
                   proxy: {target.proxyUrl ?? '(none)'}
                   <br />
                   compatibility bridge: {target.proxyCompatibilityBridge === null ? '(unknown)' : target.proxyCompatibilityBridge ? 'enabled' : 'unavailable'}
                 </p>
                 {target.error && <p className="status-note err">{target.error}</p>}
                 {target.proxyCompatibilityError && <p className="status-note err">Compatibility Bridge: {target.proxyCompatibilityError}</p>}
                 {target.logTail.length > 0 && (
                  <pre className="mono muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', background: 'var(--surface-soft)', padding: 10, borderRadius: 10 }}>
                    {target.logTail.slice(-60).join('\n')}
                  </pre>
                )}
              </>
            )}
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Manual integration checklist</h4>
            <p className="muted">
              Basic HTML inspection is automatic through the proxy. Optional
              target-side integrations (source metadata, R3F/Konva, state
              coordination) are listed in{' '}
              <span className="mono">docs/MANUAL_INTEGRATION_CHECKLIST.md</span>.
            </p>
            <ul className="muted" style={{ paddingLeft: 18, margin: '6px 0' }}>
              <li>Bridge import + init with exact App A origin</li>
              <li>Zustand freeze guard + hover clear</li>
              <li>HTML metadata: data-inspector-* or build plugin</li>
              <li>R3F + Konva registration (canvas / stage)</li>
              <li>Route/navigation + cleanup + Inspector bridge handshake</li>
            </ul>
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Architecture</h4>
            <p className="muted">
              Bridge owns live runtime; App A owns sessions/history/pins. See{' '}
              <span className="mono">docs/ARCHITECTURE.md</span>.
            </p>
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Self-tests</h4>
            <p className="muted">
              Run <span className="mono">npm test</span> — protocol, selection, freeze,
              persistence, Ollama parser, export. Results: <span className="mono">docs/VERIFICATION_REPORT.md</span>.
            </p>
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Raw transcript</h4>
            <button type="button" className="btn small" onClick={onCopyRaw} disabled={!session || session.messages.length === 0}>
              {copiedRaw ? 'Copied ✓' : 'Copy raw transcript'}
            </button>
            {session && (
              <pre className="mono muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', background: 'var(--surface-soft)', padding: 10, borderRadius: 10 }}>
                {buildRawTranscript(session).slice(0, 4000)}
              </pre>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

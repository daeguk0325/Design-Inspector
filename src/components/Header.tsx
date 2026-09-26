import type { ConnStatus } from '../hooks/useBridge.ts';
import type { InspectorMode } from '../protocol/types.ts';
import { shortcutLabel } from '../shortcut.ts';

export type ViewportPreset = 'desktop' | 'tablet' | 'mobile';

export interface HeaderProps {
  status: ConnStatus;
  ready: boolean;
  frozen: boolean;
  mode: InspectorMode;
  onModeChange: (m: InspectorMode) => void;
  onToggleFreeze: () => void;
  onReconnect: () => void;
  onCopyAgent: () => void;
  canCopyAgent: boolean;
  copied: boolean;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
  onOpenMore: () => void;
  sessionCount: number;
  previewCount?: number;
  /** Proposals still waiting on a decision. */
  pendingCount?: number;
  onResetPreviews?: () => void;
  onOpenChangeLog?: () => void;
  changeCount?: number;
  viewport?: ViewportPreset;
  onViewportChange?: (preset: ViewportPreset) => void;
  viewportDisabled?: boolean;
}

interface ViewportOption {
  value: ViewportPreset;
  label: string;
  width: number;
  height: number;
}

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  unavailable: 'Bridge unavailable',
  stale: 'Stale',
  disconnected: 'Not connected',
  timed_out: 'Timed out',
};

const VIEWPORT_OPTIONS: readonly ViewportOption[] = Object.freeze([
  { value: 'desktop', label: 'Desktop', width: 1280, height: 800 },
  { value: 'tablet', label: 'Tablet', width: 834, height: 1112 },
  { value: 'mobile', label: 'Mobile', width: 390, height: 844 },
]);

export function Header(p: HeaderProps) {
  const frozenLabel = p.frozen ? 'Frozen' : 'Freeze';
  const freezeKey = shortcutLabel();
  const onViewportChange = p.onViewportChange;
  const viewportLocked = !p.ready || p.viewportDisabled === true;
  const previewCount = p.previewCount ?? 0;
  const showPreviews = p.previewCount !== undefined || p.onResetPreviews !== undefined;
  const previewLabel = `${previewCount} preview${previewCount === 1 ? '' : 's'}`;

  return (
    <header className="topbar">
      <div className="brand" aria-label="Design Inspector Tool">
        <span className="brand-mark" aria-hidden="true">◈</span>
        <span>
          <div className="brand-name">Design Inspector</div>
        </span>
      </div>

      <div className="statusline">
        <span
          className={`pill ${p.status === 'connected' ? 'on' : ''}`}
          title={p.status === 'connected' ? 'Bridge handshake + heartbeat healthy' : 'Bridge connection state'}
          role="status"
        >
          <span className="dot" aria-hidden="true" />
          {STATUS_LABEL[p.status]}
        </span>
        <button
          type="button"
          className={`pill ${p.frozen ? 'frozen' : ''}`}
          aria-pressed={p.frozen}
          title={p.ready ? `Toggle Freeze (${freezeKey} works in App A and in the target)` : 'Freeze becomes available when the target Bridge is ready'}
          onClick={p.onToggleFreeze}
          disabled={!p.ready}
          style={{ cursor: p.ready ? 'pointer' : 'not-allowed' }}
        >
          <span className="dot" aria-hidden="true" />
          {frozenLabel}
        </button>
        <select
          aria-label="Inspector mode"
          title={p.frozen ? 'Mode can only change while Frozen; changing mode resets hover state' : 'Freeze the target before selecting an inspection mode'}
          disabled={!p.ready || !p.frozen}
          value={p.mode}
          onChange={(e) => p.onModeChange(e.target.value as InspectorMode)}
          style={{ borderRadius: 999, border: '1px solid var(--border)', padding: '5px 8px', fontSize: 12.5 }}
        >
          <option value="html">HTML</option>
          <option value="3d">3D</option>
          <option value="konva">Konva</option>
        </select>
        {onViewportChange && (
          <div className="topgroup" role="group" aria-label="Viewport preset">
            {VIEWPORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="viewport-btn"
                aria-pressed={p.viewport === option.value}
                disabled={viewportLocked}
                title={`${option.label} — ${option.width}×${option.height}`}
                aria-label={`${option.label} viewport ${option.width} by ${option.height}`}
                onClick={() => onViewportChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        {showPreviews && (
          <div className="topgroup" role="group" aria-label="Style previews">
            <span
              className={`pill preview-pill ${previewCount > 0 ? 'on' : ''}`}
              role="status"
              title={`${previewLabel} in this session`}
            >
              <span className="dot" aria-hidden="true" />
              {previewLabel}
            </span>
            <button
              type="button"
              className="mini preview-reset"
              disabled={!p.onResetPreviews || previewCount === 0}
              title="Reset every applied style preview"
              aria-label="Reset all style previews"
              onClick={() => p.onResetPreviews?.()}
            >
              Reset
            </button>
          </div>
        )}
        {p.onOpenChangeLog && (
          <div className="topgroup" role="group" aria-label="Change log">
            <button
              type="button"
              className={`pill changelog-pill ${(p.changeCount ?? 0) > 0 ? 'on' : ''}`}
              title={`${p.changeCount ?? 0} accepted change(s)`}
              onClick={p.onOpenChangeLog}
            >
              변경 내역
              {p.changeCount !== undefined && p.changeCount > 0 && (
                <span className="changelog-count">{p.changeCount}</span>
              )}
              {(p.pendingCount ?? 0) > 0 && (
                <span className="changelog-pending" title="Waiting for a decision">
                  {p.pendingCount}
                </span>
              )}
            </button>
          </div>
        )}
        <button type="button" className="btn accent" disabled={!p.canCopyAgent} onClick={p.onCopyAgent} title="Copy deterministic prompt for Cline / Kilo Code (no AI call)">
          {p.copied ? 'Copied ✓' : 'Copy for Agent'}
        </button>
        <button type="button" className="iconbtn" title={`Sessions (${p.sessionCount})`} aria-label="Sessions" onClick={p.onOpenSessions}>
          ☰
        </button>
        <button type="button" className="iconbtn" title="Ollama settings" aria-label="Settings" onClick={p.onOpenSettings}>
          ⚙
        </button>
        <button type="button" className="iconbtn" title="More: tests, checklist, architecture, diagnostics" aria-label="More tools" onClick={p.onOpenMore}>
          ⋯
        </button>
        <button type="button" className="iconbtn" title="Reconnect: fresh handshake + full snapshot reconciliation" aria-label="Reconnect" onClick={p.onReconnect}>
          ⟳
        </button>
      </div>
    </header>
  );
}

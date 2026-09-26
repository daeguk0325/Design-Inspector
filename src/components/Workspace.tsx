import type { RefObject } from 'react';

interface Props {
  paneRef: RefObject<HTMLElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  loadedUrl: string;
  urlError: string | null;
  iframeKey: string;
  onFrameLoad: () => void;
  viewportWidth?: number | null;
}

export function Workspace({ paneRef, iframeRef, loadedUrl, urlError, iframeKey, onFrameLoad, viewportWidth = null }: Props) {
  return (
    <section id="target-workspace-pane" ref={paneRef} className="vera-pane" aria-label="Target workspace">
      <div
        className="vera-frame"
        style={viewportWidth === null ? undefined : { width: `min(100%, ${viewportWidth}px)`, margin: '0 auto' }}
      >
        {urlError ? (
          <div className="vera-empty" role="alert">
            <div>
              <div style={{ fontWeight: 650, color: 'var(--text)' }}>{urlError}</div>
              <div className="vera-hint">Inspector could not prepare the local target.</div>
            </div>
          </div>
        ) : loadedUrl ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={loadedUrl}
            title="Target application under inspection"
            onLoad={onFrameLoad}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="vera-empty">
            <div className="vera-hint">No target loaded</div>
          </div>
        )}
      </div>
    </section>
  );
}

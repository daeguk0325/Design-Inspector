import type { SelectionCapture } from '../hooks/useBridge.ts';
import type { SelectionRecord } from '../protocol/types.ts';

interface Props {
  active: SelectionRecord[];
  displayNumbers: Map<string, number>;
  captures: Record<string, SelectionCapture>;
  onRemove: (id: string) => void;
  onRefresh: (id: string) => void;
  onClearAll: () => void;
}

export function CitationTray({ active, displayNumbers, captures, onRemove, onRefresh, onClearAll }: Props) {
  if (active.length === 0) return null;
  return (
    <div className="visual-tray" role="region" aria-label={`Visual citations (${active.length})`}>
      <div className="visual-tray-scroll">
        {active.map((record) => {
          const number = displayNumbers.get(record.selectionId) ?? '•';
          const capture = captures[record.selectionId];
          const source = capture?.result
            ? `data:${capture.result.mimeType};base64,${capture.result.base64}`
            : null;
          return (
            <article className="visual-card" key={record.selectionId}>
              <div className="visual-thumb" aria-busy={capture?.status === 'capturing'}>
                {source ? (
                  <img src={source} alt={`Selected component ${number}`} />
                ) : capture?.status === 'capturing' ? (
                  <span className="visual-status">Preparing…</span>
                ) : (
                  <span className="visual-status error">{capture?.error ?? 'Visual unavailable'}</span>
                )}
                <span className="visual-number">{number}</span>
              </div>
              <div className="visual-card-copy">
                <strong>{record.component ?? record.elementKey}</strong>
                <span>{record.file !== null ? `${record.file}${record.line !== null ? `:${record.line}` : ''}` : record.mode}</span>
              </div>
              <div className="visual-card-actions">
                <button
                  type="button"
                  disabled={capture?.status === 'capturing'}
                  onClick={() => onRefresh(record.selectionId)}
                  aria-label={`Refresh citation ${number}`}
                  title="Refresh image"
                >↻</button>
                <button type="button" onClick={() => onRemove(record.selectionId)} aria-label={`Remove citation ${number}`} title="Remove">×</button>
              </div>
            </article>
          );
        })}
      </div>
      <button type="button" className="visual-clear" onClick={onClearAll}>Clear</button>
    </div>
  );
}

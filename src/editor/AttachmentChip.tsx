import type { AttachmentView } from './attachmentModel.ts';
import { AttachmentThumb } from './AttachmentThumb.tsx';

export function AttachmentChip({ view, className }: { view: AttachmentView; className?: string }) {
  return (
    <span
      className={className ? `attach-chip ${className}` : 'attach-chip'}
      data-state={view.status}
      title={view.title}
    >
      <AttachmentThumb view={view} />
      <span className="attach-chip-copy">
        <span className="attach-chip-name">{view.name}</span>
        <span className="attach-chip-loc">{view.location}</span>
      </span>
    </span>
  );
}

export function AttachmentChips({ items }: { items: readonly AttachmentView[] }) {
  if (items.length === 0) return null;
  return (
    <span className="attach-chips">
      {items.map((view) => <AttachmentChip key={view.selectionId} view={view} />)}
    </span>
  );
}

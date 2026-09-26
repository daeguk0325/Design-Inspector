import type { AttachmentView } from './attachmentModel.ts';

function thumbBody(view: AttachmentView) {
  if (view.imageSrc !== null) {
    return <img className="attach-thumb-img" src={view.imageSrc} alt="" draggable={false} />;
  }
  if (view.status === 'loading') {
    return <span className="attach-spinner" aria-hidden="true" />;
  }
  return <span className="attach-thumb-fail" aria-hidden="true">!</span>;
}

function thumbBadge(view: AttachmentView) {
  return <span className="attach-badge">{view.number ?? '•'}</span>;
}

export function AttachmentThumb({
  view,
  retry,
}: {
  view: AttachmentView;
  retry?: (selectionId: string) => void;
}) {
  if (view.status === 'error' && retry) {
    return (
      <button
        type="button"
        className="attach-thumb attach-thumb-action"
        data-state={view.status}
        aria-label={`Retry capture for ${view.name}`}
        title={view.title}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => retry(view.selectionId)}
      >
        {thumbBody(view)}
        {thumbBadge(view)}
      </button>
    );
  }
  return (
    <span
      className="attach-thumb"
      data-state={view.status}
      aria-busy={view.status === 'loading'}
      title={view.title}
    >
      {thumbBody(view)}
      {thumbBadge(view)}
    </span>
  );
}

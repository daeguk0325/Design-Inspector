import { placeholderAttachmentView, type AttachmentView } from './attachmentModel.ts';
import { useAttachmentContext } from './AttachmentContext.tsx';
import { AttachmentThumb } from './AttachmentThumb.tsx';

function accessibleText(view: AttachmentView): string {
  const parts = [view.number !== null ? `Component ${view.number}` : 'Component', view.name, view.statusText];
  return parts.join(', ');
}

export function AttachmentTag({
  selectionId,
  removing = false,
}: {
  selectionId: string;
  removing?: boolean;
}) {
  const context = useAttachmentContext();
  const view = context.views.get(selectionId) ?? placeholderAttachmentView(selectionId);
  const armed = context.armedSelectionId === selectionId;
  const number = view.number !== null ? String(view.number) : '';

  function remove(): void {
    context.onRemove(view.selectionId);
    context.focusEditor();
  }

  return (
    <span
      className="attach-tag"
      data-state={view.status}
      data-armed={armed ? 'true' : undefined}
      data-removing={removing ? 'true' : undefined}
      title={view.title}
      contentEditable={false}
    >
      <AttachmentThumb
        view={view}
        retry={context.onRefresh}
      />
      <span className="attach-tag-name" aria-hidden="true">{view.name}</span>
      <span className="attach-tag-sr">{accessibleText(view)}</span>
      {context.onOpen && (
        <button
          type="button"
          className="attach-tag-info"
          aria-label={`Show details for ${view.name}`}
          title="Component details"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            context.onOpen?.(view.selectionId);
            context.focusEditor();
          }}
        >
          ⓘ
        </button>
      )}
      <button
        type="button"
        className="attach-tag-x"
        aria-label={`Remove attachment ${number || view.name}`}
        title="Remove attachment"
        onMouseDown={(event) => event.preventDefault()}
        onClick={remove}
      >
        ×
      </button>
    </span>
  );
}

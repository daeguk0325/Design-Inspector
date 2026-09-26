import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SelectionCapture } from '../hooks/useBridge.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import { ComposerEditor, type ComposerEditorController } from '../editor/ComposerEditor.tsx';
import {
  AttachmentFlyLayer,
  type AttachmentFlyHandle,
} from '../editor/AttachmentFlyLayer.tsx';
import {
  attachmentViewsById,
  buildAttachmentViews,
  partitionAttachments,
  type DisplayNumbers,
} from '../editor/attachmentModel.ts';
import { planSendCommit, planSendIntent } from '../editor/sendLifecycle.ts';

export interface ComposerProps {
  streaming: boolean;
  canSend: boolean;
  error?: string | null;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  selections?: readonly SelectionRecord[];
  displayNumbers?: DisplayNumbers;
  captures?: Readonly<Record<string, SelectionCapture>>;
  maxSelectionCount?: number;
  targetReady?: boolean;
  /** Resolves false when the target refused the deselect, so the tag returns. */
  onRemove?: (selectionId: string) => void | Promise<boolean>;
  /** An undo brought the tag back, so the target highlight has to follow. */
  onRestore?: (selectionId: string) => void;
  onRefresh?: (selectionId: string) => void;
  onOpenDetails?: (selectionId: string) => void;
  onClear?: () => void;
  /**
   * Why no image went with the last send. Informational, not an error: the
   * request still succeeded, it just carried no pixels.
   */
  visualNote?: string | null;
}

const EMPTY_SELECTIONS: readonly SelectionRecord[] = [];

export function Composer({
  streaming,
  canSend,
  error,
  onSend,
  onStop,
  selections = EMPTY_SELECTIONS,
  displayNumbers,
  captures,
  maxSelectionCount,
  targetReady,
  onRemove,
  onRestore,
  onRefresh,
  onOpenDetails,
  onClear,
  visualNote,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [preparingSeconds, setPreparingSeconds] = useState(0);
  const [armedSelectionId, setArmedSelectionId] = useState<string | null>(null);
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const controllerRef = useRef<ComposerEditorController | null>(null);
  const flyRef = useRef<AttachmentFlyHandle | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Image preparation can legitimately take ~30s (model capability lookup plus
  // a capture timeout). A running clock is what distinguishes "working" from
  // "stuck", which is the whole complaint this replaces.
  useEffect(() => {
    if (!preparing) {
      setPreparingSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setPreparingSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [preparing]);

  const ready = canSend && (targetReady ?? true);
  const views = useMemo(
    () => buildAttachmentViews(selections, displayNumbers, captures),
    [selections, displayNumbers, captures],
  );
  const viewsById = useMemo(() => attachmentViewsById(views), [views]);
  const partition = useMemo(
    () => partitionAttachments(
      views.map((view) => view.selectionId),
      maxSelectionCount ?? Number.MAX_SAFE_INTEGER,
    ),
    [views, maxSelectionCount],
  );
  const attachedSelectionIds = views.map((view) => view.selectionId);
  // The count must come from the tags themselves: falling back to a separate
  // active-selection counter is what let the composer claim "2 selected" with
  // nothing attached.
  const selectionCount = views.length;

  const handleRemove = useCallback(
    (selectionId: string) => {
      setArmedSelectionId((current) => (current === selectionId ? null : current));
      setRemoveNotice(null);
      const result = onRemove?.(selectionId);
      if (result instanceof Promise) {
        void result.then((cleared) => {
          setRemoveNotice(cleared ? null : 'The target kept that component selected, so the tag was restored.');
        });
      }
    },
    [onRemove],
  );

  const handleRefresh = useCallback(
    (selectionId: string) => {
      onRefresh?.(selectionId);
    },
    [onRefresh],
  );

  const handleReady = useCallback((controller: ComposerEditorController | null) => {
    controllerRef.current = controller;
  }, []);

  const handleTextChange = useCallback((next: string) => {
    setText(next);
  }, []);

  const handleArmChange = useCallback((selectionId: string | null) => {
    setArmedSelectionId(selectionId);
  }, []);

  function handleSubmit(): void {
    void submit();
  }

  function releaseAttachments(selectionIds: readonly string[]): void {
    if (selectionIds.length === 0) return;
    if (onClear) {
      onClear();
      return;
    }
    for (const selectionId of selectionIds) onRemove?.(selectionId);
  }

  /** Reads the on-screen tag rects before the composer clears them. */
  function captureTagRects(): DOMRect[] {
    const box = boxRef.current;
    if (!box) return [];
    return [...box.querySelectorAll<HTMLElement>('.attach-tag:not([data-removing="true"])')]
      .map((node) => node.getBoundingClientRect());
  }

  /** Runs once the new user message (and its inline references) is in the DOM. */
  function playFly(rects: DOMRect[]): void {
    if (rects.length === 0) return;
    // The newest user bubble, not the first match in the document: a query for
    // `.msg.user .cite` alone would fly the tag to the oldest message.
    const bubble = [...document.querySelectorAll('.msg.user .bubble')].at(-1);
    const target = bubble?.querySelector('.cite-inline');
    flyRef.current?.play(rects, target?.getBoundingClientRect() ?? null);
  }

  async function submit() {
    const intent = planSendIntent({
      streaming,
      preparing: preparingRef.current,
      text: controllerRef.current?.getPlainText() ?? text,
      request: controllerRef.current?.getTypedText() ?? text,
      ready,
    });
    if (intent.kind === 'stop') {
      onStop();
      return;
    }
    if (intent.kind === 'blocked') return;

    setArmedSelectionId(null);
    preparingRef.current = true;
    setPreparing(true);
    try {
      const sent = await onSend(intent.text);
      const commit = planSendCommit(
        sent,
        intent.text,
        controllerRef.current?.getPlainText() ?? text,
        attachedSelectionIds,
      );
      if (!commit.clearText && !commit.clearAttachmentsOnly) return;
      const rects = sent ? captureTagRects() : [];
      if (commit.clearText) controllerRef.current?.clear();
      else controllerRef.current?.clearAttachments();
      releaseAttachments(commit.releaseSelectionIds);
      if (rects.length > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => playFly(rects)));
      }
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  const placeholder = selectionCount > 0
    ? `Ask about ${selectionCount} selected element${selectionCount === 1 ? '' : 's'}…`
    : 'Freeze the target, select elements, then describe the change…';

  return (
    <div className="composer">
      <div className="compose-box" ref={boxRef}>
        <ComposerEditor
          attachmentIds={partition.shown}
          attachmentContext={{
            views: viewsById,
            armedSelectionId,
            onRemove: handleRemove,
            onRefresh: handleRefresh,
            onOpen: onOpenDetails,
          }}
          onArmChange={handleArmChange}
          onRestore={onRestore}
          onSubmit={handleSubmit}
          onReady={handleReady}
          onTextChange={handleTextChange}
          placeholder={placeholder}
        />
        {(error || removeNotice) && (
          <div className="compose-error" role="alert">{error ?? removeNotice}</div>
        )}
        {!error && !removeNotice && visualNote && (
          <div className="compose-note">{visualNote}</div>
        )}
        <div className="compose-row">
          {partition.overflow > 0 && (
            <span className="compose-overflow" title="More components are selected">
              +{partition.overflow} more
            </span>
          )}
          {streaming ? (
            <button type="button" className="btn small" onClick={handleSubmit} title="Stop streaming">
              Stop
            </button>
          ) : (
            <button
              type="button"
              className={`btn primary small${preparing ? ' busy' : ''}`}
              disabled={preparing || text.trim().length === 0 || !ready}
              onClick={handleSubmit}
              title="Send (Enter)"
            >
              {preparing ? `Preparing… ${preparingSeconds}s` : 'Send'}
            </button>
          )}
        </div>
      </div>
      <AttachmentFlyLayer ref={flyRef} />
    </div>
  );
}

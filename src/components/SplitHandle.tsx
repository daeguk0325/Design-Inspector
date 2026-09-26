import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  effectiveChatRatio,
  ratioFromPointerDelta,
} from '../layout/split.ts';

interface Props {
  value: number;
  min: number;
  max: number;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
  onDraggingChange: (dragging: boolean) => void;
  getTrackWidth: () => number;
  getChatWidth: () => number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startRatio: number;
  trackWidth: number;
}

export function SplitHandle({
  value,
  min,
  max,
  onPreview,
  onCommit,
  onReset,
  onDraggingChange,
  getTrackWidth,
  getChatWidth,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const preview = useCallback((next: number) => {
    valueRef.current = next;
    onPreview(next);
  }, [onPreview]);

  const finish = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const handle = handleRef.current;
    if (handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    setDragging(false);
    onDraggingChange(false);
    onCommit(valueRef.current);
  }, [onCommit, onDraggingChange]);

  useEffect(() => () => {
    const drag = dragRef.current;
    const handle = handleRef.current;
    if (drag && handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    dragRef.current = null;
    onDraggingChange(false);
  }, [onDraggingChange]);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const nextRatio = ratioFromPointerDelta(
        drag.startRatio,
        drag.startX,
        event.clientX,
        drag.trackWidth,
      );
      preview(effectiveChatRatio(nextRatio, drag.trackWidth));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
    };
  }, [dragging, finish, preview]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const trackWidth = getTrackWidth();
    const startChatWidth = getChatWidth();
    if (trackWidth <= 0 || startChatWidth <= 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startRatio: startChatWidth / trackWidth,
      trackWidth,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      setDragging(true);
      onDraggingChange(true);
      return;
    }
    setDragging(true);
    onDraggingChange(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.05 : 0.01;
    const trackWidth = getTrackWidth();
    const currentTargetPosition = 1 - effectiveChatRatio(valueRef.current, trackWidth);
    let nextTargetPosition: number | null = null;
    if (event.key === 'ArrowLeft') nextTargetPosition = currentTargetPosition - step;
    if (event.key === 'ArrowRight') nextTargetPosition = currentTargetPosition + step;
    if (event.key === 'Home') nextTargetPosition = 1 - max;
    if (event.key === 'End') nextTargetPosition = 1 - min;
    if (event.key === 'Enter') {
      event.preventDefault();
      onReset();
      return;
    }
    if (nextTargetPosition === null) return;
    event.preventDefault();
    const targetMin = 1 - max;
    const targetMax = 1 - min;
    const boundedTargetPosition = Math.min(
      targetMax,
      Math.max(targetMin, nextTargetPosition),
    );
    const effective = effectiveChatRatio(1 - boundedTargetPosition, trackWidth);
    preview(effective);
    onCommit(effective);
  }

  const targetRatio = 1 - effectiveChatRatio(value, getTrackWidth());
  const targetPercent = Math.round(targetRatio * 100);
  return (
    <div
      ref={handleRef}
      className={`split-handle${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-label="Resize target and chat panes"
      aria-controls="target-workspace-pane chat-pane"
      aria-keyshortcuts="ArrowLeft ArrowRight Home End"
      aria-orientation="vertical"
      aria-valuemin={Math.round((1 - max) * 100)}
      aria-valuemax={Math.round((1 - min) * 100)}
      aria-valuenow={targetPercent}
      aria-valuetext={`Target ${targetPercent}%, chat ${100 - targetPercent}%`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onLostPointerCapture={finish}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span aria-hidden="true" />
    </div>
  );
}

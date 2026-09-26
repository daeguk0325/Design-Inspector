import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ATTACH_EXIT_MS, prefersReducedMotion } from './motion.ts';

const FLY_MS = 260;

export interface AttachmentFlyHandle {
  play: (source: DOMRect[], target: DOMRect | null) => void;
}

interface FlyItem {
  key: string;
  from: DOMRect;
  dx: number;
  dy: number;
  phase: 'out' | 'done';
}

/**
 * Flies a snapshot of each composer tag into the citation chip it becomes, so a
 * send reads as one continuous motion instead of a cut.
 *
 * Purely decorative: the request is already dispatched and the chips are already
 * in the message. The layer removes itself on a timer and renders nothing under
 * reduced motion.
 */
export const AttachmentFlyLayer = forwardRef<
  AttachmentFlyHandle,
  { className?: string }
>(function AttachmentFlyLayer({ className }, ref) {
  const [items, setItems] = useState<FlyItem[]>([]);
  const timersRef = useRef<number[]>([]);

  const clear = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
    setItems([]);
  }, []);

  useEffect(() => clear, [clear]);

  const play = useCallback(
    (source: DOMRect[], target: DOMRect | null) => {
      if (prefersReducedMotion() || !target || source.length === 0) return;
      const staged = source
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect, index) => ({
          key: `fly-${index}`,
          from: rect,
          dx: target.left + target.width / 2 - (rect.left + rect.width / 2),
          dy: target.top + target.height / 2 - (rect.top + rect.height / 2),
          phase: 'out' as const,
        }));
      if (staged.length === 0) return;
      setItems(staged);
      timersRef.current.push(
        window.setTimeout(() => {
          setItems((current) => current.map((item) => ({ ...item, phase: 'done' as const })));
        }, ATTACH_EXIT_MS),
        window.setTimeout(() => setItems([]), ATTACH_EXIT_MS + FLY_MS),
      );
    },
    [],
  );

  useImperativeHandle(ref, () => ({ play }), [play]);

  if (items.length === 0) return null;
  return (
    <div className={`attach-fly-layer${className ? ` ${className}` : ''}`} aria-hidden="true">
      {items.map((item) => (
        <span
          key={item.key}
          className="attach-fly"
          data-phase={item.phase}
          style={{
            left: item.from.left,
            top: item.from.top,
            width: item.from.width,
            height: item.from.height,
            transform:
              item.phase === 'out'
                ? `translate(${item.dx * 0.35}px, ${item.dy * 0.35}px)`
                : `translate(${item.dx}px, ${item.dy}px) scale(0.55)`,
          }}
        />
      ))}
    </div>
  );
});

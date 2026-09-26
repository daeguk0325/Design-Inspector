import { createContext, useContext, type ReactNode } from 'react';
import type { AttachmentView } from './attachmentModel.ts';

export interface AttachmentContextValue {
  views: ReadonlyMap<string, AttachmentView>;
  armedSelectionId: string | null;
  onRemove: (selectionId: string) => void;
  onRefresh: (selectionId: string) => void;
  onOpen?: (selectionId: string) => void;
  focusEditor: () => void;
}

function noop(): void {}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

const FALLBACK: AttachmentContextValue = {
  views: new Map(),
  armedSelectionId: null,
  onRemove: noop,
  onRefresh: noop,
  focusEditor: noop,
};

export function AttachmentViewProvider({
  value,
  children,
}: {
  value: AttachmentContextValue;
  children: ReactNode;
}) {
  return <AttachmentContext.Provider value={value}>{children}</AttachmentContext.Provider>;
}

export function useAttachmentContext(): AttachmentContextValue {
  return useContext(AttachmentContext) ?? FALLBACK;
}

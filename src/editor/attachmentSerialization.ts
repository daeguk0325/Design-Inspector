export const ATTACHMENT_NODE_TYPE = 'composer-attachment';
export const ATTACHMENT_NODE_VERSION = 1;

export interface SerializedAttachmentData {
  type: string;
  version: number;
  selectionId: string;
}

export function serializeAttachment(selectionId: string): SerializedAttachmentData {
  return { type: ATTACHMENT_NODE_TYPE, version: ATTACHMENT_NODE_VERSION, selectionId };
}

export function parseSerializedSelectionId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as { selectionId?: unknown }).selectionId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

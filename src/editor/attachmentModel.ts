import type { SelectionCapture } from '../hooks/useBridge.ts';
import type { SelectionRecord } from '../protocol/types.ts';
import { citationLabel, citationMarker } from '../citationMarker.ts';

export type AttachmentStatus = 'loading' | 'ready' | 'error';

export type DisplayNumbers = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

export interface AttachmentView {
  selectionId: string;
  number: number | null;
  name: string;
  location: string;
  status: AttachmentStatus;
  statusText: string;
  imageSrc: string | null;
  title: string;
}

export function displayNumberFor(
  numbers: DisplayNumbers | null | undefined,
  selectionId: string,
): number | null {
  if (!numbers) return null;
  const value = numbers instanceof Map
    ? numbers.get(selectionId)
    : (numbers as Readonly<Record<string, number>>)[selectionId];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function attachmentName(record: SelectionRecord): string {
  const component = record.component?.trim();
  if (component) return component;
  const elementKey = record.elementKey?.trim();
  if (elementKey) return elementKey;
  return 'Component';
}

export function attachmentLocation(record: SelectionRecord): string {
  if (record.file !== null) {
    return record.line !== null ? `${record.file}:${record.line}` : record.file;
  }
  return record.mode;
}

export function attachmentStatus(capture: SelectionCapture | undefined): AttachmentStatus {
  if (!capture || capture.status === 'capturing') return 'loading';
  return capture.status === 'ready' ? 'ready' : 'error';
}

export function attachmentImageSrc(capture: SelectionCapture | undefined): string | null {
  const result = capture?.result;
  if (
    capture?.status !== 'ready' ||
    !result ||
    typeof result.base64 !== 'string' ||
    result.base64.length === 0
  ) {
    return null;
  }
  return `data:${result.mimeType};base64,${result.base64}`;
}

function attachmentStatusText(
  capture: SelectionCapture | undefined,
  status: AttachmentStatus,
): string {
  if (status === 'ready') return 'Ready';
  if (status === 'loading') return 'Preparing…';
  const error = capture?.error?.trim();
  return error && error.length > 0 ? error : 'Visual unavailable';
}

export function buildAttachmentView(
  record: SelectionRecord,
  numbers: DisplayNumbers | null | undefined,
  captures: Readonly<Record<string, SelectionCapture>> | null | undefined,
): AttachmentView {
  const capture = captures?.[record.selectionId];
  const status = attachmentStatus(capture);
  const number = displayNumberFor(numbers, record.selectionId);
  const name = attachmentName(record);
  const location = attachmentLocation(record);
  const statusText = attachmentStatusText(capture, status);
  const prefix = number !== null ? `#${number} ` : '';
  return {
    selectionId: record.selectionId,
    number,
    name,
    location,
    status,
    statusText,
    imageSrc: attachmentImageSrc(capture),
    title: `${prefix}${name} · ${location} · ${statusText}`,
  };
}

export function buildAttachmentViews(
  selections: readonly SelectionRecord[],
  numbers: DisplayNumbers | null | undefined,
  captures: Readonly<Record<string, SelectionCapture>> | null | undefined,
): AttachmentView[] {
  return selections.map((record) => buildAttachmentView(record, numbers, captures));
}

export function attachmentViewsById(views: readonly AttachmentView[]): Map<string, AttachmentView> {
  return new Map(views.map((view) => [view.selectionId, view]));
}

export function partitionAttachments(
  selectionIds: readonly string[],
  maxSelectionCount: number,
): { shown: string[]; overflow: number } {
  const limit = Number.isFinite(maxSelectionCount) && maxSelectionCount > 0
    ? Math.floor(maxSelectionCount)
    : selectionIds.length;
  return {
    shown: selectionIds.slice(0, limit),
    overflow: Math.max(0, selectionIds.length - limit),
  };
}

export function placeholderAttachmentView(selectionId: string): AttachmentView {
  return {
    selectionId,
    number: null,
    name: 'Component',
    location: 'Unavailable',
    status: 'error',
    statusText: 'This component is no longer selected.',
    imageSrc: null,
    title: 'This component is no longer selected.',
  };
}

/**
 * The citation reference a tag contributes to the sent text, e.g. `({1})`.
 *
 * The number is the one the `Inspected UI citations:` block is built from at
 * transmission, so an in-sentence reference and the component it names are the
 * same thing to the model. Before the capture finishes there is no number yet
 * and the component name is the only thing that still identifies the tag.
 */
export function attachmentReference(
  views: ReadonlyMap<string, Pick<AttachmentView, 'number' | 'name'>>,
): (selectionId: string) => string | null {
  return (selectionId) => {
    const view = views.get(selectionId);
    if (!view) return null;
    return view.number !== null ? citationMarker(view.number) : citationLabel(view.name);
  };
}

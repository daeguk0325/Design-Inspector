import type { AttachmentView } from '../editor/attachmentModel.ts';
import type { CitationSnapshot } from '../state/models.ts';

const MAX_NAME_CHARS = 120;
const MAX_LOCATION_CHARS = 200;

const MODE_LABEL: Record<CitationSnapshot['mode'], string> = Object.freeze({
  html: 'HTML',
  '3d': '3D',
  konva: 'Konva',
});

function bounded(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function citationDisplayNumber(citation: CitationSnapshot): number | null {
  const value = citation.displayNumber;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function citationLine(citation: CitationSnapshot): number | null {
  const line = citation.line;
  return typeof line === 'number' && Number.isFinite(line) && line >= 0 ? Math.floor(line) : null;
}

export function citationName(citation: CitationSnapshot): string {
  const component = citation.component?.trim();
  if (component) return bounded(component, MAX_NAME_CHARS);
  const key = citation.elementKey?.trim();
  return key ? bounded(key, MAX_NAME_CHARS) : 'Component';
}

export function citationLocation(citation: CitationSnapshot): string {
  const file = citation.file?.trim();
  if (file) {
    const line = citationLine(citation);
    return bounded(line === null ? file : `${file}:${line}`, MAX_LOCATION_CHARS);
  }
  return MODE_LABEL[citation.mode] ?? citation.mode;
}

export function citationAttachmentView(citation: CitationSnapshot): AttachmentView {
  const number = citationDisplayNumber(citation);
  const name = citationName(citation);
  const location = citationLocation(citation);
  const prefix = number !== null ? `#${number} ` : '';
  return {
    selectionId: citation.selectionId,
    number,
    name,
    location,
    status: 'ready',
    statusText: 'Sent with this request',
    imageSrc: null,
    title: `${prefix}${name} · ${location} · ${citation.elementKey} · No image stored with the message`,
  };
}

export function citationAttachmentViews(
  citations: readonly CitationSnapshot[],
): AttachmentView[] {
  return citations.map(citationAttachmentView);
}

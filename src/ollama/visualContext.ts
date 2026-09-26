import type { CaptureResultPayload } from '../protocol/types.ts';

export interface VisualContextItem {
  selectionId: string;
  displayNumber: number;
  component: string | null;
  result: CaptureResultPayload;
}

export interface VisualTransmission {
  endpoint: string;
  model: string;
  images: string[];
  citationNumbers: Array<number | null>;
  imageKinds?: Array<'contact-sheet' | 'crop'>;
  unavailableCitations?: number[];
  /**
   * The selected model is an Ollama cloud model, so these images leave the
   * machine even though the endpoint is loopback. The prompt says so.
   */
  cloudForwarded?: boolean;
}

/**
 * Every way image transmission can fail, in the user's language. The composer
 * shows the reason instead of leaving the Send button on "Preparing…", and the
 * same reason goes into the prompt so the model knows what it is not seeing.
 */
export type VisualUnavailableReason =
  | 'no-selection'
  | 'bridge-has-no-image-support'
  | 'target-cannot-capture'
  | 'target-not-ready'
  | 'invalid-endpoint'
  | 'endpoint-not-local'
  | 'model-lookup-failed'
  | 'model-cannot-see'
  | 'selection-changed'
  | 'capture-failed'
  | 'image-budget-exceeded'
  | 'cloud-forwarded';

export const VISUAL_REASON_TEXT: Readonly<Record<VisualUnavailableReason, string>> = Object.freeze({
  'no-selection': 'No component is selected, so no image was attached.',
  'bridge-has-no-image-support': 'The target Bridge reports no image support, so no image was attached.',
  'target-cannot-capture': 'The target cannot capture component images, so only the measured style facts were sent.',
  'target-not-ready': 'The target was not ready yet, so no image was attached.',
  'invalid-endpoint': 'The Ollama address is not a usable http(s) URL, so no image was attached.',
  'endpoint-not-local': 'The Ollama address is not local, so images were not attached.',
  'model-lookup-failed': 'The model\'s vision support could not be checked, so no image was attached.',
  'model-cannot-see': 'The selected model cannot read images, so only the measured style facts were sent.',
  'selection-changed': 'The selection changed while the image was being prepared, so no image was attached.',
  'capture-failed': 'The component image could not be captured, so only the measured style facts were sent.',
  'image-budget-exceeded': 'The component images were too large to send, so only the measured style facts were sent.',
  'cloud-forwarded': 'The images were forwarded to Ollama\'s cloud service for this model, so they left this machine.',
});

/** Named reasons, not a bare `undefined`: silence is what left the composer stuck. */
export type VisualPreparation =
  | { ok: true; transmission: VisualTransmission }
  | { ok: false; reason: VisualUnavailableReason };

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Visual context image could not be decoded.'));
    image.src = source;
  });
}

function dataUrl(result: CaptureResultPayload): string {
  return `data:${result.mimeType};base64,${result.base64}`;
}

function fitImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight, 1);
  const drawWidth = Math.max(1, image.naturalWidth * scale);
  const drawHeight = Math.max(1, image.naturalHeight * scale);
  context.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

export async function buildContactSheet(items: VisualContextItem[]): Promise<string> {
  if (items.length === 0) throw new Error('No visual context is available.');
  const columns = items.length <= 2 ? items.length : 2;
  const rows = Math.ceil(items.length / columns);
  const cellWidth = 640;
  const imageHeight = 390;
  const labelHeight = 38;
  const gap = 14;
  const padding = 14;
  const width = padding * 2 + columns * cellWidth + (columns - 1) * gap;
  const height = padding * 2 + rows * (labelHeight + imageHeight) + (rows - 1) * gap;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Contact sheet canvas is unavailable.');
  context.fillStyle = '#f4f4f2';
  context.fillRect(0, 0, width, height);
  const images = await Promise.all(items.map((item) => loadImage(dataUrl(item.result))));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const image = images[index];
    if (!item || !image) continue;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = padding + column * (cellWidth + gap);
    const y = padding + row * (labelHeight + imageHeight + gap);
    context.fillStyle = '#ffffff';
    context.fillRect(x, y, cellWidth, labelHeight + imageHeight);
    context.fillStyle = '#111111';
    context.font = '600 18px system-ui, sans-serif';
    const label = `[${item.displayNumber}] ${item.component ?? item.selectionId}`.slice(0, 72);
    context.fillText(label, x + 12, y + 25);
    context.strokeStyle = '#d8d8d5';
    context.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, labelHeight + imageHeight - 1);
    fitImage(context, image, x + 10, y + labelHeight + 10, cellWidth - 20, imageHeight - 20);
  }
  return canvas.toDataURL('image/jpeg', 0.84).split(',')[1] ?? '';
}

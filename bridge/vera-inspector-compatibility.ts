interface CaptureAsset {
  mimeType: 'image/png' | 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  byteLength: number;
}

interface BridgeOptions {
  appOrigin: string;
  initialMode?: 'html' | '3d' | 'konva';
}

type CaptureFailureCode =
  | 'capture-renderer-unavailable'
  | 'capture-invalid-bounds'
  | 'capture-invalid-dimensions'
  | 'capture-timeout'
  | 'capture-encoding'
  | 'capture-limits'
  | 'capture-failed';

interface Bounds {
  width: number;
  height: number;
}

interface Html2CanvasOptions {
  backgroundColor: string;
  scale: number;
  useCORS: boolean;
  allowTaint: boolean;
  imageTimeout: number;
  logging: boolean;
  onclone?: (document: Document, element: Element) => void;
}

type Html2Canvas = (
  element: Element,
  options: Html2CanvasOptions,
) => Promise<HTMLCanvasElement>;

const MAX_DIMENSION = 1600;
const MAX_PIXELS = 2_000_000;
const MAX_BYTES = 524_288;
const MAX_BASE64_LENGTH = 700_000;
const FONT_WAIT_MS = 2000;
const DIRECT_IMAGE_TIMEOUT_MS = 2000;
const RENDER_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 18_000;
const MAX_SVG_LENGTH = 1_500_000;

const SAFE_MESSAGES: Record<CaptureFailureCode, string> = {
  'capture-renderer-unavailable': 'The component renderer is unavailable.',
  'capture-invalid-bounds': 'The selected component has no visible bounds.',
  'capture-invalid-dimensions': 'The component image dimensions are invalid.',
  'capture-timeout': 'The component capture timed out.',
  'capture-encoding': 'The component image could not be encoded.',
  'capture-limits': 'The component image exceeds the capture limits.',
  'capture-failed': 'The selected component could not be captured.',
};

class CaptureFailure extends Error {
  readonly code: CaptureFailureCode;

  constructor(code: CaptureFailureCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'CaptureFailure';
    this.code = code;
  }
}

function failure(code: CaptureFailureCode): CaptureFailure {
  return new CaptureFailure(code);
}

function isCaptureFailure(error: unknown): error is CaptureFailure {
  return error instanceof CaptureFailure;
}

function normalizeFailure(error: unknown, fallback: CaptureFailureCode): CaptureFailure {
  if (isCaptureFailure(error)) return error;
  if (error && typeof error === 'object') {
    try {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, code)) {
        return failure(code as CaptureFailureCode);
      }
    } catch {
      return failure(fallback);
    }
  }
  return failure(fallback);
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: number | null = null;
    let workPromise: Promise<T>;
    try {
      workPromise = Promise.resolve(work);
    } catch (error) {
      reject(error);
      return;
    }
    const finish = (callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      reject(error);
    };
    try {
      timer = window.setTimeout(() => {
        if (settled) return;
        try {
          Promise.resolve(onTimeout()).then(
            (value) => finish(resolve, value),
            (error) => fail(error),
          );
        } catch (error) {
          fail(error);
        }
      }, Math.max(0, Math.min(2_147_483_647, timeoutMs)));
    } catch (error) {
      fail(error);
    }
    workPromise.then(
      (value) => finish(resolve, value),
      (error) => fail(error),
    );
  });
}

async function waitForFonts(deadline: number): Promise<void> {
  try {
    const fonts = document.fonts;
    if (!fonts || fonts.status !== 'loading' || !fonts.ready) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const ready = Promise.resolve(fonts.ready).catch(() => undefined);
    await withTimeout(ready, Math.min(FONT_WAIT_MS, remaining), () => undefined);
  } catch {
    return;
  }
}

function readBounds(element: Element): Bounds {
  let rect: DOMRect | null = null;
  try {
    rect = element.getBoundingClientRect();
  } catch {
    throw failure('capture-invalid-bounds');
  }
  let width: number;
  let height: number;
  try {
    width = Number(rect?.width);
    height = Number(rect?.height);
  } catch {
    throw failure('capture-invalid-bounds');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw failure('capture-invalid-bounds');
  }
  return { width, height };
}

function scaleForBounds(bounds: Bounds): number {
  const area = bounds.width * bounds.height;
  const dimensionScale = Math.min(MAX_DIMENSION / bounds.width, MAX_DIMENSION / bounds.height);
  const pixelScale = Number.isFinite(area) && area > 0 ? Math.sqrt(MAX_PIXELS / area) : 0;
  const scale = Math.min(2, dimensionScale, pixelScale);
  if (!Number.isFinite(scale) || scale <= 0) throw failure('capture-limits');
  return scale;
}

function readCanvasDimensions(canvas: HTMLCanvasElement): Bounds {
  let width: unknown;
  let height: unknown;
  try {
    width = canvas.width;
    height = canvas.height;
  } catch {
    throw failure('capture-invalid-dimensions');
  }
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw failure('capture-invalid-dimensions');
  }
  return { width, height };
}

function assertOutputDimensions(bounds: Bounds): void {
  if (
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    !Number.isInteger(bounds.width) ||
    !Number.isInteger(bounds.height) ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    throw failure('capture-invalid-dimensions');
  }
  if (bounds.width > MAX_DIMENSION || bounds.height > MAX_DIMENSION) {
    throw failure('capture-limits');
  }
  if (!Number.isFinite(bounds.width * bounds.height) || bounds.width * bounds.height > MAX_PIXELS) {
    throw failure('capture-limits');
  }
}

function outputDimensions(source: Bounds, scale: number): Bounds {
  if (
    !Number.isFinite(source.width) ||
    !Number.isFinite(source.height) ||
    source.width <= 0 ||
    source.height <= 0 ||
    !Number.isFinite(scale) ||
    scale <= 0
  ) {
    throw failure('capture-invalid-dimensions');
  }
  const rawWidth = source.width * scale;
  const rawHeight = source.height * scale;
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) {
    throw failure('capture-invalid-dimensions');
  }
  let width = Math.min(MAX_DIMENSION, Math.max(1, Math.round(rawWidth)));
  let height = Math.min(MAX_DIMENSION, Math.max(1, Math.round(rawHeight)));
  const area = width * height;
  if (!Number.isFinite(area) || area <= 0) throw failure('capture-invalid-dimensions');
  if (area > MAX_PIXELS) {
    const fit = Math.min(MAX_DIMENSION / width, Math.sqrt(MAX_PIXELS / area));
    width = Math.max(1, Math.floor(width * fit));
    height = Math.max(1, Math.floor(height * fit));
  }
  const result = { width, height };
  assertOutputDimensions(result);
  return result;
}

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    throw failure('capture-encoding');
  }
  if (!context) throw failure('capture-encoding');
  return context;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const dimensions = { width, height };
  assertOutputDimensions(dimensions);
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } catch {
    throw failure('capture-encoding');
  }
  assertOutputDimensions(readCanvasDimensions(canvas));
  return canvas;
}

function base64ByteLength(value: string): number {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return Number.NaN;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number | undefined,
  deadline: number,
): Promise<Blob> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(failure('capture-timeout'));
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    let timer: number | null = null;
    const finish = (callback: (value: Blob) => void, value: Blob) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      reject(error);
    };
    try {
      timer = window.setTimeout(() => fail(failure('capture-timeout')), Math.min(remaining, 2_147_483_647));
      canvas.toBlob((blob) => {
        if (settled) return;
        if (!blob) {
          fail(failure('capture-encoding'));
          return;
        }
        finish(resolve, blob);
      }, type, quality);
    } catch {
      fail(failure('capture-encoding'));
    }
  });
}

function blobBase64(blob: Blob, deadline: number): Promise<string> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(failure('capture-timeout'));
  return new Promise<string>((resolve, reject) => {
    let reader: FileReader | null = null;
    let settled = false;
    let timer: number | null = null;
    const finish = (callback: (value: string) => void, value: string) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      if (reader) {
        reader.onload = null;
        reader.onerror = null;
        reader.onabort = null;
      }
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      if (reader) {
        reader.onload = null;
        reader.onerror = null;
        reader.onabort = null;
        try {
          if (reader.readyState === 1) reader.abort();
        } catch {
          reader = null;
        }
      }
      reject(error);
    };
    try {
      reader = new FileReader();
      timer = window.setTimeout(() => fail(failure('capture-timeout')), Math.min(remaining, 2_147_483_647));
      reader.onload = () => {
        if (settled || !reader) return;
        let result: string;
        try {
          result = String(reader.result ?? '');
        } catch {
          fail(failure('capture-encoding'));
          return;
        }
        const comma = result.indexOf(',');
        if (comma < 0) {
          fail(failure('capture-encoding'));
          return;
        }
        const value = result.slice(comma + 1);
        const byteLength = base64ByteLength(value);
        if (!Number.isFinite(byteLength) || byteLength < 1 || value.length > MAX_BASE64_LENGTH) {
          fail(failure('capture-limits'));
          return;
        }
        finish(resolve, value);
      };
      reader.onerror = () => fail(failure('capture-encoding'));
      reader.onabort = () => fail(failure('capture-encoding'));
      reader.readAsDataURL(blob);
    } catch {
      fail(failure('capture-encoding'));
    }
  });
}

function assetFromBlob(
  canvas: HTMLCanvasElement,
  blob: Blob,
  mimeType: CaptureAsset['mimeType'],
  base64: string,
): CaptureAsset {
  const dimensions = readCanvasDimensions(canvas);
  assertOutputDimensions(dimensions);
  const byteLength = blob.size;
  const decodedLength = base64ByteLength(base64);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || decodedLength !== byteLength) {
    throw failure('capture-encoding');
  }
  if (byteLength > MAX_BYTES || base64.length > MAX_BASE64_LENGTH) {
    throw failure('capture-limits');
  }
  const signatureMatches =
    (mimeType === 'image/png' && base64.startsWith('iVBORw0KGgo')) ||
    (mimeType === 'image/jpeg' && base64.startsWith('/9j/'));
  if (!signatureMatches) throw failure('capture-encoding');
  return {
    mimeType,
    base64,
    width: dimensions.width,
    height: dimensions.height,
    byteLength,
  };
}

function resizedCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const sourceDimensions = readCanvasDimensions(source);
  const dimensions = outputDimensions(sourceDimensions, scale);
  const canvas = createCanvas(dimensions.width, dimensions.height);
  const context = contextFor(canvas);
  try {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(source, 0, 0, dimensions.width, dimensions.height);
  } catch {
    throw failure('capture-encoding');
  }
  return canvas;
}

async function encodeCanvas(source: HTMLCanvasElement, deadline: number): Promise<CaptureAsset> {
  let canvas = source;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dimensions = readCanvasDimensions(canvas);
    assertOutputDimensions(dimensions);
    const png = await canvasBlob(canvas, 'image/png', undefined, deadline);
    if (png.size <= MAX_BYTES) {
      const base64 = await blobBase64(png, deadline);
      return assetFromBlob(canvas, png, 'image/png', base64);
    }
    const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.86 - attempt * 0.12, deadline);
    if (jpeg.size <= MAX_BYTES) {
      const base64 = await blobBase64(jpeg, deadline);
      return assetFromBlob(canvas, jpeg, 'image/jpeg', base64);
    }
    if (dimensions.width <= 640 && dimensions.height <= 640) break;
    canvas = resizedCanvas(canvas, 0.72);
  }
  throw failure('capture-limits');
}

function isCanvasElement(element: Element): element is HTMLCanvasElement {
  return element.tagName?.toLowerCase() === 'canvas';
}

function isSvgElement(element: Element): element is SVGSVGElement {
  return element.tagName?.toLowerCase() === 'svg' &&
    (element.namespaceURI === 'http://www.w3.org/2000/svg' ||
      element.namespaceURI === null ||
      typeof element.namespaceURI === 'undefined');
}

function sanitizeModernStyles(clonedDocument: Document, clonedRoot: Element): void {
  const nodes: Element[] = [];
  try {
    if (clonedRoot) nodes.push(clonedRoot);
    if (typeof clonedRoot.querySelectorAll === 'function') {
      nodes.push(...clonedRoot.querySelectorAll('*'));
    }
  } catch {
    return;
  }
  const modernColor = /(?:oklch|oklab|lab|lch|color-mix|light-dark|color)\(/i;
  const properties = [
    'color',
    'background',
    'background-color',
    'border',
    'border-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'fill',
    'stroke',
    'outline-color',
    'text-decoration-color',
    'box-shadow',
    'text-shadow',
    'filter',
    'backdrop-filter',
    'transform',
    'translate',
    'rotate',
    'scale',
    'perspective',
  ];
  for (const node of nodes) {
    const style = (node as HTMLElement).style;
    if (!style || typeof style.getPropertyValue !== 'function') continue;
    for (const property of properties) {
      let value = '';
      try {
        value = style.getPropertyValue(property);
        if (modernColor.test(value)) style.removeProperty(property);
      } catch {
        continue;
      }
    }
    try {
      style.setProperty('transform', 'none', 'important');
      style.setProperty('translate', 'none', 'important');
      style.setProperty('rotate', 'none', 'important');
      style.setProperty('scale', 'none', 'important');
      style.setProperty('perspective', 'none', 'important');
    } catch {
      continue;
    }
  }
  try {
    const styleElement = clonedDocument.createElement('style');
    styleElement.textContent = '*,*::before,*::after{transform:none!important;translate:none!important;rotate:none!important;scale:none!important;perspective:none!important;filter:none!important;backdrop-filter:none!important;box-shadow:none!important;text-shadow:none!important;color:#111!important;background:transparent!important;border:0 solid transparent!important;outline-color:transparent!important;fill:currentColor!important;stroke:currentColor!important}';
    const parent = clonedDocument.head ?? clonedDocument.documentElement;
    parent?.appendChild(styleElement);
  } catch {
    return;
  }
}

function sanitizedSvgSource(element: SVGSVGElement, bounds: Bounds): string | null {
  try {
    const outerHtml = typeof element.outerHTML === 'string' ? element.outerHTML : '';
    if (outerHtml.length > MAX_SVG_LENGTH) return null;
    const serializer = new XMLSerializer();
    const clone = element.cloneNode(true) as SVGSVGElement;
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(bounds.width));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(bounds.height));
    const descendants = clone.querySelectorAll('script,foreignObject,iframe,object,embed');
    for (const node of descendants) node.remove();
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (name.startsWith('on')) node.removeAttribute(attribute.name);
        if ((name === 'href' || name.endsWith(':href')) && !/^(?:#|data:image\/)/i.test(value)) {
          node.removeAttribute(attribute.name);
        }
      }
    }
    const source = serializer.serializeToString(clone);
    if (!source || source.length > MAX_SVG_LENGTH) return null;
    return source;
  } catch {
    return null;
  }
}

function loadSvgImage(source: string, deadline: number): Promise<HTMLImageElement> {
  const remaining = Math.min(deadline - Date.now(), DIRECT_IMAGE_TIMEOUT_MS);
  if (remaining <= 0) return Promise.reject(failure('capture-timeout'));
  return new Promise<HTMLImageElement>((resolve, reject) => {
    let image: HTMLImageElement;
    try {
      if (typeof window.Image !== 'function') throw failure('capture-failed');
      image = new window.Image();
    } catch {
      reject(failure('capture-failed'));
      return;
    }
    let settled = false;
    let timer: number | null = null;
    const finish = (callback: (value: HTMLImageElement) => void, value: HTMLImageElement) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      image.onload = null;
      image.onerror = null;
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch {
          timer = null;
        }
      }
      image.onload = null;
      image.onerror = null;
      reject(error);
    };
    image.onload = () => finish(resolve, image);
    image.onerror = () => fail(failure('capture-failed'));
    try {
      timer = window.setTimeout(() => fail(failure('capture-timeout')), Math.min(remaining, 2_147_483_647));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    } catch {
      fail(failure('capture-encoding'));
    }
  });
}

async function captureCanvasDirect(
  element: HTMLCanvasElement,
  bounds: Bounds,
  scale: number,
  deadline: number,
): Promise<CaptureAsset> {
  const source = readCanvasDimensions(element);
  const sourcePixels = source.width * source.height;
  const sourceFit = Number.isFinite(sourcePixels) && sourcePixels > 0
    ? Math.min(MAX_DIMENSION / source.width, Math.sqrt(MAX_PIXELS / sourcePixels))
    : 0;
  const outputScale = Math.min(scale, sourceFit);
  if (!Number.isFinite(outputScale) || outputScale <= 0) throw failure('capture-invalid-dimensions');
  const dimensions = outputDimensions(bounds, outputScale);
  const canvas = createCanvas(dimensions.width, dimensions.height);
  const context = contextFor(canvas);
  try {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(element, 0, 0, dimensions.width, dimensions.height);
  } catch {
    throw failure('capture-encoding');
  }
  return encodeCanvas(canvas, deadline);
}

async function captureSvgDirect(
  element: SVGSVGElement,
  bounds: Bounds,
  scale: number,
  deadline: number,
): Promise<CaptureAsset> {
  const source = sanitizedSvgSource(element, bounds);
  if (source === null) throw failure('capture-failed');
  const image = await loadSvgImage(source, deadline);
  const dimensions = outputDimensions(bounds, scale);
  const canvas = createCanvas(dimensions.width, dimensions.height);
  const context = contextFor(canvas);
  try {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
  } catch {
    throw failure('capture-encoding');
  }
  return encodeCanvas(canvas, deadline);
}

function html2CanvasRenderer(): Html2Canvas | null {
  try {
    const candidate = (window as typeof window & { html2canvas?: unknown }).html2canvas;
    return typeof candidate === 'function' ? candidate as Html2Canvas : null;
  } catch {
    return null;
  }
}

function isModernStyleFailure(error: unknown): boolean {
  let message = '';
  try {
    if (error && typeof error === 'object' && 'message' in error) {
      message = String((error as { message?: unknown }).message ?? '').slice(0, 512);
    }
  } catch {
    return false;
  }
  return /(?:oklch|oklab|(?:^|[^\w])(?:lab|lch)(?:[^\w]|$)|color-mix|light-dark|color\s*\(|translate3d|matrix3d|perspective|backdrop-filter|modern.{0,40}(?:css|color|transform|grid|filter)|(?:unsupported|invalid|failed|unable to parse|cannot parse).{0,60}(?:css|color|transform|translate|rotate|scale|filter|grid|gap)|(?:css|color|transform|translate|rotate|scale|filter|grid|gap).{0,60}(?:unsupported|invalid|failed|parse))/i.test(message);
}

async function renderWithHtml2Canvas(
  element: Element,
  scale: number,
  deadline: number,
): Promise<CaptureAsset> {
  const renderer = html2CanvasRenderer();
  if (!renderer) throw failure('capture-renderer-unavailable');
  const baseOptions: Html2CanvasOptions = {
    backgroundColor: '#ffffff',
    scale,
    useCORS: true,
    allowTaint: false,
    imageTimeout: 15_000,
    logging: false,
  };
  let lastFailure = failure('capture-failed');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure('capture-timeout');
    const options: Html2CanvasOptions = attempt === 0
      ? baseOptions
      : { ...baseOptions, onclone: sanitizeModernStyles };
    let synchronousFailure = false;
    let rendering: Promise<HTMLCanvasElement>;
    try {
      rendering = Promise.resolve(renderer.call(window, element, options));
    } catch (error) {
      synchronousFailure = true;
      rendering = Promise.reject(error);
    }
    let rendered: HTMLCanvasElement;
    try {
      rendered = await withTimeout(
        rendering,
        Math.min(RENDER_TIMEOUT_MS, remaining),
        () => Promise.reject(failure('capture-timeout')),
      );
    } catch (error) {
      const retryable = attempt === 0 && (!synchronousFailure || isModernStyleFailure(error));
      lastFailure = normalizeFailure(error, 'capture-failed');
      if (lastFailure.code === 'capture-timeout') throw lastFailure;
      if (retryable) continue;
      throw lastFailure;
    }
    const dimensions = readCanvasDimensions(rendered);
    assertOutputDimensions(dimensions);
    return encodeCanvas(rendered, deadline);
  }
  throw lastFailure;
}

async function captureElementNow(element: Element): Promise<CaptureAsset> {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  try {
    await waitForFonts(deadline);
    const bounds = readBounds(element);
    const scale = scaleForBounds(bounds);
    let directFailure: CaptureFailure | null = null;
    if (isCanvasElement(element)) {
      try {
        return await captureCanvasDirect(element, bounds, scale, deadline);
      } catch (error) {
        directFailure = normalizeFailure(error, 'capture-failed');
      }
    } else if (isSvgElement(element)) {
      try {
        return await captureSvgDirect(element, bounds, scale, deadline);
      } catch (error) {
        directFailure = normalizeFailure(error, 'capture-failed');
      }
    }
    if (!html2CanvasRenderer()) {
      throw directFailure ?? failure('capture-renderer-unavailable');
    }
    return await renderWithHtml2Canvas(element, scale, deadline);
  } catch (error) {
    throw normalizeFailure(error, 'capture-failed');
  }
}

function serializedCaptureQueue(): (element: Element) => Promise<CaptureAsset> {
  let tail: Promise<void> = Promise.resolve();
  return (element: Element) => {
    const current = tail.then(() => captureElementNow(element));
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
}

export function initCompatibilityBridge(options: BridgeOptions) {
  const core = (window as typeof window & {
    VeraInspectorCore?: {
      initVeraInspectorBridge: (options: unknown) => unknown;
    };
  }).VeraInspectorCore;
  if (!core) throw new Error('Inspector Bridge core unavailable');
  const captureElement = serializedCaptureQueue();
  return core.initVeraInspectorBridge({
    ...options,
    bridgeKind: 'compatibility',
    captureElement,
  });
}

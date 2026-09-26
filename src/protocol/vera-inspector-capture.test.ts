import { afterEach, describe, expect, it, vi } from 'vitest';
import { initVeraInspectorBridge } from '../../bridge/vera-inspector-bridge.ts';
import { initCompatibilityBridge } from '../../bridge/vera-inspector-compatibility.ts';

interface CaptureAsset {
  mimeType: 'image/png' | 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  byteLength: number;
}

type CaptureFunction = (element: Element) => Promise<CaptureAsset>;

interface CompatibilityWindow extends Window {
  html2canvas?: unknown;
  VeraInspectorCore?: {
    initVeraInspectorBridge: (options: unknown) => unknown;
  };
}

const originalHtml2Canvas = (window as CompatibilityWindow).html2canvas;
const originalCore = (window as CompatibilityWindow).VeraInspectorCore;

function installCaptureFunction(): CaptureFunction {
  let captureElement: CaptureFunction | null = null;
  (window as CompatibilityWindow).VeraInspectorCore = {
    initVeraInspectorBridge(options: unknown) {
      captureElement = (options as { captureElement: CaptureFunction }).captureElement;
      return { destroy() {} };
    },
  };
  initCompatibilityBridge({ appOrigin: 'http://app.test' });
  if (!captureElement) throw new Error('capture function was not installed');
  return captureElement;
}

function elementWithSize(width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

function validCanvas(width = 2, height = 2): HTMLCanvasElement {
  return {
    width,
    height,
    toBlob(callback: BlobCallback, type?: string) {
      const bytes = type === 'image/jpeg'
        ? new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
        : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      callback(new Blob([bytes], { type: type ?? 'image/png' }));
    },
  } as unknown as HTMLCanvasElement;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  (window as CompatibilityWindow).html2canvas = originalHtml2Canvas;
  (window as CompatibilityWindow).VeraInspectorCore = originalCore;
  document.body.innerHTML = '';
});

describe('compatibility component capture', () => {
  it('reports renderer unavailability with a safe failure', async () => {
    const captureElement = installCaptureFunction();
    (window as CompatibilityWindow).html2canvas = undefined;
    await expect(captureElement(elementWithSize(10, 10))).rejects.toMatchObject({
      code: 'capture-renderer-unavailable',
      message: 'The component renderer is unavailable.',
    });
  });

  it('rejects zero bounds before invoking a renderer', async () => {
    const captureElement = installCaptureFunction();
    const renderer = vi.fn();
    (window as CompatibilityWindow).html2canvas = renderer;
    await expect(captureElement(elementWithSize(0, 10))).rejects.toMatchObject({
      code: 'capture-invalid-bounds',
    });
    expect(renderer).not.toHaveBeenCalled();
  });

  it('recovers after a synchronous renderer throw', async () => {
    const captureElement = installCaptureFunction();
    const secret = 'target exception text';
    const renderer = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error(secret);
      })
      .mockImplementationOnce(async () => validCanvas());
    (window as CompatibilityWindow).html2canvas = renderer;

    await expect(captureElement(elementWithSize(10, 10))).rejects.toMatchObject({
      code: 'capture-failed',
      message: 'The selected component could not be captured.',
    });
    await expect(captureElement(elementWithSize(10, 10))).resolves.toMatchObject({
      width: 2,
      height: 2,
    });
    expect(renderer).toHaveBeenCalledTimes(2);
  });

  it('releases a timed out renderer before the next capture', async () => {
    const captureElement = installCaptureFunction();
    let resolveRender: ((canvas: HTMLCanvasElement) => void) | null = null;
    const renderer = vi.fn()
      .mockImplementationOnce(() => new Promise<HTMLCanvasElement>((resolve) => {
        resolveRender = resolve;
      }))
      .mockImplementationOnce(async () => validCanvas());
    (window as CompatibilityWindow).html2canvas = renderer;

    vi.useFakeTimers();
    const first = captureElement(elementWithSize(10, 10));
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(first).rejects.toMatchObject({ code: 'capture-timeout' });
    vi.useRealTimers();
    const resolve = resolveRender as ((canvas: HTMLCanvasElement) => void) | null;
    resolve?.(validCanvas());

    await expect(captureElement(elementWithSize(10, 10))).resolves.toMatchObject({
      width: 2,
      height: 2,
    });
    expect(renderer).toHaveBeenCalledTimes(2);
  });

  it('uses one sanitized retry for modern CSS failures', async () => {
    const captureElement = installCaptureFunction();
    const renderer = vi.fn()
      .mockRejectedValueOnce(new Error('Unsupported CSS color function oklch'))
      .mockResolvedValueOnce(validCanvas());
    (window as CompatibilityWindow).html2canvas = renderer;

    await expect(captureElement(elementWithSize(10, 10))).resolves.toMatchObject({
      width: 2,
      height: 2,
    });
    expect(renderer).toHaveBeenCalledTimes(2);
    const retryOptions = renderer.mock.calls[1]?.[1] as { onclone?: unknown };
    expect(typeof retryOptions.onclone).toBe('function');
  });

  it('rejects invalid rendered dimensions', async () => {
    const captureElement = installCaptureFunction();
    (window as CompatibilityWindow).html2canvas = vi.fn(async () => validCanvas(0, 0));
    await expect(captureElement(elementWithSize(10, 10))).rejects.toMatchObject({
      code: 'capture-invalid-dimensions',
    });
  });

  it('does not expose raw renderer exception text', async () => {
    const captureElement = installCaptureFunction();
    const secret = 'private target data';
    (window as CompatibilityWindow).html2canvas = vi.fn(() => {
      throw new Error(secret);
    });
    const first = await captureElement(elementWithSize(10, 10)).catch((error: unknown) => error);
    const second = await captureElement(elementWithSize(10, 10)).catch((error: unknown) => error);
    expect(first).toMatchObject({
      code: 'capture-failed',
      message: 'The selected component could not be captured.',
    });
    expect(second).toMatchObject({
      code: 'capture-failed',
      message: 'The selected component could not be captured.',
    });
    expect(String((first as { message?: unknown }).message ?? '')).not.toContain(secret);
    expect(String((second as { message?: unknown }).message ?? '')).not.toContain(secret);
  });

  it('correlates one terminal failure and restores overlay visibility', async () => {
    const target = elementWithSize(10, 10);
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    const secret = 'target bridge exception';
    const bridge = initVeraInspectorBridge({
      appOrigin: 'http://app.test',
      captureElement: () => {
        throw new Error(secret);
      },
    });
    let connectionId = 'app-pending';
    let documentGeneration = 'app-pending';
    const dispatch = (type: string, sequence: number, payload: Record<string, unknown>, requestId: string) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          protocolVersion: 1,
          type,
          connectionId,
          documentGeneration,
          requestId,
          sequence,
          payload,
        },
        origin: 'http://app.test',
        source: window.parent,
      }));
    };
    try {
      dispatch('VERA_INSPECTOR_HELLO', 1, {}, 'hello');
      const helloAck = postMessage.mock.calls
        .map((call) => call[0] as { type?: string; requestId?: string; connectionId?: string; documentGeneration?: string })
        .find((message) => message.type === 'VERA_INSPECTOR_HELLO_ACK' && message.requestId === 'hello');
      connectionId = helloAck?.connectionId ?? connectionId;
      documentGeneration = helloAck?.documentGeneration ?? documentGeneration;
      dispatch('VERA_INSPECTOR_FREEZE', 2, { active: true }, 'freeze');
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const selectionId = postMessage.mock.calls
        .map((call) => call[0] as { type?: string; payload?: { record?: { selectionId?: string } } })
        .find((message) => message.type === 'VERA_INSPECTOR_SELECTION')?.payload?.record?.selectionId;
      expect(typeof selectionId).toBe('string');
      dispatch('VERA_INSPECTOR_CAPTURE_SELECTION', 3, { selectionId }, 'capture-request');
      await vi.waitFor(() => {
        const messages = postMessage.mock.calls
          .map((call) => call[0] as { type?: string; requestId?: string; payload?: { code?: string; message?: string } })
          .filter((message) => message.type === 'VERA_INSPECTOR_ERROR' && message.requestId === 'capture-request');
        expect(messages).toHaveLength(1);
        expect(messages[0]?.payload?.code).toBe('capture-failed');
        expect(messages[0]?.payload?.message).not.toContain(secret);
      });
      const host = document.querySelector('[data-vera-inspector="overlay-host"]') as HTMLElement | null;
      expect(host?.style.display).toBe('');
    } finally {
      bridge.destroy();
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MANUAL_VALUE,
  buildOptions,
  initialSelection,
  isManualSelection,
  pickDefaultModel,
  resolveModelValue,
} from './modelSelect.ts';
import {
  clearTagsCache,
  clearVisionCache,
  detectVisionCapability,
  listModels,
} from './client.ts';

function tagsFetch(models: Array<{ name?: string }>, ok = true) {
  return vi.fn(async () =>
    ok
      ? ({ ok: true, json: async () => ({ models }) } as unknown as Response)
      : ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTagsCache();
  clearVisionCache();
});

describe('pickDefaultModel', () => {
  it('keeps a stored value and never overwrites it', () => {
    expect(pickDefaultModel('my-model', ['a', 'b'])).toBe('my-model');
  });

  it('falls back to the first discovered model, else empty', () => {
    expect(pickDefaultModel('', ['a', 'b'])).toBe('a');
    expect(pickDefaultModel('  ', [])).toBe('');
  });
});

describe('resolveModelValue', () => {
  it('resolves list picks directly and manual via text', () => {
    expect(resolveModelValue('qwen', 'other')).toBe('qwen');
    expect(resolveModelValue(MANUAL_VALUE, '  custom:1b  ')).toBe('custom:1b');
    expect(resolveModelValue(MANUAL_VALUE, '')).toBe('');
  });

  it('flags the manual sentinel', () => {
    expect(isManualSelection(MANUAL_VALUE)).toBe(true);
    expect(isManualSelection('qwen')).toBe(false);
  });
});

describe('buildOptions/initialSelection', () => {
  it('lists discovered models plus a manual entry', () => {
    const opts = buildOptions('', ['a', 'b']);
    expect(opts.map((o) => o.value)).toEqual(['a', 'b', MANUAL_VALUE]);
    expect(initialSelection('', ['a', 'b'])).toBe('a');
  });

  it('keeps a stored value missing from the list as a saved entry', () => {
    const opts = buildOptions('old-model', ['a']);
    expect(opts.map((o) => o.value)).toEqual(['a', 'old-model', MANUAL_VALUE]);
    expect(opts[1]?.label).toContain('saved');
    expect(initialSelection('old-model', ['a'])).toBe('old-model');
  });

  it('falls back to manual when nothing is known', () => {
    expect(initialSelection('', [])).toBe(MANUAL_VALUE);
  });
});

describe('detectVisionCapability', () => {
  it('detects vision and text-only models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ capabilities: ['completion', 'vision'] }),
    } as unknown as Response)));
    await expect(detectVisionCapability('http://localhost:11434', 'vision')).resolves.toBe('yes');

    clearVisionCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ capabilities: ['completion'] }),
    } as unknown as Response)));
    await expect(detectVisionCapability('http://localhost:11434', 'text')).resolves.toBe('no');
  });

  it('returns unknown when the server omits capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    } as unknown as Response)));
    await expect(detectVisionCapability('http://localhost:11434', 'legacy')).resolves.toBe('unknown');
  });
});

describe('listModels', () => {
  it('returns discovered names', async () => {
    vi.stubGlobal('fetch', tagsFetch([{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.1' }]));
    await expect(listModels('http://localhost:11434')).resolves.toEqual([
      'qwen2.5-coder:7b',
      'llama3.1',
    ]);
  });

  it('returns an empty list when Ollama reports none', async () => {
    vi.stubGlobal('fetch', tagsFetch([]));
    await expect(listModels('http://localhost:11434')).resolves.toEqual([]);
  });

  it('throws on HTTP errors and network failure', async () => {
    vi.stubGlobal('fetch', tagsFetch([], false));
    await expect(listModels('http://localhost:11434')).rejects.toThrow(/HTTP 500/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('refused');
      }),
    );
    await expect(listModels('http://localhost:11434', { refresh: true })).rejects.toThrow();
  });

  it('caches for 30s and bypasses on refresh', async () => {
    const first = tagsFetch([{ name: 'a' }]);
    vi.stubGlobal('fetch', first);
    await listModels('http://localhost:11434');
    await listModels('http://localhost:11434');
    expect(first).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', tagsFetch([{ name: 'b' }]));
    await expect(listModels('http://localhost:11434', { refresh: true })).resolves.toEqual(['b']);
  });
});

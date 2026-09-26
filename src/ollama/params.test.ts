// Generation controls: what actually reaches Ollama, and what a stale or
// hand-edited settings blob is allowed to say.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_SETTINGS,
  GENERATION_LIMITS,
  buildChatControls,
  normalizeGenerationSettings,
} from './params.ts';

describe('normalizeGenerationSettings', () => {
  it('falls back to the recommended defaults for an empty object', () => {
    expect(normalizeGenerationSettings({})).toEqual(DEFAULT_GENERATION_SETTINGS);
  });

  it('falls back to defaults for null and non-objects', () => {
    expect(normalizeGenerationSettings(null)).toEqual(DEFAULT_GENERATION_SETTINGS);
    expect(normalizeGenerationSettings('8192')).toEqual(DEFAULT_GENERATION_SETTINGS);
  });

  it('keeps every value inside its documented range', () => {
    expect(normalizeGenerationSettings({ numCtx: 1 }).numCtx).toBe(GENERATION_LIMITS.numCtx.min);
    expect(normalizeGenerationSettings({ numCtx: 1_000_000 }).numCtx).toBe(GENERATION_LIMITS.numCtx.max);
    expect(normalizeGenerationSettings({ repeatPenalty: 0 }).repeatPenalty).toBe(1);
    expect(normalizeGenerationSettings({ repeatPenalty: 9 }).repeatPenalty).toBe(1.5);
    expect(normalizeGenerationSettings({ numPredict: 1 }).numPredict).toBe(GENERATION_LIMITS.numPredict.min);
  });

  it('rejects values that are not finite numbers', () => {
    // localStorage round-trips through JSON, and a hand-edited value can be a
    // string; neither may reach the request body.
    expect(normalizeGenerationSettings({ numCtx: '16384' }).numCtx).toBe(DEFAULT_GENERATION_SETTINGS.numCtx);
    expect(normalizeGenerationSettings({ temperature: Number.NaN }).temperature).toBe(
      DEFAULT_GENERATION_SETTINGS.temperature,
    );
    expect(normalizeGenerationSettings({ repeatLastN: Infinity }).repeatLastN).toBe(
      DEFAULT_GENERATION_SETTINGS.repeatLastN,
    );
  });

  it('rejects a think level the model API does not have', () => {
    expect(normalizeGenerationSettings({ think: 'extreme' }).think).toBe(DEFAULT_GENERATION_SETTINGS.think);
    expect(normalizeGenerationSettings({ think: 'max' }).think).toBe('max');
    expect(normalizeGenerationSettings({ think: 'off' }).think).toBe('off');
  });

  it('preserves an in-range value from storage', () => {
    const stored = {
      numCtx: 16384,
      think: 'high',
      temperature: 0.2,
      seed: 7,
      repeatPenalty: 1.2,
      repeatLastN: 256,
      numPredict: 8192,
    };
    expect(normalizeGenerationSettings(stored)).toEqual(stored);
  });
});

describe('buildChatControls', () => {
  it('sends the recommended defaults with an explicit seed', () => {
    const controls = buildChatControls(DEFAULT_GENERATION_SETTINGS);
    expect(controls).toEqual({
      think: 'low',
      options: {
        num_ctx: 8192,
        temperature: 0,
        repeat_penalty: 1.15,
        repeat_last_n: 128,
        num_predict: 4096,
        seed: 42,
      },
    });
  });

  it('turns the off level into a boolean rather than sending the word', () => {
    expect(buildChatControls({ ...DEFAULT_GENERATION_SETTINGS, think: 'off' }).think).toBe(false);
  });

  it('omits the seed entirely when it is 0 so the server is free to choose', () => {
    const controls = buildChatControls({ ...DEFAULT_GENERATION_SETTINGS, seed: 0 });
    expect(controls.options).not.toHaveProperty('seed');
  });

  it('always sends a context window above the 4096 default', () => {
    // Four screenshots plus the facts block do not fit in the server default,
    // which is why this is asserted rather than left to a comment.
    const options = buildChatControls(DEFAULT_GENERATION_SETTINGS).options;
    expect(options.num_ctx).toBeGreaterThanOrEqual(GENERATION_LIMITS.numCtx.min);
  });

  it('omits think for a model that does not support it', () => {
    // Ollama rejects a truthy think for a non-thinking model, so the field is
    // dropped instead of failing the request.
    const controls = buildChatControls(DEFAULT_GENERATION_SETTINGS, { supportsThinking: false });
    expect(controls).not.toHaveProperty('think');
  });

  it('still sends think:false to a model that does not support it', () => {
    // Turning thinking off is the truth for that model anyway, and it is the one
    // value the server accepts.
    const controls = buildChatControls(
      { ...DEFAULT_GENERATION_SETTINGS, think: 'off' },
      { supportsThinking: false },
    );
    expect(controls.think).toBe(false);
  });

  it('sends the think level when support is confirmed or unprobed', () => {
    expect(buildChatControls(DEFAULT_GENERATION_SETTINGS, { supportsThinking: true }).think).toBe('low');
    expect(buildChatControls(DEFAULT_GENERATION_SETTINGS, {}).think).toBe('low');
  });
});

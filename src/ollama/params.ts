// Generation controls sent to Ollama (§16.12).
//
// The app used to send no `options` at all, which means every request ran on
// Ollama's server defaults. Two of those defaults caused the failures recorded
// in the verification report:
//
//   - `temperature` defaults to 0.8. A 9B model sampling 200-500 tokens at
//     0.8, over 40 messages of history, disagrees with itself about whether to
//     emit a preview block. That is what made "image runs" look non
//     deterministic. The images were never the cause.
//   - `num_ctx` defaults to 4096 while the model advertises 262144. Four
//     screenshots plus a 2300-character prompt plus history overflow that
//     silently, and the overflow is where the truncated thinking came from.
//
// So every value is sent explicitly. There is no path where the app inherits a
// server default, because a server default is a number nobody in this project
// chose.
//
// Two of these defaults were later measured to be causal, and one belief about
// them turned out to be wrong:
//
//   - `temperature: 0` is what produces determinism. A fixed prompt returned
//     byte-identical text and thinking across 5 of 5 runs with it, and 5 distinct
//     answers out of 5 without it.
//   - `num_ctx` defaults to 4096. A turn with four screenshots measured 4245
//     prompt tokens, and 5235 with one earlier exchange in the history, so on a
//     default server the request does not fit at all.
//   - `seed` buys nothing at temperature 0. Seeds 43 through 46 produced the
//     identical output and the identical token count, because greedy decoding
//     never draws from the RNG. The seed is kept because it is what makes the
//     request reproducible once the temperature is raised, not because it is what
//     makes it reproducible today.
//   - `repeat_penalty` is the weakest claim here. A repetition loop that ended in
//     a 0-byte answer was observed at the server default of 1.1, and 1.15 cleared
//     43 calls over 16 payloads — but the same failure did not reproduce at 1.0
//     in a later run, and a thinking channel still repeated a paragraph 6 times
//     at 1.15. It is set above the default as cheap insurance, not as a proven
//     fix, and nothing in the product should be described otherwise.

/** Reasoning effort. `off` disables the thinking channel entirely. */
export type ThinkLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export const THINK_LEVELS: readonly ThinkLevel[] = ['off', 'low', 'medium', 'high', 'max'];

export interface GenerationSettings {
  /** Context window in tokens. */
  numCtx: number;
  think: ThinkLevel;
  temperature: number;
  /** 0 means "let the server pick", which is not reproducible. */
  seed: number;
  repeatPenalty: number;
  /** How far back the repetition penalty looks. */
  repeatLastN: number;
  /** Cap on generated tokens, thinking included. */
  numPredict: number;
}

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  numCtx: 8192,
  think: 'low',
  temperature: 0,
  seed: 42,
  repeatPenalty: 1.15,
  repeatLastN: 128,
  numPredict: 4096,
};

export interface Limit {
  min: number;
  max: number;
  step: number;
}

/** UI bounds and the clamp used to sanitize anything read from storage. */
export const GENERATION_LIMITS = {
  numCtx: { min: 8_192, max: 65_536, step: 8_192 },
  temperature: { min: 0, max: 1, step: 0.05 },
  numPredict: { min: 1_024, max: 16_384, step: 1_024 },
  seed: { min: 0, max: 2_147_483_647, step: 1 },
  repeatPenalty: { min: 1, max: 1.5, step: 0.05 },
  repeatLastN: { min: 0, max: 512, step: 16 },
} as const satisfies Record<keyof Omit<GenerationSettings, 'think'>, Limit>;

function clampNumber(value: unknown, limit: Limit, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(limit.max, Math.max(limit.min, value));
}

function clampThink(value: unknown): ThinkLevel {
  return THINK_LEVELS.includes(value as ThinkLevel) ? (value as ThinkLevel) : DEFAULT_GENERATION_SETTINGS.think;
}

/**
 * Force any partial or hand-edited value into range. Storage and the settings
 * drawer are both untrusted here: a stale localStorage entry from an older
 * build has none of these fields, and a typed value can be out of range.
 */
export function normalizeGenerationSettings(partial: unknown): GenerationSettings {
  const raw = (partial ?? {}) as Partial<Record<keyof GenerationSettings, unknown>>;
  return {
    numCtx: clampNumber(raw.numCtx, GENERATION_LIMITS.numCtx, DEFAULT_GENERATION_SETTINGS.numCtx),
    think: clampThink(raw.think),
    temperature: clampNumber(raw.temperature, GENERATION_LIMITS.temperature, DEFAULT_GENERATION_SETTINGS.temperature),
    seed: clampNumber(raw.seed, GENERATION_LIMITS.seed, DEFAULT_GENERATION_SETTINGS.seed),
    repeatPenalty: clampNumber(
      raw.repeatPenalty,
      GENERATION_LIMITS.repeatPenalty,
      DEFAULT_GENERATION_SETTINGS.repeatPenalty,
    ),
    repeatLastN: clampNumber(raw.repeatLastN, GENERATION_LIMITS.repeatLastN, DEFAULT_GENERATION_SETTINGS.repeatLastN),
    numPredict: clampNumber(raw.numPredict, GENERATION_LIMITS.numPredict, DEFAULT_GENERATION_SETTINGS.numPredict),
  };
}

/** The `options` object, as Ollama types it. */
export interface OllamaOptions {
  num_ctx: number;
  temperature: number;
  repeat_penalty: number;
  repeat_last_n: number;
  num_predict: number;
  seed?: number;
}

export interface ChatControls {
  think?: boolean | Exclude<ThinkLevel, 'off'>;
  options: OllamaOptions;
}

export interface ControlContext {
  /**
   * Whether the target model advertises the `thinking` capability. Ollama
   * rejects a truthy `think` for a model that does not have it, so the field is
   * dropped rather than allowed to fail the whole request. `undefined` means
   * "not probed yet" and is treated as supported, because the setting drawer
   * probes on open and the alternative is a request that never works.
   */
  supportsThinking?: boolean;
}

/**
 * Build the request fields. `seed` is omitted when 0 so that "let the server
 * choose" is expressible at all; every other value is always sent, so the
 * request is fully described by this repo's settings.
 */
export function buildChatControls(
  settings: GenerationSettings,
  context: ControlContext = {},
): ChatControls {
  const controls: ChatControls = {
    options: {
      num_ctx: settings.numCtx,
      temperature: settings.temperature,
      repeat_penalty: settings.repeatPenalty,
      repeat_last_n: settings.repeatLastN,
      num_predict: settings.numPredict,
    },
  };
  if (settings.seed !== 0) controls.options.seed = settings.seed;
  if (settings.think === 'off') {
    controls.think = false;
  } else if (context.supportsThinking !== false) {
    controls.think = settings.think;
  }
  return controls;
}

/** Merge stored settings with defaults without trusting either. */
export function resolveGenerationSettings(stored: unknown): GenerationSettings {
  return normalizeGenerationSettings(stored);
}

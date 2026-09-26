import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_GENERATION_SETTINGS,
  GENERATION_LIMITS,
  THINK_LEVELS,
  normalizeGenerationSettings,
} from '../ollama/params.ts';
import type { GenerationSettings, ThinkLevel } from '../ollama/params.ts';
import { detectThinkingCapability } from '../ollama/client.ts';

interface Props {
  baseUrl: string;
  model: string;
  value: GenerationSettings;
  onChange: (next: GenerationSettings) => void;
}

const THINK_LABEL: Record<ThinkLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

const k = (value: number): string => (value >= 1024 ? `${value / 1024}K` : String(value));

interface SliderProps {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function Slider({ id, label, hint, value, min, max, step, format, onChange }: SliderProps) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <span className="mono muted">{format(value)}</span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
        {hint}
      </p>
    </div>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: Omit<SliderProps, 'format'>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
        {hint}
      </p>
    </div>
  );
}

/**
 * Generation parameters sent to Ollama on every request.
 *
 * The context and reasoning controls are sliders because they are the two a
 * user tunes by feel, and both are consequential: the default 4096-token context
 * silently truncates a four-screenshot turn, and an unbounded reasoning budget
 * is what produced a 26-times-repeated paragraph followed by no answer at all.
 */
export function GenerationPanel({ baseUrl, model, value, onChange }: Props) {
  const [supportsThinking, setSupportsThinking] = useState<boolean | undefined>(undefined);
  // A ref rather than state: this is a "have I already asked" marker, so writing
  // it must not schedule a render. A state write here would also re-run the
  // effect it lives in.
  const probed = useRef<string | null>(null);

  useEffect(() => {
    const key = `${baseUrl}\n${model}`;
    if (!model || probed.current === key) return;
    probed.current = key;
    let cancelled = false;
    void detectThinkingCapability(baseUrl, model)
      .then((result) => {
        if (!cancelled) setSupportsThinking(result);
      })
      .catch(() => {
        // A probe failure must not block editing; the request path drops the
        // field on its own if the model turns out not to support it.
        if (!cancelled) setSupportsThinking(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, model]);

  // A model without a thinking channel cannot honour a level, so the stored
  // value is forced down rather than left to fail the next request.
  const thinkingOff = supportsThinking === false;
  const effective = thinkingOff ? { ...value, think: 'off' as ThinkLevel } : value;

  const update = (patch: Partial<GenerationSettings>): void => {
    onChange(normalizeGenerationSettings({ ...value, ...patch }));
  };

  return (
    <>
      <div className="drawer-subhead">Generation parameters</div>

      <div className="field">
        <label htmlFor="gen-think">
          Reasoning effort{' '}
          <span className="mono muted">{thinkingOff ? 'Off' : THINK_LABEL[value.think]}</span>
        </label>
        <select
          id="gen-think"
          value={effective.think}
          disabled={thinkingOff}
          onChange={(e) => update({ think: e.target.value as ThinkLevel })}
        >
          {THINK_LEVELS.map((level) => (
            <option key={level} value={level}>
              {THINK_LABEL[level]}
            </option>
          ))}
        </select>
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          {thinkingOff
            ? `${model} does not report a thinking capability, so the channel stays off.`
            : 'Off disables the thinking channel. Low bounds the trace, which is where a 9B model starts repeating itself.'}
        </p>
      </div>

      <Slider
        id="gen-ctx"
        label="Context window"
        hint="Ollama defaults to 4096, which four screenshots plus the measured facts overflow."
        value={value.numCtx}
        min={GENERATION_LIMITS.numCtx.min}
        max={GENERATION_LIMITS.numCtx.max}
        step={GENERATION_LIMITS.numCtx.step}
        format={k}
        onChange={(numCtx) => update({ numCtx })}
      />

      <Slider
        id="gen-temp"
        label="Temperature"
        hint="0 is deterministic: the same request produces the same answer, which is what makes a comparison a comparison."
        value={value.temperature}
        min={GENERATION_LIMITS.temperature.min}
        max={GENERATION_LIMITS.temperature.max}
        step={GENERATION_LIMITS.temperature.step}
        format={(t) => t.toFixed(2)}
        onChange={(temperature) => update({ temperature })}
      />

      <Slider
        id="gen-predict"
        label="Response cap (tokens)"
        hint="Counts the reasoning trace too, so a low cap can leave nothing to read. Raise it if an answer arrives empty."
        value={value.numPredict}
        min={GENERATION_LIMITS.numPredict.min}
        max={GENERATION_LIMITS.numPredict.max}
        step={GENERATION_LIMITS.numPredict.step}
        format={k}
        onChange={(numPredict) => update({ numPredict })}
      />

      <div className="gen-grid">
        <NumberField
          id="gen-seed"
          label="Seed"
          hint="0 lets the server choose, which is not reproducible."
          value={value.seed}
          min={GENERATION_LIMITS.seed.min}
          max={GENERATION_LIMITS.seed.max}
          step={1}
          onChange={(seed) => update({ seed })}
        />
        <NumberField
          id="gen-repeat"
          label="Repeat penalty"
          hint="Above 1 discourages a paragraph from being written twice."
          value={value.repeatPenalty}
          min={GENERATION_LIMITS.repeatPenalty.min}
          max={GENERATION_LIMITS.repeatPenalty.max}
          step={GENERATION_LIMITS.repeatPenalty.step}
          onChange={(repeatPenalty) => update({ repeatPenalty })}
        />
        <NumberField
          id="gen-repeat-n"
          label="Repeat window"
          hint="How many tokens back the penalty looks."
          value={value.repeatLastN}
          min={GENERATION_LIMITS.repeatLastN.min}
          max={GENERATION_LIMITS.repeatLastN.max}
          step={GENERATION_LIMITS.repeatLastN.step}
          onChange={(repeatLastN) => update({ repeatLastN })}
        />
      </div>

      <button
        type="button"
        className="btn small"
        onClick={() => onChange(DEFAULT_GENERATION_SETTINGS)}
      >
        Reset to recommended
      </button>
    </>
  );
}

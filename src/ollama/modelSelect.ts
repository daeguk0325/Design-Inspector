// Model-select helpers: pick-from-list-first, manual entry as fallback.
// Pure logic (tested); the drawer owns fetching + dirty tracking.

/** Sentinel select value that reveals the manual text field. */
export const MANUAL_VALUE = '__manual__';

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * Default when nothing is stored: first discovered model, else ''.
 * Never overwrites a stored value — callers apply this only when stored is empty.
 */
export function pickDefaultModel(stored: string, discovered: string[]): string {
  if (stored.trim() !== '') return stored;
  return discovered[0] ?? '';
}

/** Resolve the effective model from a select value + manual text. */
export function resolveModelValue(sel: string, manual: string): string {
  if (sel === MANUAL_VALUE) return manual.trim();
  return sel.trim();
}

function isManualSelection(sel: string): boolean {
  return sel === MANUAL_VALUE;
}

/**
 * Build dropdown options: discovered models, then the stored value if it is
 * not among them (labeled as saved), then the manual-entry sentinel.
 * The initial select value mirrors the same rule.
 */
export function buildOptions(stored: string, discovered: string[]): DropdownOption[] {
  const options: DropdownOption[] = discovered.map((name) => ({ value: name, label: name }));
  const trimmed = stored.trim();
  if (trimmed !== '' && !discovered.includes(trimmed)) {
    options.push({ value: trimmed, label: `${trimmed} (saved)` });
  }
  options.push({ value: MANUAL_VALUE, label: 'Type a name manually…' });
  return options;
}

/** Initial select value: stored (or its saved entry), else first discovered, else manual. */
export function initialSelection(stored: string, discovered: string[]): string {
  const trimmed = stored.trim();
  if (trimmed !== '') return trimmed;
  if (discovered.length > 0) return discovered[0] as string;
  return MANUAL_VALUE;
}

/**
 * `:cloud` models are served by Ollama's cloud even when the endpoint is
 * loopback, so attached images leave the machine. §9e allows the send, but it
 * is disclosed in the prompt and surfaced in the composer.
 */
export function isCloudModel(model: string): boolean {
  return model.trim().toLowerCase().endsWith(':cloud');
}

export { isManualSelection };

import { useEffect, useRef, useState } from 'react';
import { listModels, testChatCapability, normalizeBaseUrl } from '../ollama/client.ts';
import {
  buildOptions,
  isManualSelection,
  resolveModelValue,
} from '../ollama/modelSelect.ts';
import { normalizeGenerationSettings } from '../ollama/params.ts';
import type { GenerationSettings } from '../ollama/params.ts';
import { GenerationPanel } from './GenerationPanel.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  baseUrl: string;
  model: string;
  globalModel: string;
  autoCssPreview: boolean;
  generation: GenerationSettings;
  onSave: (
    baseUrl: string,
    sessionModel: string,
    globalModel: string,
    autoCssPreview: boolean,
    generation: GenerationSettings,
  ) => void;
}

type LoadState = 'loading' | 'ready' | 'empty' | 'error';
type TestState = 'idle' | 'testing' | 'ok' | 'fail';

export function SettingsDrawer({
  open,
  onClose,
  baseUrl,
  model,
  globalModel,
  autoCssPreview,
  generation,
  onSave,
}: Props) {
  const [url, setUrl] = useState(baseUrl);
  const [sessionSel, setSessionSel] = useState('');
  const [globalSel, setGlobalSel] = useState('');
  const [manualSession, setManualSession] = useState('');
  const [manualGlobal, setManualGlobal] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoPreview, setAutoPreview] = useState(autoCssPreview);
  const [gen, setGen] = useState<GenerationSettings>(generation);
  const touched = useRef({ session: false, global: false });

  async function runChatTest(base: string, candidate: string): Promise<boolean> {
    if (!candidate) return false;
    setTestState('testing');
    setTestMsg(null);
    try {
      await testChatCapability(base, candidate);
      setTestState('ok');
      return true;
    } catch (e) {
      setTestState('fail');
      setTestMsg(e instanceof Error ? e.message : 'Chat test failed.');
      return false;
    }
  }

  async function discover(
    base: string,
    storedSession: string,
    storedGlobal: string,
    refresh: boolean,
  ) {
    setLoadState('loading');
    setLoadError(null);
    setTestState('idle');
    setTestMsg(null);
    try {
      const found = await listModels(base, { refresh });
      setModels(found);
      if (found.length === 0) {
        setLoadState('empty');
        // Keep stored values selectable even with an empty list.
        if (!touched.current.session) setSessionSel(storedSession.trim());
        if (!touched.current.global) setGlobalSel(storedGlobal.trim());
        return;
      }
      setLoadState('ready');
      // Auto-apply the first model only into untouched, empty selects —
      // stored values are never overwritten.
      let nextSession = sessionSel;
      let nextGlobal = globalSel;
      if (!touched.current.session) {
        nextSession = storedSession.trim() !== '' ? storedSession.trim() : (found[0] as string);
        setSessionSel(nextSession);
      }
      if (!touched.current.global) {
        nextGlobal = storedGlobal.trim() !== '' ? storedGlobal.trim() : (found[0] as string);
        setGlobalSel(nextGlobal);
      }
      // Auto-verify chat capability for the effective session model.
      const effective =
        resolveModelValue(nextSession, '') || resolveModelValue(nextGlobal, '');
      if (effective) await runChatTest(base, effective);
    } catch (e) {
      setLoadState('error');
      setLoadError(
        e instanceof Error
          ? e.message
          : 'Cannot reach Ollama. Check that `ollama serve` is running.',
      );
      // Offline fallback: still allow picking the stored values / typing.
      if (!touched.current.session) setSessionSel(storedSession.trim());
      if (!touched.current.global) setGlobalSel(storedGlobal.trim());
    }
  }

  // Reset + auto-load whenever the drawer opens.
  useEffect(() => {
    if (!open) return;
    setUrl(baseUrl);
    setSessionSel('');
    setGlobalSel('');
    setManualSession('');
    setManualGlobal('');
    setAutoPreview(autoCssPreview);
    setGen(normalizeGenerationSettings(generation));
    setModels([]);
    setTestMsg(null);
    touched.current = { session: false, global: false };
    void discover(baseUrl, model, globalModel, false);
    // Props are captured at open time; later edits live in local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  if (!open) return null;

  const sessionOptions = buildOptions(model, models);
  const globalOptions = buildOptions(globalModel, models);
  const effSession = resolveModelValue(sessionSel, manualSession);
  const effGlobal = resolveModelValue(globalSel, manualGlobal);

  async function manualTest() {
    const candidate = effSession || effGlobal;
    if (!candidate || busy) return;
    setBusy(true);
    await runChatTest(url, candidate);
    setBusy(false);
  }

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" aria-label="Ollama settings">
        <div className="drawer-head">
          <span style={{ flex: 1 }}>Ollama settings</span>
          <button type="button" className="iconbtn" aria-label="Close settings" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body">
          <div className="field">
            <label htmlFor="ollama-url">Ollama base URL (direct browser fetch)</label>
            <input id="ollama-url" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:11434" />
            <p className="muted" style={{ fontSize: 12 }}>
              Browser calls Ollama directly. If blocked by CORS, restart Ollama with{' '}
              <span className="mono">OLLAMA_ORIGINS=http://127.0.0.1:5173</span>.
            </p>
          </div>

          {loadState === 'loading' && <p className="muted">Loading installed models…</p>}

          {loadState === 'error' && (
            <div role="alert">
              <p className="status-note err">
                {loadError ?? 'Cannot reach Ollama. Check that `ollama serve` is running.'}
              </p>
              <button
                type="button"
                className="btn small"
                onClick={() => void discover(url, model, globalModel, true)}
              >
                Retry
              </button>
            </div>
          )}

          {loadState === 'empty' && (
            <div>
              <p className="muted">
                No models installed. Run <span className="mono">ollama pull &lt;name&gt;</span>,
                then retry.
              </p>
              <button
                type="button"
                className="btn small"
                onClick={() => void discover(url, model, globalModel, true)}
              >
                Retry
              </button>
            </div>
          )}

          {loadState === 'ready' && (
            <p className="muted">
              {models.length} installed model{models.length === 1 ? '' : 's'}{' '}
              <button
                type="button"
                className="mini"
                title="Refresh model list"
                onClick={() => void discover(url, model, globalModel, true)}
              >
                ↻ Refresh
              </button>
            </p>
          )}

          <div className="field">
            <label htmlFor="sess-model">This session&apos;s model</label>
            <select
              id="sess-model"
              value={sessionSel}
              disabled={loadState === 'loading'}
              onChange={(e) => {
                touched.current.session = true;
                setSessionSel(e.target.value);
              }}
            >
              {sessionSel === '' && <option value="">Select a model…</option>}
              {sessionOptions.map((o) => (
                <option key={`s-${o.value}`} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {isManualSelection(sessionSel) && (
              <input
                aria-label="Type model name manually"
                value={manualSession}
                spellCheck={false}
                onChange={(e) => setManualSession(e.target.value)}
                placeholder="e.g. qwen2.5-coder:7b"
                style={{ marginTop: 6 }}
              />
            )}
          </div>

          <div className="field">
            <label htmlFor="global-model">Default for new sessions</label>
            <select
              id="global-model"
              value={globalSel}
              disabled={loadState === 'loading'}
              onChange={(e) => {
                touched.current.global = true;
                setGlobalSel(e.target.value);
              }}
            >
              {globalSel === '' && <option value="">Select a model…</option>}
              {globalOptions.map((o) => (
                <option key={`g-${o.value}`} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {isManualSelection(globalSel) && (
              <input
                aria-label="Type default model name manually"
                value={manualGlobal}
                spellCheck={false}
                onChange={(e) => setManualGlobal(e.target.value)}
                placeholder="(same as above)"
                style={{ marginTop: 6 }}
              />
            )}
          </div>

          {testState === 'testing' && <p className="muted">Checking chat capability…</p>}
          {testState === 'ok' && <p className="muted">✓ Chat ready — /api/chat answered.</p>}
          {testState === 'fail' && testMsg && <p className="status-note err">{testMsg}</p>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn small"
              disabled={busy || testState === 'testing' || !(effSession || effGlobal)}
              onClick={() => void manualTest()}
            >
              Test chat capability
            </button>
          </div>

          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoPreview}
              onChange={(event) => setAutoPreview(event.target.checked)}
            />
            <span>Automatically apply validated CSS previews</span>
          </label>

          <GenerationPanel
            baseUrl={url}
            model={effSession || effGlobal}
            value={gen}
            onChange={setGen}
          />

          <div>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onSave(
                  normalizeBaseUrl(url) || 'http://localhost:11434',
                  effSession,
                  effGlobal,
                  autoPreview,
                  gen,
                );
                onClose();
              }}
            >
              Save
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Precedence: the global default applies to newly created sessions only; each
            session keeps its own model. An empty first choice is filled with the
            first installed model automatically.
          </p>
        </div>
      </aside>
    </>
  );
}

// Versioned localStorage persistence (§15). Schema v2 with v1 migration,
// quota/write-failure handling, malformed-state recovery, explicit multi-tab policy.

import type {
  AssistantStatus,
  ChatMessage,
  CitationSnapshot,
  InspectorSession,
  PersistedShape,
} from '../state/models.ts';
import { isDesignDecision, sanitizePreviewTransactions } from '../preview/transaction.ts';
import { normalizeGenerationSettings, DEFAULT_GENERATION_SETTINGS } from '../ollama/params.ts';
import type { GenerationSettings } from '../ollama/params.ts';

export const DEFAULT_GENERATION = DEFAULT_GENERATION_SETTINGS;

export const STORAGE_KEY = 'design-inspector/v1';
export const SCHEMA_VERSION = 2;

/** Multi-tab policy: last-write-wins, no cross-tab merge; each tab reconciles
 *  live selections against the Bridge snapshot on focus/handshake (§15.4). */
export const MULTI_TAB_POLICY = 'last-write-wins' as const;

interface Envelope {
  version: number;
  data: PersistedShape;
}

export interface LoadResult {
  shape: PersistedShape;
  migrated: boolean;
  recoveredFromCorruption: boolean;
}

export function emptyShape(): PersistedShape {
  return { sessions: [], currentSessionId: null };
}

const ASSISTANT_STATUSES: ReadonlySet<string> = new Set([
  'streaming',
  'completed',
  'interrupted',
  'error',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function normalizeStatus(raw: unknown): AssistantStatus {
  if (raw === 'streaming') return 'interrupted';
  return typeof raw === 'string' && ASSISTANT_STATUSES.has(raw)
    ? (raw as AssistantStatus)
    : 'completed';
}

function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!isPlainObject(raw)) return null;
  const role: ChatMessage['role'] = raw['role'] === 'assistant' ? 'assistant' : 'user';
  // `pinned`/`pinnedAt` are read from storage and dropped: sessions saved before
  // pins were removed still carry them, and an unknown key must not resurrect
  // the field.
  const message: ChatMessage = {
    id: asString(raw['id']),
    role,
    content: asString(raw['content']),
    citations: Array.isArray(raw['citations']) ? (raw['citations'] as CitationSnapshot[]) : [],
    createdAt: asNumber(raw['createdAt']),
  };
  if (role === 'assistant') message.status = normalizeStatus(raw['status']);
  if (isDesignDecision(raw['decision'])) message.decision = raw['decision'];
  const previewTransactionId = raw['previewTransactionId'];
  if (typeof previewTransactionId === 'string') message.previewTransactionId = previewTransactionId;
  return message;
}

function normalizeSession(raw: unknown, fromV1: boolean): InspectorSession | null {
  if (!isPlainObject(raw)) return null;
  const messages: ChatMessage[] = [];
  const rawMessages = raw['messages'];
  if (Array.isArray(rawMessages)) {
    for (const item of rawMessages) {
      const message = normalizeMessage(item);
      if (message !== null) messages.push(message);
    }
  }
  return {
    id: asString(raw['id']),
    title: asString(raw['title']),
    targetUrl: asString(raw['targetUrl']),
    model: asString(raw['model']),
    messages,
    previewTransactions: fromV1 ? [] : sanitizePreviewTransactions(raw['previewTransactions']),
    persistedActiveSelectionIds: asStringArray(raw['persistedActiveSelectionIds']),
    createdAt: asNumber(raw['createdAt']),
    updatedAt: asNumber(raw['updatedAt']),
  };
}

function normalizeShape(raw: unknown, fromV1: boolean): PersistedShape {
  const sessions: InspectorSession[] = [];
  const rawSessions = isPlainObject(raw) ? raw['sessions'] : undefined;
  if (Array.isArray(rawSessions)) {
    for (const item of rawSessions) {
      const session = normalizeSession(item, fromV1);
      if (session !== null) sessions.push(session);
    }
  }
  const rawCurrent = isPlainObject(raw) ? raw['currentSessionId'] : undefined;
  const currentSessionId =
    typeof rawCurrent === 'string' && sessions.some((session) => session.id === rawCurrent)
      ? rawCurrent
      : (sessions[0]?.id ?? null);
  return { sessions, currentSessionId };
}

function isValidShape(s: unknown): s is PersistedShape {
  return isPlainObject(s) && Array.isArray(s['sessions']);
}

function migrate(old: unknown): PersistedShape {
  return normalizeShape(old, true);
}

export function loadPersisted(): LoadResult {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { shape: emptyShape(), migrated: false, recoveredFromCorruption: false };
    const parsed = JSON.parse(raw) as unknown;
    if (isPlainObject(parsed) && 'version' in parsed && 'data' in parsed) {
      const version = parsed['version'];
      const data = parsed['data'];
      if (!isValidShape(data)) {
        return { shape: emptyShape(), migrated: false, recoveredFromCorruption: true };
      }
      if (version === SCHEMA_VERSION) {
        return {
          shape: normalizeShape(data, false),
          migrated: false,
          recoveredFromCorruption: false,
        };
      }
      if (typeof version === 'number' && version < SCHEMA_VERSION) {
        return { shape: migrate(data), migrated: true, recoveredFromCorruption: false };
      }
      return { shape: emptyShape(), migrated: false, recoveredFromCorruption: true };
    }
    if (isValidShape(parsed)) {
      return { shape: migrate(parsed), migrated: true, recoveredFromCorruption: false };
    }
    return { shape: emptyShape(), migrated: false, recoveredFromCorruption: true };
  } catch {
    return { shape: emptyShape(), migrated: false, recoveredFromCorruption: true };
  }
}

export type SaveOutcome = 'ok' | 'quota-exceeded' | 'failed';

export function savePersisted(shape: PersistedShape): SaveOutcome {
  try {
    const env: Envelope = { version: SCHEMA_VERSION, data: shape };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
    return 'ok';
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
      return 'quota-exceeded';
    }
    return 'failed';
  }
}

export const SETTINGS_KEY = 'design-inspector/settings-v1';

export interface SettingsShape {
  ollamaBaseUrl: string;
  globalModel: string;
  autoCssPreview: boolean;
  generation: GenerationSettings;
}

function normalizeSettings(p: Partial<SettingsShape> | null | undefined): SettingsShape {
  return {
    ollamaBaseUrl:
      typeof p?.ollamaBaseUrl === 'string' && p.ollamaBaseUrl
        ? p.ollamaBaseUrl
        : 'http://localhost:11434',
    globalModel: typeof p?.globalModel === 'string' ? p.globalModel : '',
    autoCssPreview: typeof p?.autoCssPreview === 'boolean' ? p.autoCssPreview : true,
    // A settings blob written by an older build has no `generation` at all, and
    // one edited by hand can hold anything. The clamp lives in the params module
    // so the request path and the storage path agree on what is legal.
    generation: normalizeGenerationSettings(p?.generation),
  };
}

export function loadSettings(): SettingsShape {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return normalizeSettings(JSON.parse(raw) as Partial<SettingsShape>);
    }
  } catch {
    // fall through to defaults
  }
  return normalizeSettings(undefined);
}

export function saveSettings(s: SettingsShape): SaveOutcome {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(s)));
    return 'ok';
  } catch {
    return 'failed';
  }
}

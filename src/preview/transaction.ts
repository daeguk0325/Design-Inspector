import { validateDeclarations } from './cssPolicy.ts';
import {
  MAX_PREVIEW_TARGET,
  MAX_PREVIEW_TEXT_CHARS,
  PREVIEW_ELEMENT_OPS,
  PREVIEW_TEXT_OPS,
} from './contract.ts';
import type { PreviewElementOp, PreviewTextOp } from './contract.ts';

export type PreviewRuntimeStatus =
  | 'pending-rebind'
  | 'applied'
  /**
   * Some anchors applied and some did not. The Bridge reports one status for a
   * whole transaction, so this is the App's name for the case the Bridge cannot
   * express: a 10-rule transaction where 9 elements changed and one anchor no
   * longer resolves. It stays `enabled`, because the Bridge is holding a live
   * layer and both undo and reset have to be able to reach it.
   */
  | 'partial'
  | 'unbound'
  | 'ambiguous'
  | 'rejected'
  | 'undone'
  | 'reset'
  | 'stale-binding';

/** Accept keeps the applied change; Reject rolls it back. There is no third state. */
export type DesignDecision = 'accepted' | 'rejected';

/**
 * What created a transaction. Optional on disk and defaulted on read, because
 * requiring it would make every session persisted before this field existed fail
 * the strict parser and be silently dropped — losing preview history rather than
 * a feature. `themeId`/`presetId` are attributes of a `design` transaction, not
 * producers of their own.
 */
export type PreviewProducer = { kind: 'chat' | 'design' };

export const PREVIEW_RUNTIME_STATUSES: readonly PreviewRuntimeStatus[] = Object.freeze([
  'pending-rebind',
  'applied',
  'partial',
  'unbound',
  'ambiguous',
  'rejected',
  'undone',
  'reset',
  'stale-binding',
]);

export const PREVIEW_PRODUCER_KINDS: readonly PreviewProducer['kind'][] = Object.freeze([
  'chat',
  'design',
]);

/** The producer a transaction without a readable one is recorded as. */
export const DEFAULT_PREVIEW_PRODUCER: PreviewProducer = Object.freeze({ kind: 'chat' });

export const DESIGN_DECISIONS: readonly DesignDecision[] = Object.freeze([
  'accepted',
  'rejected',
]);

export interface PreviewAnchor {
  elementKey: string;
  routeKey: string;
  mode: 'html';
  tagName: string;
  id: string;
  testId: string;
  path: string;
}

export interface PreviewDeclarationRecord {
  target: number;
  anchor: PreviewAnchor;
  /** Always present. Empty when the record carries only a text or element op. */
  declarations: Record<string, string>;
  /** 'clear' removes the element's own text. */
  text?: PreviewTextOp;
  /** Replaces the element's own text. */
  replaceText?: string;
  /** 'hide' leaves the DOM alone, 'remove' detaches the element from it. */
  element?: PreviewElementOp;
}

export type PreviewChangeRecord = PreviewDeclarationRecord;

export interface PreviewTransaction {
  id: string;
  assistantId: string;
  userMessageId: string;
  sessionId: string;
  targetUrl: string;
  routeKey: string;
  changes: PreviewChangeRecord[];
  enabled: boolean;
  status: PreviewRuntimeStatus;
  /** Present on every transaction written after the field existed; read as `chat` when absent. */
  producer?: PreviewProducer;
  /** Anchors that applied, when the transaction landed `partial`. */
  appliedChanges?: number;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

const MAX_ID_CHARS = 256;
const MAX_TAG_CHARS = 64;
const MAX_URL_CHARS = 2_048;
const MAX_PATH_CHARS = 1_024;
const MAX_ERROR_CODE_CHARS = 64;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

/**
 * Anchors one transaction may carry.
 *
 * This used to be `MAX_PREVIEW_RULES` aliased, which conflated two limits that
 * happen to both be 12. They are separate because they now disagree by design:
 * a model-authored block stays capped small, because the sidecar discards the
 * whole block when any single rule is invalid, so raising this would raise the
 * loss surface of one bad rule twentyfold. A transaction, on the other hand, is
 * also what a design theme is, and a theme is one atomic unit — capping it at 12
 * forced a 200-component theme into 17 layers, past the Bridge's 16-layer
 * per-binding budget, so it would have been trimmed away silently.
 *
 * Mirrors the Bridge's `PREVIEW_MAX_CHANGES`, which validates independently.
 * The duplication between the two is the trust boundary, same as the CSS
 * allowlists: `src/preview/cssPolicy.ts` says so for its own pair.
 */
export const MAX_TRANSACTION_CHANGES = 256;

const ANCHOR_KEYS = new Set([
  'elementKey',
  'routeKey',
  'mode',
  'tagName',
  'id',
  'testId',
  'path',
]);
const CHANGE_KEYS = new Set(['target', 'anchor', 'declarations', 'text', 'replaceText', 'element']);
const TRANSACTION_KEYS = new Set([
  'id',
  'assistantId',
  'userMessageId',
  'sessionId',
  'targetUrl',
  'routeKey',
  'changes',
  'enabled',
  'status',
  'producer',
  'appliedChanges',
  'errorCode',
  'createdAt',
  'updatedAt',
]);
const PRODUCER_KEYS = new Set(['kind']);

const STATUS_SET: ReadonlySet<string> = new Set(PREVIEW_RUNTIME_STATUSES);
const DECISION_SET: ReadonlySet<string> = new Set(DESIGN_DECISIONS);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
};

const reqStr = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

const optStr = (value: unknown, max: number): string | null => {
  if (value === undefined) return '';
  return typeof value === 'string' && value.length <= max ? value : null;
};

const reqInt = (value: unknown, min: number, max: number): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= min && floored <= max ? floored : null;
};

const optInt = (value: unknown, min: number, max: number, fallback: number): number | null =>
  value === undefined ? fallback : reqInt(value, min, max);

export const isPreviewRuntimeStatus = (value: unknown): value is PreviewRuntimeStatus =>
  typeof value === 'string' && STATUS_SET.has(value);

export const isDesignDecision = (value: unknown): value is DesignDecision =>
  typeof value === 'string' && DECISION_SET.has(value);

const PRODUCER_KIND_SET: ReadonlySet<string> = new Set(PREVIEW_PRODUCER_KINDS);

/**
 * A producer is read leniently on purpose.
 *
 * Every other field here is strict: a transaction with a bad one is dropped, and
 * `sanitizePreviewTransactions` discards rather than failing. That is the right
 * call for a corrupt anchor or a bad timestamp, but it is the wrong call here.
 * The alternative — making `producer` a required key — routes every session
 * persisted before the field existed through the strict parser, fails on the
 * missing key, and deletes the user's entire preview history with no error and
 * no migration counter.
 *
 * So an absent producer, or one that does not parse, is recorded as `chat`,
 * which is what every existing transaction actually was. Keeping a transaction
 * whose provenance is merely unknown beats losing it.
 */
export function parsePreviewProducer(raw: unknown): PreviewProducer {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, PRODUCER_KEYS)) return DEFAULT_PREVIEW_PRODUCER;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !PRODUCER_KIND_SET.has(kind)) return DEFAULT_PREVIEW_PRODUCER;
  return { kind: kind as PreviewProducer['kind'] };
}

export function parsePreviewAnchor(raw: unknown): PreviewAnchor | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ANCHOR_KEYS)) return null;
  if (raw['mode'] !== 'html') return null;
  const elementKey = reqStr(raw['elementKey'], MAX_ID_CHARS);
  const routeKey = reqStr(raw['routeKey'], MAX_ID_CHARS);
  const tagName = reqStr(raw['tagName'], MAX_TAG_CHARS);
  if (elementKey === null || routeKey === null || tagName === null) return null;
  const id = optStr(raw['id'], MAX_ID_CHARS);
  const testId = optStr(raw['testId'], MAX_ID_CHARS);
  const path = optStr(raw['path'], MAX_PATH_CHARS);
  if (id === null || testId === null || path === null) return null;
  return { elementKey, routeKey, mode: 'html', tagName, id, testId, path };
}

export function parsePreviewChange(raw: unknown): PreviewChangeRecord | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, CHANGE_KEYS)) return null;
  const target = reqInt(raw['target'], 1, MAX_PREVIEW_TARGET);
  if (target === null) return null;
  const anchor = parsePreviewAnchor(raw['anchor']);
  if (anchor === null) return null;

  // `declarations` is always stored, even when the record carries only a text
  // or element op, so nothing downstream has to special-case the empty case.
  const rawDeclarations = raw['declarations'];
  const check = rawDeclarations === undefined
    ? { ok: true as const, declarations: Object.freeze({} as Record<string, string>) }
    : validateDeclarations(rawDeclarations);
  if (!check.ok) return null;
  const declarations: Record<string, string> = {};
  for (const [property, value] of Object.entries(check.declarations)) {
    declarations[property] = value;
  }

  const text = raw['text'];
  if (text !== undefined && !PREVIEW_TEXT_OPS.includes(text as PreviewTextOp)) return null;
  const element = raw['element'];
  if (element !== undefined && !PREVIEW_ELEMENT_OPS.includes(element as PreviewElementOp)) return null;
  const replaceText = raw['replaceText'];
  if (replaceText !== undefined) {
    if (text !== undefined) return null;
    if (typeof replaceText !== 'string' || replaceText.length > MAX_PREVIEW_TEXT_CHARS) return null;
  }
  if (
    Object.keys(declarations).length === 0 &&
    text === undefined &&
    element === undefined &&
    replaceText === undefined
  ) {
    return null;
  }

  const record: PreviewChangeRecord = { target, anchor, declarations };
  if (text !== undefined) record.text = text as PreviewTextOp;
  if (element !== undefined) record.element = element as PreviewElementOp;
  if (typeof replaceText === 'string') record.replaceText = replaceText;
  return record;
}

export function parsePreviewTransaction(raw: unknown): PreviewTransaction | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, TRANSACTION_KEYS)) return null;
  const id = reqStr(raw['id'], MAX_ID_CHARS);
  const assistantId = reqStr(raw['assistantId'], MAX_ID_CHARS);
  const userMessageId = reqStr(raw['userMessageId'], MAX_ID_CHARS);
  const sessionId = reqStr(raw['sessionId'], MAX_ID_CHARS);
  if (id === null || assistantId === null || userMessageId === null || sessionId === null) {
    return null;
  }
  const targetUrl = optStr(raw['targetUrl'], MAX_URL_CHARS);
  const routeKey = optStr(raw['routeKey'], MAX_ID_CHARS);
  if (targetUrl === null || routeKey === null) return null;
  const rawChanges = raw['changes'];
  if (!Array.isArray(rawChanges) || rawChanges.length > MAX_TRANSACTION_CHANGES) return null;
  const changes: PreviewChangeRecord[] = [];
  for (const item of rawChanges) {
    const change = parsePreviewChange(item);
    if (change === null) return null;
    changes.push(change);
  }
  const rawEnabled = raw['enabled'];
  const enabled =
    rawEnabled === undefined ? false : typeof rawEnabled === 'boolean' ? rawEnabled : null;
  if (enabled === null) return null;
  const status = raw['status'];
  if (!isPreviewRuntimeStatus(status)) return null;
  let errorCode: string | undefined;
  if (raw['errorCode'] !== undefined) {
    const parsedCode = reqStr(raw['errorCode'], MAX_ERROR_CODE_CHARS);
    if (parsedCode === null) return null;
    errorCode = parsedCode;
  }
  const createdAt = optInt(raw['createdAt'], 0, MAX_TIMESTAMP, 0);
  const updatedAt = optInt(raw['updatedAt'], 0, MAX_TIMESTAMP, 0);
  if (createdAt === null || updatedAt === null) return null;
  const transaction: PreviewTransaction = {
    id,
    assistantId,
    userMessageId,
    sessionId,
    targetUrl,
    routeKey,
    changes,
    enabled,
    status,
    producer: parsePreviewProducer(raw['producer']),
    createdAt,
    updatedAt,
  };
  const appliedChanges = optInt(raw['appliedChanges'], 0, MAX_TRANSACTION_CHANGES, 0);
  if (appliedChanges === null) return null;
  if (raw['appliedChanges'] !== undefined) transaction.appliedChanges = appliedChanges;
  if (errorCode !== undefined) transaction.errorCode = errorCode;
  return transaction;
}

export interface SanitizedTransactions {
  accepted: PreviewTransaction[];
  /** Items the strict parser rejected. Surfaced so silent history loss is visible. */
  dropped: number;
}

/**
 * Returns the accepted transactions *and* how many were dropped.
 *
 * The count matters because the alternative is invisible: a schema change that
 * makes an older record unparseable does not fail the load, it just quietly
 * shortens the session's history, and nothing anywhere says so.
 */
export function sanitizePreviewTransactions(input: unknown): SanitizedTransactions {
  if (!Array.isArray(input)) return { accepted: [], dropped: 0 };
  const accepted: PreviewTransaction[] = [];
  let dropped = 0;
  for (const item of input) {
    const transaction = parsePreviewTransaction(item);
    if (transaction !== null) accepted.push(transaction);
    else dropped += 1;
  }
  return { accepted, dropped };
}

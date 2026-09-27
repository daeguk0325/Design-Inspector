import { validateDeclarations } from './cssPolicy.ts';
import {
  MAX_PREVIEW_RULES,
  MAX_PREVIEW_TARGET,
  MAX_PREVIEW_TEXT_CHARS,
  PREVIEW_ELEMENT_OPS,
  PREVIEW_TEXT_OPS,
} from './contract.ts';
import type { PreviewElementOp, PreviewTextOp } from './contract.ts';

export type PreviewRuntimeStatus =
  | 'pending-rebind'
  | 'applied'
  | 'unbound'
  | 'ambiguous'
  | 'rejected'
  | 'undone'
  | 'reset'
  | 'stale-binding';

/** Accept keeps the applied change; Reject rolls it back. There is no third state. */
export type DesignDecision = 'accepted' | 'rejected';

export const PREVIEW_RUNTIME_STATUSES: readonly PreviewRuntimeStatus[] = Object.freeze([
  'pending-rebind',
  'applied',
  'unbound',
  'ambiguous',
  'rejected',
  'undone',
  'reset',
  'stale-binding',
]);

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
const MAX_TRANSACTION_CHANGES = MAX_PREVIEW_RULES;

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
  'errorCode',
  'createdAt',
  'updatedAt',
]);

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
    createdAt,
    updatedAt,
  };
  if (errorCode !== undefined) transaction.errorCode = errorCode;
  return transaction;
}

export function sanitizePreviewTransactions(input: unknown): PreviewTransaction[] {
  if (!Array.isArray(input)) return [];
  const accepted: PreviewTransaction[] = [];
  for (const item of input) {
    const transaction = parsePreviewTransaction(item);
    if (transaction !== null) accepted.push(transaction);
  }
  return accepted;
}

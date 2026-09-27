// Deterministic `Copy for Agent` export (§19). No AI call.
// Inputs: latest raw user request + reconciled active citations + a fixed
// template. Stable serialization of `extra`.
//
// Pin-based constraints are gone: the session's accepted changes are the
// durable record now, and they are exported through the change log instead.
//
// One thing the change log does not reach: this export. A preview mutates the
// live page and the clipboard says nothing about it, so an agent handed this
// text rebuilds a page that differs from the one the user is looking at, with
// no way to know that. `producer` is what makes the question answerable at all
// — without it there is no way to ask which live changes this export omits.

import type { SelectionRecord } from '../protocol/types.ts';
import { latestUserRequest } from '../state/models.ts';
import { sortByFirstAdded } from '../state/reconcile.ts';
import type { InspectorSession } from '../state/models.ts';
import type { PreviewTransaction } from '../preview/transaction.ts';

export const EXPORT_LINE_ENDING = '\n';

/** The most transactions the disclosure will enumerate; the rest are counted. */
const EXPORT_MAX_LISTED_PREVIEWS = 12;

function formatLocation(r: SelectionRecord): string {
  if (r.file !== null && r.line !== null) return `${r.file}:${r.line}`;
  if (r.file !== null) return r.file;
  return '(location unavailable — see integration checklist for metadata setup)';
}

/**
 * Transactions whose mutations are on the page right now.
 *
 * `enabled` is the local record of the intent and the status is what the target
 * last reported, so both have to hold: a transaction that claims to be applied
 * while disabled was never re-asserted. `undone`, `reset` and `stale-binding`
 * are off the page by definition and are not listed.
 */
export function livePreviewTransactions(session: InspectorSession): PreviewTransaction[] {
  return session.previewTransactions.filter(
    (transaction) =>
      transaction.enabled &&
      (transaction.status === 'applied' ||
        transaction.status === 'partial' ||
        transaction.status === 'unbound' ||
        transaction.status === 'ambiguous' ||
        transaction.status === 'pending-rebind'),
  );
}

function describeChange(change: PreviewTransaction['changes'][number]): string {
  const ops: string[] = [];
  if (Object.keys(change.declarations).length > 0) {
    const decls = Object.entries(change.declarations)
      .map(([property, value]) => `${property}: ${value}`)
      .join('; ');
    ops.push(decls);
  }
  if (change.text !== undefined) ops.push(`text: ${change.text}`);
  if (change.replaceText !== undefined) ops.push(`replaceText: ${JSON.stringify(change.replaceText)}`);
  if (change.element !== undefined) ops.push(`element: ${change.element}`);
  if (ops.length === 0) return '(no operation)';
  return ops.join(' | ');
}

export interface ExportInput {
  session: InspectorSession;
  /** Reconciled, deduped, currently-active live citations only. */
  active: SelectionRecord[];
}

export function buildAgentPrompt(input: ExportInput): string {
  const request = latestUserRequest(input.session);
  const seen = new Set<string>();
  const deduped = input.session
    ? sortByFirstAdded(input.active.filter((r) => {
        if (r.state !== 'active') return false;
        if (seen.has(r.selectionId)) return false;
        seen.add(r.selectionId);
        return true;
      }))
    : [];
  const live = livePreviewTransactions(input.session);

  const L = EXPORT_LINE_ENDING;
  const out: string[] = [];
  out.push('# Coding Agent Task', '');
  out.push('## Request', request === '' ? '(no request typed yet)' : request, '');
  out.push('## Components');
  if (deduped.length === 0) {
    out.push('(no active selections)', '');
  } else {
    deduped.forEach((r, i) => {
      const n = i + 1;
      out.push(
        `${n}. ${r.component ?? '(unknown component)'} — ${formatLocation(r)}`,
        `   - selectionId: ${r.selectionId}`,
        `   - elementKey: ${r.elementKey}`,
        `   - mode: ${r.mode}`,
        `   - extra: ${stableStringify(r.extra ?? null)}`,
      );
    });
    out.push('');
  }
  if (live.length > 0) {
    out.push('## Live preview — NOT described above');
    out.push(
      'The page this task was written against has runtime-only DOM mutations on it that',
      'this export does not otherwise carry. They are not in the target project\'s source',
      'and there is no file-diff path, so implementing the request above reproduces the',
      'page as it was BEFORE these. Confirm whether they should be kept.',
      '',
    );
    live.slice(0, EXPORT_MAX_LISTED_PREVIEWS).forEach((transaction, i) => {
      const n = i + 1;
      out.push(`${n}. ${transaction.producer?.kind ?? 'chat'} · ${transaction.status}`, `   - elementKey: ${transaction.changes.map((change) => change.anchor.elementKey).join(', ')}`);
      transaction.changes.slice(0, 8).forEach((change) => {
        out.push(`     · ${describeChange(change)}`);
      });
      if (transaction.changes.length > 8) {
        out.push(`     · …+${transaction.changes.length - 8} more`);
      }
    });
    if (live.length > EXPORT_MAX_LISTED_PREVIEWS) {
      out.push(`…+${live.length - EXPORT_MAX_LISTED_PREVIEWS} more transactions`);
    }
    out.push('');
  }
  // Deterministic trailing newline: exactly one.
  return out.join(L).replace(/\n+$/, '\n');
}

function stableStringify(value: unknown, maxLen = 300): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') {
    const s = value.length > maxLen ? value.slice(0, maxLen) + '…' : value;
    return JSON.stringify(s);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((v) => stableStringify(v, maxLen));
    const suffix = value.length > 8 ? `, …+${value.length - 8} more` : '';
    return `[${items.join(', ')}${suffix}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 12)
      .map(([k, v]) => `${JSON.stringify(k)}: ${stableStringify(v, maxLen)}`);
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}


export function buildRawTranscript(session: InspectorSession): string {
  const L = EXPORT_LINE_ENDING;
  const lines: string[] = [`# Transcript — ${session.title}`, ''];
  for (const m of session.messages) {
    lines.push(`### ${m.role}`);
    lines.push(m.content);
    if (m.citations.length > 0) {
      lines.push('');
      for (const c of m.citations) {
        lines.push(
          `- [citation ${c.displayNumber}] ${c.component ?? '(unknown)'} ${c.file ?? ''}${c.line !== null && c.file ? `:${c.line}` : ''} (${c.mode}, ${c.selectionId})`,
        );
      }
    }
    lines.push('');
  }
  return lines.join(L).replace(/\n+$/, '\n');
}

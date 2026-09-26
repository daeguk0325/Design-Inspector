// Deterministic `Copy for Agent` export (§19). No AI call.
// Inputs: latest raw user request + reconciled active citations + a fixed
// template. Stable serialization of `extra`.
//
// Pin-based constraints are gone: the session's accepted changes are the
// durable record now, and they are exported through the change log instead.

import type { SelectionRecord } from '../protocol/types.ts';
import { latestUserRequest } from '../state/models.ts';
import { sortByFirstAdded } from '../state/reconcile.ts';
import type { InspectorSession } from '../state/models.ts';

export const EXPORT_LINE_ENDING = '\n';

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

function formatLocation(r: SelectionRecord): string {
  if (r.file !== null && r.line !== null) return `${r.file}:${r.line}`;
  if (r.file !== null) return r.file;
  return '(location unavailable — see integration checklist for metadata setup)';
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
  // Deterministic trailing newline: exactly one.
  return out.join(L).replace(/\n+$/, '\n');
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

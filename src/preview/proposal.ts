/**
 * Proposal state machine.
 *
 * The product is a preview-first editor: a model answer that carries a preview
 * block is a *proposal*, and it stays provisional until the user decides.
 *
 *   applied + undecided        -> pending  (the next send settles it as rejected)
 *   user pressed Accept        -> accepted (preview stays applied)
 *   user pressed Reject        -> rejected (preview is rolled back)
 *
 * Every applied change is therefore opt-in. Sending the next message is itself
 * a decision, and the design says an undecided proposal is not a decision the
 * user meant to keep.
 *
 * This module is pure: it derives the state from the session and formats lines
 * for the prompt, the change-log panel and the proposal document. Nothing here
 * touches the bridge or mutates a session.
 */

import type { CitationSnapshot, ChatMessage, InspectorSession } from '../state/models.ts';
import type { PreviewChangeRecord, PreviewTransaction } from './transaction.ts';

export type ProposalState = 'pending' | 'accepted' | 'rejected';

export const PROPOSAL_STATES: readonly ProposalState[] = Object.freeze([
  'pending',
  'accepted',
  'rejected',
]);

/** One line per change, and a cap so a wide proposal cannot flood the prompt. */
export const MAX_CHANGES_PER_PROPOSAL = 12;
export const MAX_CHANGE_LINE_CHARS = 160;
export const MAX_DECISION_LINES = 24;
export const MAX_CHANGE_LOG_ENTRIES = 400;

export interface Proposal {
  messageId: string;
  transactionId: string;
  state: ProposalState;
  changes: readonly PreviewChangeRecord[];
  citations: readonly CitationSnapshot[];
  /** Session order, so the log reads in the order the work happened. */
  order: number;
}

export interface ChangeLogEntry {
  messageId: string;
  transactionId: string;
  order: number;
  component: string;
  elementKey: string;
  /** Project-relative source location, when the target reported one. */
  file: string | null;
  line: number | null;
  property: string;
  /** Measured value at inspection time, or null when never measured. */
  before: string | null;
  after: string;
}

export function proposalState(message: ChatMessage): ProposalState {
  if (message.role !== 'assistant') return 'rejected';
  if (message.decision === 'accepted') return 'accepted';
  if (message.decision === 'rejected') return 'rejected';
  return 'pending';
}

/** The proposal carried by one message, or null when it proposed nothing. */
export function proposalFor(
  message: ChatMessage,
  transactions: readonly PreviewTransaction[],
): Proposal | null {
  if (message.role !== 'assistant') return null;
  if (!message.previewTransactionId) return null;
  const transaction = transactions.find((item) => item.id === message.previewTransactionId);
  if (!transaction || transaction.changes.length === 0) return null;
  return {
    messageId: message.id,
    transactionId: transaction.id,
    state: proposalState(message),
    changes: transaction.changes,
    citations: message.citations,
    order: message.createdAt,
  };
}

/** Every proposal in the session, in the order the work happened. */
export function proposalsIn(
  messages: readonly ChatMessage[],
  transactions: readonly PreviewTransaction[],
): Proposal[] {
  const found: Proposal[] = [];
  for (const message of messages) {
    const proposal = proposalFor(message, transactions);
    if (proposal) found.push(proposal);
  }
  return found;
}

/** Proposals still waiting on the user. */
export function pendingProposals(
  messages: readonly ChatMessage[],
  transactions: readonly PreviewTransaction[],
): Proposal[] {
  return proposalsIn(messages, transactions).filter((proposal) => proposal.state === 'pending');
}

function componentName(
  change: PreviewChangeRecord,
  citations: readonly CitationSnapshot[],
): string {
  const citation = citations.find((item) => item.displayNumber === change.target);
  const explicit = citation?.component;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const anchor = change.anchor;
  if (anchor.testId.length > 0) return anchor.testId;
  if (anchor.id.length > 0) return `#${anchor.id}`;
  if (anchor.path.length > 0) return anchor.path;
  return anchor.tagName;
}

function declarationText(declarations: Readonly<Record<string, string>>): string {
  return Object.entries(declarations)
    .map(([property, value]) => `${property} ${value}`)
    .join(', ');
}

function clip(text: string): string {
  return text.length > MAX_CHANGE_LINE_CHARS ? `${text.slice(0, MAX_CHANGE_LINE_CHARS - 1)}…` : text;
}

/** `PrimaryButton: padding 12px 16px, border-radius 10px` — one per change. */
export function proposalSummaryLines(proposal: Proposal): string[] {
  return proposal.changes.slice(0, MAX_CHANGES_PER_PROPOSAL).map((change) => {
    const declarations = declarationText(change.declarations);
    return clip(`${componentName(change, proposal.citations)}: ${declarations}`);
  });
}

/**
 * The concise decision block the next request carries.
 *
 * A rejected proposal stays in the log on purpose: it tells the model which
 * direction the user already turned down, so it does not re-propose it.
 */
export function decisionContextLines(
  messages: readonly ChatMessage[],
  transactions: readonly PreviewTransaction[],
): string[] {
  const lines: string[] = [];
  for (const proposal of proposalsIn(messages, transactions)) {
    if (proposal.state === 'pending') continue;
    const tag = proposal.state === 'accepted' ? 'accept' : 'reject';
    for (const summary of proposalSummaryLines(proposal)) {
      if (lines.length >= MAX_DECISION_LINES) return lines;
      lines.push(
        proposal.state === 'rejected' ? `- [${tag}] ${summary} — reverted` : `- [${tag}] ${summary}`,
      );
    }
  }
  return lines;
}

/**
 * Every settled change, newest last, with the measured value it replaced.
 * The panel and the proposal document are both rendered from this so they can
 * never disagree.
 */
export function buildChangeLog(
  messages: readonly ChatMessage[],
  transactions: readonly PreviewTransaction[],
): ChangeLogEntry[] {
  const entries: ChangeLogEntry[] = [];
  for (const proposal of proposalsIn(messages, transactions)) {
    if (proposal.state !== 'accepted') continue;
    for (const change of proposal.changes) {
      const citation = proposal.citations.find((item) => item.displayNumber === change.target);
      const facts = citation?.styleFacts?.props;
      for (const [property, after] of Object.entries(change.declarations)) {
        if (entries.length >= MAX_CHANGE_LOG_ENTRIES) return entries;
        const measured = facts?.[property];
          entries.push({
            messageId: proposal.messageId,
            transactionId: proposal.transactionId,
            order: proposal.order,
            component: componentName(change, proposal.citations),
            elementKey: change.anchor.elementKey,
            // The location the target reported for the element the change was
            // applied to. Null whenever the target sets no metadata: the bridge
            // never invents a location, and neither does this.
            file: citation?.file ?? null,
            line: citation?.line ?? null,
            property,
            before: measured === undefined || measured === '' ? null : measured,
            after,
          });
      }
    }
  }
  return entries;
}

export interface ChangeLogGroup {
  component: string;
  /** Where the first entry's element lives, when the target reported it. */
  file: string | null;
  line: number | null;
  entries: ChangeLogEntry[];
}

/** Change log folded per component, in first-seen order. */
export function groupChangeLog(
  messages: readonly ChatMessage[],
  transactions: readonly PreviewTransaction[],
): ChangeLogGroup[] {
  const groups: ChangeLogGroup[] = [];
  const byComponent = new Map<string, ChangeLogGroup>();
  for (const entry of buildChangeLog(messages, transactions)) {
    const bucket = byComponent.get(entry.component);
    if (bucket) {
      bucket.entries.push(entry);
      // A later entry for the same component may be the one that carries a
      // location, so take the first that has one rather than the first seen.
      if (bucket.file === null && entry.file !== null) {
        bucket.file = entry.file;
        bucket.line = entry.line;
      }
    } else {
      const fresh: ChangeLogGroup = {
        component: entry.component,
        file: entry.file,
        line: entry.line,
        entries: [entry],
      };
      byComponent.set(entry.component, fresh);
      groups.push(fresh);
    }
  }
  return groups;
}

/** Session-shaped convenience wrappers for the UI. */
export function changeLogForSession(session: InspectorSession | null): ChangeLogEntry[] {
  if (!session) return [];
  return buildChangeLog(session.messages, session.previewTransactions);
}

export function changeLogGroupsForSession(session: InspectorSession | null): ChangeLogGroup[] {
  if (!session) return [];
  return groupChangeLog(session.messages, session.previewTransactions);
}

export function pendingForSession(session: InspectorSession | null): Proposal[] {
  if (!session) return [];
  return pendingProposals(session.messages, session.previewTransactions);
}

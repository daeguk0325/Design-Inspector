import { useState, type ReactNode, type RefObject } from 'react';
import { AttachmentChips } from '../editor/AttachmentChip.tsx';
import type { DesignDecision, PreviewRuntimeStatus } from '../preview/transaction.ts';
import type { ProposalState } from '../preview/proposal.ts';
import type { ChatMessage } from '../state/models.ts';
import { shortcutLabel } from '../shortcut.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import { citationAttachmentViews } from './messageAttachments.ts';
import { UserText } from './CiteInline.tsx';

export interface MessagePreviewStatus {
  status: PreviewRuntimeStatus;
  enabled?: boolean;
  /** Kept for the shape the preview controller publishes; the row names the changes instead. */
  changeCount?: number;
  errorCode?: string;
  /** Present once the message carries a proposal. Absent means it proposed nothing. */
  proposalState?: ProposalState;
  /** The exact lines the next request will carry for this proposal. */
  summaryLines?: readonly string[];
}

export type MessagePreviewLookup =
  | ReadonlyMap<string, MessagePreviewStatus>
  | Readonly<Record<string, MessagePreviewStatus>>;

export interface ChatListProps {
  messages: ChatMessage[];
  streaming: boolean;
  onCopy: (text: string) => void;
  onRevert: (userMsg: ChatMessage) => void;
  previews?: MessagePreviewLookup;
  onDecision?: (messageId: string, decision: DesignDecision) => void;
  /** Re-selects a component the answer cited, in the inspected page. */
  onCite?: (selectionId: string) => void;
  /** Lets the parent drive the message scroll (jump buttons). */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Fires when the message list scrolls, so the parent can show jump buttons. */
  onListScroll?: () => void;
}

interface DecisionOption {
  value: DesignDecision;
  label: string;
  hint: string;
}

/**
 * Revise was a third state with no behaviour behind it: it recorded a third
 * value and changed nothing on screen. The product has two real outcomes for a
 * proposal — keep the applied change, or roll it back — and both stay reachable
 * for as long as the conversation lasts, because the user is allowed to change
 * their mind after deciding.
 */
const DECISION_OPTIONS: readonly DecisionOption[] = Object.freeze([
  { value: 'accepted', label: 'Accept', hint: 'Keep this change applied' },
  { value: 'rejected', label: 'Reject', hint: 'Roll this change back' },
]);

/**
 * Words only for the states where the change is not sitting on the page. A
 * change that applied, or that the user rolled back, already reads as exactly
 * that in the toggle beside it, and a second word next to it was the clutter
 * this row exists to remove.
 */
const UNAPPLIED_STATUS_LABEL: Partial<Record<PreviewRuntimeStatus, string>> = Object.freeze({
  'pending-rebind': 'Applying…',
  unbound: 'Not applied',
  ambiguous: 'Ambiguous match',
  rejected: 'Not applied',
  reset: 'Cleared',
  'stale-binding': 'Stale match',
});

function previewFor(
  previews: MessagePreviewLookup | undefined,
  messageId: string,
): MessagePreviewStatus | null {
  if (!previews) return null;
  const value = previews instanceof Map
    ? previews.get(messageId)
    : (previews as Readonly<Record<string, MessagePreviewStatus>>)[messageId];
  return value ?? null;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="5.75" y="1.75" width="8.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 14.5h-7a2 2 0 0 1-2-2v-9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RevertIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M3.2 8a4.8 4.8 0 1 0 1.55-3.55" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2.4 2.9v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MessageAttachments({ message }: { message: ChatMessage }) {
  // Only the assistant keeps a citation row. A user message already names its
  // components inline, where the words that refer to them sit.
  if (message.role !== 'assistant' || message.citations.length === 0) return null;
  return (
    <div className="msg-attach">
      <AttachmentChips items={citationAttachmentViews(message.citations)} />
    </div>
  );
}

/**
 * What the row has to say when the change is not on the page, or never made it
 * there. A failed preview used to sit in its own box next to a clean one; the
 * risk this closes is a failure that reads as a clean row, so the words are
 * short and they are inside the same row rather than beside it.
 */
function previewFailure(preview: MessagePreviewStatus): string | null {
  const parts = [UNAPPLIED_STATUS_LABEL[preview.status] ?? null, preview.errorCode ?? null].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * One row for a previewed answer: the change on the left, and the toggle that
 * keeps it or rolls it back on the right.
 *
 * The change lines are the strings the next request carries, so what the user
 * flips here is literally what the model is told. The toggle starts on Accept
 * because the change is already on the page — asking the user to confirm what
 * they are already looking at is what made the old row feel like furniture.
 */
function PreviewRow({
  message,
  preview,
  onDecision,
}: {
  message: ChatMessage;
  preview: MessagePreviewStatus;
  onDecision?: (messageId: string, decision: DesignDecision) => void;
}) {
  const lines = preview.summaryLines ?? [];
  const failure = previewFailure(preview);
  // Nothing to keep and nothing to roll back: an answer that proposed no change
  // gets no row, rather than a toggle over an empty subject.
  if (lines.length === 0 && failure === null) return null;
  // An undecided proposal is already applied, so the toggle reads Accept until
  // the user says otherwise.
  const active: DesignDecision = message.decision ?? 'accepted';
  return (
    <div className="preview-row">
      <span className="preview-state" data-state={preview.status} role="status">
        <span className="dot" aria-hidden="true" />
        <span className="preview-changes">
          {lines.map((line, index) => (
            <span className="preview-change mono" key={`${line}-${index}`}>
              {line}
            </span>
          ))}
        </span>
        {failure !== null && <span className="preview-error">{failure}</span>}
      </span>
      {onDecision && (
        <div className="decide" role="group" aria-label="This answer's previewed change">
          {DECISION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="decide-btn"
              data-decision={option.value}
              aria-pressed={active === option.value}
              title={option.hint}
              onClick={() => onDecision(message.id, option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface StatusNote {
  node: ReactNode;
  error: boolean;
}

/**
 * What the line under the bubble says. Returns null when the bubble already
 * shows the state on its own, so one state never gets two sets of motion.
 */
function statusNoteFor(message: ChatMessage, isLive: boolean, streaming: boolean): StatusNote | null {
  const status = message.status;
  if (status === undefined || status === 'completed') return null;
  if (status === 'error') return { node: 'Error — request preserved.', error: true };
  if (status === 'interrupted') return { node: 'Stopped — request preserved.', error: false };
  if (!streaming) return { node: 'Starting…', error: false };
  if (message.content === '' && isLive) return null;
  return {
    node: (
      <span className="status-live">
        <Spinner />
        <TypingDots />
      </span>
    ),
    error: false,
  };
}

function MessageBody({ message, onCite }: { message: ChatMessage; onCite?: (selectionId: string) => void }) {
  if (message.content === '' && message.status === 'streaming') {
    // The two words that used to sit here said nothing the ring and the dots
    // do not already say, and having them in two places at once read as two
    // different statuses. Motion alone carries "working".
    return (
      <span className="typing-row">
        <Spinner />
        <TypingDots />
      </span>
    );
  }
  if (message.role === 'assistant') {
    return <MarkdownMessage content={message.content} citations={message.citations} onCite={onCite} />;
  }
  if (message.content === '') return null;
  return <UserText message={message} />;
}

/**
 * Three dots that never sit still while the model is working. The previous UI
 * showed a frozen `…` for a minute-long 9B turn, which reads as a hang; motion
 * is the difference between "working" and "stuck".
 */
export function TypingDots() {
  return (
    <span className="typing-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** A ring that keeps turning while the answer streams in. */
export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

/**
 * The reasoning log, Ollama-style: a collapsed preview of about four lines,
 * one click to read the whole trace, another click to fold it back.
 *
 * It sits above the answer because that is the order it happened in — the
 * model thought first, then wrote — and because a trace that renders below a
 * finished answer looks like a second answer.
 */
function ThinkingBlock({ thinking, streaming }: { thinking: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const chars = thinking.length;
  return (
    <div className={`thinking${open ? ' open' : ''}`}>
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={open ? '추론 로그 접기 (4줄만 보기)' : '추론 로그 전체 보기'}
      >
        <span className="thinking-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {streaming ? (
          <span className="thinking-live">
            <Spinner />
            <span>생각 중…</span>
          </span>
        ) : (
          <span>생각 과정</span>
        )}
        <span className="thinking-meta">{chars.toLocaleString()}자</span>
      </button>
      <div className="thinking-body" role="log" aria-label="모델 추론 로그">
        {thinking}
      </div>
    </div>
  );
}

export function ChatList({
  messages,
  streaming,
  onCopy,
  onRevert,
  previews,
  onDecision,
  onCite,
  scrollRef,
  onListScroll,
}: ChatListProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (messages.length === 0) {
    return (
      <div className="messages" ref={scrollRef} onScroll={onListScroll}>
        <div className="empty-chat" role="status">
          <div className="empty-mark" aria-hidden="true">✦</div>
          <h3>Inspect, ask, refine</h3>
          <p>
            Freeze the target with <span className="mono">{shortcutLabel()}</span>, click elements to
            collect citations, then ask for the change you want.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="messages" aria-live="polite" ref={scrollRef} onScroll={onListScroll}>
      {messages.map((m) => {
        const preview = previewFor(previews, m.id);
        const thinking = m.role === 'assistant' && m.thinking ? m.thinking : null;
        const isLive = m.status === 'streaming' && streaming;
        // The empty bubble already carries the ring and the dots, so repeating
        // them in the status line would put the same two motions on screen twice
        // for one state.
        const statusNote = statusNoteFor(m, isLive, streaming);
        return (
          <div className={`msg ${m.role}`} key={m.id}>
            {thinking !== null && (
              <ThinkingBlock thinking={thinking} streaming={isLive} />
            )}
            <div className="bubble">
              <MessageBody message={m} onCite={onCite} />
              {isLive && m.content !== '' && (
                <span className="typing-caret" aria-hidden="true" />
              )}
              <MessageAttachments message={m} />
            </div>
            {m.role === 'assistant' && preview && (
              <PreviewRow message={m} preview={preview} onDecision={onDecision} />
            )}
            {m.role === 'assistant' && statusNote !== null && (
              <span className={`status-note ${statusNote.error ? 'err' : ''}`} role="status">
                {statusNote.node}
              </span>
            )}
            <div className="actions">
              <button
                type="button"
                className="mini icon-btn"
                title="Copy message"
                aria-label={`Copy ${m.role} message`}
                onClick={() => {
                  onCopy(m.content);
                  setCopiedId(m.id);
                  window.setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1200);
                }}
              >
                {copiedId === m.id ? <CheckIcon /> : <CopyIcon />}
                <span className="sr-only">{copiedId === m.id ? 'Copied' : 'Copy'}</span>
              </button>
              {m.role === 'user' && (
                <button
                  type="button"
                  className="mini icon-btn"
                  title="Rewind to here — deletes this and everything after it, clears the applied previews, and puts the text back in the composer"
                  aria-label="Rewind conversation to this message"
                  onClick={() => onRevert(m)}
                >
                  <RevertIcon />
                  <span className="sr-only">Rewind</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

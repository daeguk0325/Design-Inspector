import { useState, type RefObject } from 'react';
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
  onUndoPreview?: (messageId: string) => void;
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
 * proposal — keep the applied change, or roll it back.
 */
const DECISION_OPTIONS: readonly DecisionOption[] = Object.freeze([
  { value: 'accepted', label: 'Accept', hint: 'Keep this change applied' },
  { value: 'rejected', label: 'Reject', hint: 'Roll this change back' },
]);

const PROPOSAL_STATE_LABEL: Record<ProposalState, string> = Object.freeze({
  pending: 'Waiting for you',
  accepted: 'Kept',
  rejected: 'Rolled back',
});

const PREVIEW_STATUS_LABEL: Record<PreviewRuntimeStatus, string> = Object.freeze({
  'pending-rebind': 'Pending rebind',
  applied: 'Applied',
  unbound: 'Unbound',
  ambiguous: 'Ambiguous',
  rejected: 'Rejected',
  undone: 'Undone',
  reset: 'Reset',
  'stale-binding': 'Stale binding',
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

function DecisionControls({
  message,
  onDecision,
}: {
  message: ChatMessage;
  onDecision: (messageId: string, decision: DesignDecision) => void;
}) {
  return (
    <div className="decide" role="group" aria-label="Design decision">
      {DECISION_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="decide-btn"
          data-decision={option.value}
          aria-pressed={message.decision === option.value}
          title={option.hint}
          onClick={() => onDecision(message.id, option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The proposal itself: what it would change, and whether it is still waiting.
 *
 * The change lines are the same strings the next request will carry, so what
 * the user approves here is literally what the model is told. An undecided
 * proposal says so, because sending the next message rejects it.
 */
function ProposalState({
  preview,
}: {
  preview: MessagePreviewStatus;
}) {
  const state = preview.proposalState;
  if (!state) return null;
  const lines = preview.summaryLines ?? [];
  return (
    <div className="proposal" data-state={state}>
      <span className="proposal-state" role="status">
        {PROPOSAL_STATE_LABEL[state]}
      </span>
      {lines.length > 0 && (
        <ul className="proposal-changes">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {state === 'pending' && (
        <p className="proposal-note">Send the next message to roll this back.</p>
      )}
    </div>
  );
}

function PreviewState({
  message,
  preview,
  onUndoPreview,
}: {
  message: ChatMessage;
  preview: MessagePreviewStatus;
  onUndoPreview?: (messageId: string) => void;
}) {
  const label = PREVIEW_STATUS_LABEL[preview.status] ?? preview.status;
  const changes = preview.changeCount;
  const changeText =
    typeof changes === 'number' && Number.isFinite(changes) && changes > 0
      ? ` · ${Math.floor(changes)} change${Math.floor(changes) === 1 ? '' : 's'}`
      : '';
  const undoable = preview.status === 'applied';
  const hint = [
    label,
    preview.enabled === true ? 'enabled' : preview.enabled === false ? 'disabled' : null,
    preview.errorCode ? preview.errorCode : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return (
    <div className="preview-row">
      <span className="preview-state" data-state={preview.status} role="status" title={hint}>
        <span className="dot" aria-hidden="true" />
        {label}
        {changeText}
      </span>
      <span className="preview-diff" aria-label="Applied to the live target">
        <span className="preview-slot">Live target</span>
      </span>
      {onUndoPreview && (
        <button
          type="button"
          className="mini preview-undo"
          disabled={!undoable}
          aria-label={`Undo preview for this answer${undoable ? '' : ' — nothing applied to undo'}`}
          title={undoable ? 'Undo the applied preview' : 'Nothing applied to undo'}
          onClick={() => onUndoPreview(message.id)}
        >
          Undo
        </button>
      )}
    </div>
  );
}

function MessageBody({ message, onCite }: { message: ChatMessage; onCite?: (selectionId: string) => void }) {
  if (message.content === '' && message.status === 'streaming') {
    return (
      <span className="typing-row">
        <TypingDots />
        <span className="typing-label">답변 작성 중…</span>
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
  onUndoPreview,
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
        const decided = preview?.proposalState === 'accepted' || preview?.proposalState === 'rejected';
        const thinking = m.role === 'assistant' && m.thinking ? m.thinking : null;
        const isLive = m.status === 'streaming' && streaming;
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
              <PreviewState message={m} preview={preview} onUndoPreview={onUndoPreview} />
            )}
            {m.role === 'assistant' && preview && <ProposalState preview={preview} />}
            {m.role === 'assistant' && onDecision && preview?.proposalState && !decided && (
              <DecisionControls message={m} onDecision={onDecision} />
            )}
            {m.role === 'assistant' && m.status !== undefined && m.status !== 'completed' && (
              <span className={`status-note ${m.status === 'error' ? 'err' : ''}`} role="status">
                {m.status === 'streaming'
                  ? streaming
                    ? (
                      <span className="status-live">
                        <Spinner />
                        <span>답변 작성 중</span>
                        <TypingDots />
                      </span>
                    )
                    : 'Starting…'
                  : m.status === 'interrupted' ? 'Stopped — request preserved.' : 'Error — request preserved.'}
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

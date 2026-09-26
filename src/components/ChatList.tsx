import { useState } from 'react';
import { AttachmentChips } from '../editor/AttachmentChip.tsx';
import type { DesignDecision, PreviewRuntimeStatus } from '../preview/transaction.ts';
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
}

export type MessagePreviewLookup =
  | ReadonlyMap<string, MessagePreviewStatus>
  | Readonly<Record<string, MessagePreviewStatus>>;

export interface ChatListProps {
  messages: ChatMessage[];
  streaming: boolean;
  onCopy: (text: string) => void;
  onTogglePin: (id: string) => void;
  onRetry: (userMsg: ChatMessage) => void;
  previews?: MessagePreviewLookup;
  onDecision?: (messageId: string, decision: DesignDecision) => void;
  onUndoPreview?: (messageId: string) => void;
  /** Re-selects a component the answer cited, in the inspected page. */
  onCite?: (selectionId: string) => void;
}

interface DecisionOption {
  value: DesignDecision;
  label: string;
  hint: string;
}

const DECISION_OPTIONS: readonly DecisionOption[] = Object.freeze([
  { value: 'accepted', label: 'Accept', hint: 'Accept this design as delivered' },
  { value: 'needs-revision', label: 'Revise', hint: 'This design needs revision' },
  { value: 'rejected', label: 'Reject', hint: 'Reject this design' },
]);

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
  if (message.content === '' && message.status === 'streaming') return '…';
  if (message.role === 'assistant') {
    return <MarkdownMessage content={message.content} citations={message.citations} onCite={onCite} />;
  }
  if (message.content === '') return null;
  return <UserText message={message} />;
}

export function ChatList({
  messages,
  streaming,
  onCopy,
  onTogglePin,
  onRetry,
  previews,
  onDecision,
  onUndoPreview,
  onCite,
}: ChatListProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (messages.length === 0) {
    return (
      <div className="messages">
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
    <div className="messages" aria-live="polite">
      {messages.map((m) => {
        const preview = previewFor(previews, m.id);
        return (
          <div className={`msg ${m.role}`} key={m.id}>
            <div className="bubble">
              <MessageBody message={m} onCite={onCite} />
              <MessageAttachments message={m} />
            </div>
            {m.role === 'assistant' && preview && (
              <PreviewState message={m} preview={preview} onUndoPreview={onUndoPreview} />
            )}
            {m.role === 'assistant' && onDecision && (
              <DecisionControls message={m} onDecision={onDecision} />
            )}
            {m.role === 'assistant' && m.status !== undefined && m.status !== 'completed' && (
              <span className={`status-note ${m.status === 'error' ? 'err' : ''}`} role="status">
                {m.status === 'streaming' ? (streaming ? 'Streaming…' : 'Starting…') : m.status === 'interrupted' ? 'Stopped — request preserved.' : 'Error — request preserved.'}
              </span>
            )}
            <div className="actions">
              <button
                type="button"
                className="mini"
                title="Copy message"
                aria-label={`Copy ${m.role} message`}
                onClick={() => {
                  onCopy(m.content);
                  setCopiedId(m.id);
                  window.setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1200);
                }}
              >
                {copiedId === m.id ? 'Copied ✓' : 'Copy'}
              </button>
              <button
                type="button"
                className="mini"
                title={m.pinned ? 'Unpin constraint' : 'Pin as constraint'}
                aria-pressed={m.pinned}
                onClick={() => onTogglePin(m.id)}
              >
                {m.pinned ? 'Unpin' : 'Pin'}
              </button>
              {m.role === 'user' && (
                <button
                  type="button"
                  className="mini"
                  title="Retry last assistant answer for this request"
                  onClick={() => onRetry(m)}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

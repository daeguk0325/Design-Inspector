export interface SendIntentInput {
  streaming: boolean;
  preparing: boolean;
  text: string;
  /**
   * What the user actually typed. Tags render as `[n]` in `text`, so emptiness
   * has to be judged on the words: a message of nothing but citations carries no
   * request. Defaults to `text` when omitted.
   */
  request?: string;
  ready: boolean;
}

export type SendIntent =
  | { kind: 'stop' }
  | { kind: 'send'; text: string }
  | { kind: 'blocked'; reason: 'preparing' | 'not-ready' | 'empty' };

export function planSendIntent(input: SendIntentInput): SendIntent {
  if (input.streaming) return { kind: 'stop' };
  if (input.preparing) return { kind: 'blocked', reason: 'preparing' };
  if (!input.ready) return { kind: 'blocked', reason: 'not-ready' };
  const request = input.request ?? input.text;
  if (request.trim().length === 0) return { kind: 'blocked', reason: 'empty' };
  return { kind: 'send', text: input.text };
}

export interface SendCommit {
  clearText: boolean;
  clearAttachmentsOnly: boolean;
  releaseSelectionIds: string[];
}

export function planSendCommit(
  sent: boolean,
  submittedText: string,
  currentText: string,
  attachedSelectionIds: readonly string[],
): SendCommit {
  if (!sent) {
    return { clearText: false, clearAttachmentsOnly: false, releaseSelectionIds: [] };
  }
  const unchanged = currentText === submittedText;
  return {
    clearText: unchanged,
    clearAttachmentsOnly: !unchanged,
    releaseSelectionIds: [...new Set(attachedSelectionIds)],
  };
}

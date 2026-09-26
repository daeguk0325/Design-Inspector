export interface KeyboardEventLike {
  key: string;
  isComposing?: boolean;
  repeat?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  keyCode?: number;
}

export function isImeComposing(event: KeyboardEventLike, editorComposing = false): boolean {
  return event.isComposing === true || event.keyCode === 229 || editorComposing;
}

export function hasBlockingModifier(event: KeyboardEventLike): boolean {
  return event.altKey === true || event.ctrlKey === true || event.metaKey === true;
}

export function isSendEnter(event: KeyboardEventLike, editorComposing = false): boolean {
  return event.key === 'Enter' && event.shiftKey !== true && !isImeComposing(event, editorComposing);
}

import {
  $createLineBreakNode,
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type ParagraphNode,
  type PointType,
  type RangeSelection,
} from 'lexical';
import { AttachmentNode, $createAttachmentNode } from './AttachmentNode.tsx';
import type { ComposerSegment } from './plainText.ts';

function segmentsForNode(node: LexicalNode): ComposerSegment[] {
  if (node instanceof AttachmentNode) {
    return [{ type: 'attachment', selectionId: node.getSelectionId() }];
  }
  if ($isLineBreakNode(node)) return [{ type: 'text', text: '\n' }];
  if ($isTextNode(node)) return [{ type: 'text', text: node.getTextContent() }];
  if ($isElementNode(node)) {
    const segments: ComposerSegment[] = [];
    node.getChildren().forEach((child) => segments.push(...segmentsForNode(child)));
    return segments;
  }
  return [];
}

export function $composerSegments(): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  const root = $getRoot();
  const blocks = root.getChildren();
  blocks.forEach((block, index) => {
    if (index > 0) segments.push({ type: 'text', text: '\n' });
    segments.push(...segmentsForNode(block));
  });
  return segments;
}

export function $blockCount(): number {
  return $getRoot().getChildrenSize();
}

/** The single composer paragraph, creating or normalising the root to one block. */
function $composerParagraph(): ParagraphNode {
  $normalizeComposerBlocks();
  const first = $getRoot().getFirstChild();
  return $isParagraphNode(first) ? first : $createParagraphNode();
}

/**
 * Invariant: the composer document is always exactly one paragraph.
 *
 * A second block (a stray Enter, a browser-inserted wrapper, a block left over
 * from a previous send) is what split the tags from the caret onto separate
 * lines, so every mutation path funnels through here.
 */
export function $normalizeComposerBlocks(): boolean {
  const root = $getRoot();
  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode());
    return true;
  }
  if (root.getChildrenSize() === 1) return false;
  const first = root.getFirstChild();
  if (!$isParagraphNode(first)) return false;
  let changed = false;
  for (const block of [...root.getChildren()].slice(1)) {
    if ($isElementNode(block)) {
      for (const child of block.getChildren()) {
        if (first.getChildrenSize() > 0) first.append($createLineBreakNode());
        first.append(child);
      }
    }
    block.remove();
    changed = true;
  }
  return changed;
}

export function $clearComposerContent(): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);
  paragraph.select(0, 0);
}

export function $clearAttachmentNodes(): number {
  const nodes = $attachmentNodes();
  for (const node of nodes) node.remove();
  return nodes.length;
}

export function $attachmentNodes(): AttachmentNode[] {
  const found: AttachmentNode[] = [];
  const visit = (node: LexicalNode): void => {
    if (node instanceof AttachmentNode) {
      found.push(node);
      return;
    }
    if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  $getRoot().getChildren().forEach(visit);
  return found;
}

export function $removeAttachmentNode(selectionId: string): boolean {
  let removed = false;
  for (const node of $attachmentNodes()) {
    if (node.getSelectionId() !== selectionId) continue;
    node.remove();
    removed = true;
  }
  return removed;
}

/** Removals are animated, so a node is marked first and dropped later. */
export function $markAttachmentRemoving(selectionId: string): boolean {
  let marked = false;
  for (const node of $attachmentNodes()) {
    if (node.getSelectionId() !== selectionId || node.isRemoving()) continue;
    node.setRemoving(true);
    marked = true;
  }
  return marked;
}

export function $finalizeRemovingAttachments(): number {
  const nodes = $attachmentNodes().filter((node) => node.isRemoving());
  for (const node of nodes) node.remove();
  return nodes.length;
}

/** True when a set of ids covers exactly the same members, in any order. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return a.every((id) => other.has(id));
}

/**
 * Inserts a tag where the caret actually is, so tags and sentences can be
 * interleaved ("make [1] and [2] more compact").
 *
 * There is no pinned region any more: the caret is legal in front of, between
 * and after the tags, and a tag lands exactly at it. When the composer has never
 * been focused there is no caret to honour, so the end of the text is the only
 * honest position. A live text selection is likewise never swallowed — choosing
 * a component must not eat the words the user had highlighted.
 *
 * The insertion is done by hand rather than through `RangeSelection.insertNodes`:
 * that helper removes whatever its own range resolves to, which for a collapsed
 * caret is the whole text node the caret sits in. A tag chosen mid-sentence used
 * to take the sentence with it.
 */
function $insertAtCaret(paragraph: ParagraphNode, node: AttachmentNode): void {
  let selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    $placeCaretAtEnd();
    selection = $getSelection();
  }
  if (!$isRangeSelection(selection)) {
    paragraph.append(node);
    return;
  }
  const anchor = selection.anchor;
  if (anchor.type === 'element') {
    if (anchor.getNode() === paragraph) paragraph.splice(anchor.offset, 0, [node]);
    else paragraph.append(node);
  } else {
    const text = anchor.getNode();
    const offset = anchor.offset;
    if (offset <= 0) {
      text.insertBefore(node);
    } else if (offset >= text.getTextContentSize()) {
      text.insertAfter(node);
    } else {
      const tail = text.splitText(offset)[0] ?? null;
      text.insertAfter(node);
      if (tail) node.insertAfter(tail);
    }
  }
  // Leave the caret after the tag, so a second tag in the same commit lands
  // beside it instead of in front of it.
  const index = node.getIndexWithinParent();
  const host = node.getParentOrThrow();
  if ($isParagraphNode(host)) host.select(index + 1, index + 1);
}

/**
 * What a reconcile did, so the caller can decide how the change should sit in
 * the undo history.
 */
export interface ReconcileResult {
  /** Tags added, and where the caret put them. */
  readonly inserted: string[];
  /** Tags dropped because the props no longer list them. */
  readonly removed: string[];
  /** Tags that were fading out and are wanted again, so the rollback holds. */
  readonly restored: string[];
}

/**
 * Single entry point that makes the Lexical document match `desired`.
 * Idempotent, safe to call on every commit.
 *
 * Matching is by id, not by position: a tag keeps the exact spot in the flow it
 * was inserted at, so a new selection landing mid-sentence never reflows the
 * tags that are already on screen (which re-mounting them would, killing both
 * the caret and the entry animation).
 */
export function $reconcileTagNodes(desired: readonly string[]): ReconcileResult {
  const paragraph = $composerParagraph();
  const wanted = new Set(desired);
  const inserted: string[] = [];
  const removed: string[] = [];
  const restored: string[] = [];

  for (const node of $attachmentNodes()) {
    const id = node.getSelectionId();
    if (node.isRemoving()) {
      // Still fading out. If the target refused the deselect, the props kept the
      // id, so the tag comes back instead of vanishing against the user's wish.
      if (wanted.has(id)) {
        node.setRemoving(false);
        restored.push(id);
      }
      continue;
    }
    if (!wanted.has(id)) {
      node.remove();
      removed.push(id);
    }
  }

  const present = new Set(
    $attachmentNodes()
      .filter((node) => !node.isRemoving())
      .map((node) => node.getSelectionId()),
  );
  for (const id of desired) {
    if (present.has(id)) continue;
    $insertAtCaret(paragraph, $createAttachmentNode(id));
    inserted.push(id);
  }
  return { inserted, removed, restored };
}

/** @deprecated Use {@link $reconcileTagNodes}; kept as the sync entry point name. */
export const $syncAttachmentNodes = $reconcileTagNodes;

export function $placeCaretAtEnd(): void {
  const paragraph = $composerParagraph();
  const last = paragraph.getLastChild();
  if ($isTextNode(last)) last.selectEnd();
  else paragraph.selectEnd();
}

export function $caretSignature(selection: RangeSelection): string {
  return [
    `${selection.anchor.type}:${selection.anchor.key}:${selection.anchor.offset}`,
    `${selection.focus.type}:${selection.focus.key}:${selection.focus.offset}`,
  ].join('|');
}

/**
 * Identity of the caret for the two-step backspace.
 *
 * Lexical normalises an element point into a text point on the very next commit,
 * so the raw selection signature changes even though the caret did not move.
 * Keying the arm on the adjacent tag instead makes the armed state survive that
 * normalisation, which is what let the first Backspace silently cancel itself.
 */
export function $armCaretSignature(selection: RangeSelection): string {
  const adjacent = $adjacentAttachment();
  if (adjacent) return `tag:${adjacent}`;
  return $caretSignature(selection);
}

export function $composerSignature(): string {
  return `${$attachmentNodes()
    .map((node) => node.getSelectionId())
    .join(',')}|${$getRoot().getTextContent()}`;
}

/** Ordered ids of the tags currently in the document (removing ones excluded). */
export function $documentTagIds(): string[] {
  return $attachmentNodes()
    .filter((node) => !node.isRemoving())
    .map((node) => node.getSelectionId());
}

/** Ids playing their exit animation; they must not be re-added while they fade. */
export function $removingAttachmentIds(): string[] {
  return $attachmentNodes()
    .filter((node) => node.isRemoving())
    .map((node) => node.getSelectionId());
}

function $attachmentIdAt(block: ElementNode, index: number): string | null {
  if (index < 0) return null;
  const child = block.getChildAtIndex(index);
  return child instanceof AttachmentNode && !child.isRemoving() ? child.getSelectionId() : null;
}

/**
 * The tag immediately left or right of a collapsed caret, or null.
 *
 * Both sides count now that tags sit in the flow. Adjacent means nothing but the
 * tag separates the caret from the next character, so Backspace and Delete both
 * offer the two-step removal instead of silently eating a node.
 */
export function $adjacentAttachment(): string | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;

  if (anchor.type === 'text') {
    const text = anchor.getNode();
    // Only the very edges of a text node touch a tag; the middle is ordinary
    // text, where Backspace must still delete a character.
    if (anchor.offset === 0) {
      const previous = text.getPreviousSibling();
      if (previous instanceof AttachmentNode && !previous.isRemoving()) return previous.getSelectionId();
    }
    if (anchor.offset === text.getTextContentSize()) {
      const next = text.getNextSibling();
      if (next instanceof AttachmentNode && !next.isRemoving()) return next.getSelectionId();
    }
    return null;
  }

  const block = anchor.getNode();
  if (!$isParagraphNode(block)) return null;
  return $attachmentIdAt(block, anchor.offset - 1) ?? $attachmentIdAt(block, anchor.offset);
}

/**
 * Child-index span a non-collapsed range covers, or null when it is not in the
 * composer paragraph.
 *
 * Resolved to paragraph children rather than through `getNodes()` because a
 * tag is atomic: the caret lands before or after it, never inside it, so the
 * inclusive/exclusive decision has to be made per child index.
 */
function $selectionChildSpan(selection: RangeSelection): { start: number; end: number } | null {
  const paragraph = $getRoot().getFirstChild();
  if (!$isParagraphNode(paragraph)) return null;
  const size = paragraph.getChildrenSize();
  const point = (value: PointType): number => {
    if (value.type === 'element') {
      if (value.getNode() !== paragraph) return size;
      return Math.max(0, Math.min(value.offset, size));
    }
    const index = paragraph.getChildren().indexOf(value.getNode());
    if (index < 0) return size;
    // A text point at offset 0 sits *before* its node, so it starts there.
    return value.offset === 0 ? index : index + 1;
  };
  const anchor = point(selection.anchor);
  const focus = point(selection.focus);
  return anchor <= focus ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/**
 * Tags fully inside the current range selection.
 *
 * A drag that swallows a tag deletes it, exactly like the text around it —
 * there is no arm step for a deliberate multi-node gesture.
 */
export function $tagsInSelection(): string[] {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return [];
  const span = $selectionChildSpan(selection);
  if (!span) return [];
  const paragraph = $getRoot().getFirstChild();
  if (!$isParagraphNode(paragraph)) return [];
  const ids: string[] = [];
  for (let index = span.start; index < span.end && index < paragraph.getChildrenSize(); index++) {
    const child = paragraph.getChildAtIndex(index);
    if (child instanceof AttachmentNode && !child.isRemoving()) ids.push(child.getSelectionId());
  }
  return ids;
}

/**
 * Inserts plain text at the caret, leaving the tags where the user put them.
 *
 * With no caret to honour — the composer was never focused, or a paste arrives
 * before the first keystroke — the text lands at the end of the sentence. Doing
 * nothing there used to swallow the very first thing the user typed.
 */
export function $insertComposerText(text: string): void {
  if (text.length === 0) return;
  let selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    $placeCaretAtEnd();
    selection = $getSelection();
  }
  if ($isRangeSelection(selection)) selection.insertText(text);
}

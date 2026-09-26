import {
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedPartial,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';
import {
  ATTACHMENT_NODE_TYPE,
  parseSerializedSelectionId,
  serializeAttachment,
} from './attachmentSerialization.ts';
import { AttachmentTag } from './AttachmentTag.tsx';

export type SerializedAttachmentNode = Spread<{ selectionId: string }, SerializedLexicalNode>;

export class AttachmentNode extends DecoratorNode<JSX.Element> {
  __selectionId: string;
  __removing: boolean;

  static getType(): string {
    return ATTACHMENT_NODE_TYPE;
  }

  static clone(node: AttachmentNode): AttachmentNode {
    const clone = new AttachmentNode(node.__selectionId, node.getKey());
    clone.__removing = node.__removing;
    return clone;
  }

  constructor(selectionId: string, key?: NodeKey) {
    super(key);
    this.__selectionId = selectionId;
    this.__removing = false;
  }

  getSelectionId(): string {
    return this.getLatest().__selectionId;
  }

  /** True while the tag plays its exit animation and is about to be dropped. */
  isRemoving(): boolean {
    return this.getLatest().__removing;
  }

  setRemoving(removing: boolean): void {
    const writable = this.getWritable();
    writable.__removing = removing;
  }

  exportJSON(): SerializedAttachmentNode {
    return serializeAttachment(this.__selectionId);
  }

  static importJSON(
    serializedNode: SerializedPartial<SerializedLexicalNode> & Record<string, unknown>,
  ): AttachmentNode {
    return new AttachmentNode(parseSerializedSelectionId(serializedNode) ?? '');
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return false;
  }

  /** Atomic: a selection that reaches the start of this node collapses before it. */
  collapseAtStart(): boolean {
    return true;
  }

  getTextContent(): string {
    return '';
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const element = document.createElement('span');
    element.className = 'attach-host';
    element.setAttribute('contentEditable', 'false');
    element.setAttribute('data-selection-id', this.__selectionId);
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    if (prevNode.__selectionId !== this.__selectionId) {
      dom.setAttribute('data-selection-id', this.__selectionId);
    }
    const removing = this.__removing ? 'true' : null;
    if (dom.getAttribute('data-removing') !== removing) {
      if (removing === null) dom.removeAttribute('data-removing');
      else dom.setAttribute('data-removing', removing);
    }
    return false;
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return (
      <AttachmentTag
        selectionId={this.getSelectionId()}
        removing={this.isRemoving()}
      />
    );
  }
}

export function $createAttachmentNode(selectionId: string): AttachmentNode {
  return new AttachmentNode(selectionId);
}

export function $isAttachmentNode(node: unknown): node is AttachmentNode {
  return node instanceof AttachmentNode;
}

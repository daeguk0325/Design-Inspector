import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $addUpdateTag,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  HISTORIC_TAG,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_MODIFIER_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  mergeRegister,
  createEditor,
  type EditorState,
  type LexicalEditor,
} from 'lexical';
import { AttachmentNode } from './AttachmentNode.tsx';
import { attachmentReference } from './attachmentModel.ts';
import { AttachmentViewProvider, type AttachmentContextValue } from './AttachmentContext.tsx';
import {
  $adjacentAttachment,
  $armCaretSignature,
  $blockCount,
  $clearAttachmentNodes,
  $clearComposerContent,
  $composerSegments,
  $composerSignature,
  $documentTagIds,
  $finalizeRemovingAttachments,
  $insertComposerText,
  $markAttachmentRemoving,
  $normalizeComposerBlocks,
  $placeCaretAtEnd,
  $reconcileTagNodes,
  $removingAttachmentIds,
  $tagsInSelection,
  sameSet,
} from './composerDocument.ts';
import { createBackspaceArmController } from './backspaceArm.ts';
import { hasBlockingModifier, isImeComposing, isSendEnter } from './keyboard.ts';
import { attachmentExitMs } from './motion.ts';
import {
  composePlainText,
  composeTypedText,
  hasSendableText,
  type ReferenceResolver,
} from './plainText.ts';

export interface ComposerEditorController {
  /** What gets sent: the typed sentence with every tag rendered as `[n]`. */
  getPlainText: () => string;
  /** Only what the user typed, tags excluded. Tags alone are not a request. */
  getTypedText: () => string;
  hasText: () => boolean;
  clear: () => void;
  clearAttachments: () => void;
  focus: () => void;
  placeCaretAtEnd: () => void;
  insertText: (text: string) => void;
}

export type ComposerAttachmentContext = Omit<AttachmentContextValue, 'focusEditor'>;

export interface ComposerEditorProps {
  attachmentIds: readonly string[];
  attachmentContext: ComposerAttachmentContext;
  onArmChange: (selectionId: string | null) => void;
  /** Fired when a tag leaves the document without going through onRemove. */
  onRestore?: (selectionId: string) => void;
  onSubmit: () => void;
  onReady: (controller: ComposerEditorController | null) => void;
  onTextChange: (text: string) => void;
  placeholder: string;
  /** Document text the editor starts with. Used to restore a rewound request. */
  initialText?: string;
}

interface ComposerEditorCoreProps extends ComposerEditorProps {
  attachmentKey: string;
}

const initialConfig: InitialConfigType = {
  namespace: 'design-inspector-composer',
  nodes: [AttachmentNode],
  editable: true,
  onError: (error) => {
    if (import.meta.env.DEV) throw error;
    console.error(error);
  },
};

const ATTACHMENT_SYNC_TAG = 'attachment-sync';

/**
 * The two halves of a removal are one gesture, so the second half merges into
 * the first history entry. Without this a single Ctrl+Z would only cancel the
 * exit animation and a second one would be needed to bring the tag back.
 */
const REMOVE_START_TAG = 'attachment-remove-start';
const REMOVE_END_TAG = 'attachment-remove-end';

/** How many tag removals stay undoable. */
const MAX_REMOVAL_HISTORY = 20;

/**
 * Update tags whose tag changes are ours, not the user's.
 *
 * The diff observer below turns "a tag appeared in the document" into a target
 * re-selection, so it must only look at commits a gesture produced. Anything we
 * did in response to props is announced by the path that caused it.
 */
const INTERNAL_UPDATE_TAGS = new Set([
  ATTACHMENT_SYNC_TAG,
  REMOVE_START_TAG,
  REMOVE_END_TAG,
  'attachment-clear',
  'composer-clear',
  'composer-normalize',
]);

function readPlainText(editor: LexicalEditor, reference: ReferenceResolver): string {
  return editor.read(() => composePlainText($composerSegments(), reference));
}

function readTypedText(editor: LexicalEditor): string {
  return editor.read(() => composeTypedText($composerSegments()));
}

/**
 * The citation reference for a tag, e.g. `[1]`.
 *
 * Matches the `Inspected UI citations:` block built at transmission, so the
 * model can tie an in-sentence reference to the component it names. Before the
 * capture finishes there is no number yet, and the component name is the only
 * thing that still identifies it.
 */
export function ComposerEditor({
  attachmentIds,
  attachmentContext,
  onArmChange,
  onRestore,
  onSubmit,
  onReady,
  onTextChange,
  placeholder,
  initialText = '',
}: ComposerEditorProps) {
  return (
    <LexicalComposer
      initialConfig={{
        ...initialConfig,
        editorState: initialText === '' ? undefined : buildInitialEditorState(initialText),
      }}
    >
      <ComposerEditorCore
        attachmentIds={attachmentIds}
        attachmentKey={attachmentIds.join('|')}
        attachmentContext={attachmentContext}
        onArmChange={onArmChange}
        onRestore={onRestore}
        onSubmit={onSubmit}
        onReady={onReady}
        onTextChange={onTextChange}
        placeholder={placeholder}
      />
    </LexicalComposer>
  );
}

/**
 * Seeds the document as real initial state, so restoring a rewound request needs
 * no effect and no imperative poke at a mounted editor.
 */
function buildInitialEditorState(text: string): EditorState {
  // A throwaway editor only exists to produce a snapshot; the real one is
  // created by LexicalComposer from the same config.
  const editor = createEditor({
    namespace: initialConfig.namespace,
    nodes: [...(initialConfig.nodes ?? [])],
    onError: (error: Error) => {
      if (import.meta.env.DEV) throw error;
      console.error(error);
    },
  });
  editor.update(
    () => {
      $getRoot().clear().append($createParagraphNode().append($createTextNode(text)));
    },
    { discrete: true },
  );
  return editor.getEditorState();
}

function ComposerEditorCore({
  attachmentIds,
  attachmentKey,
  attachmentContext,
  onArmChange,
  onRestore,
  onSubmit,
  onReady,
  onTextChange,
  placeholder,
}: ComposerEditorCoreProps) {
  const [editor] = useLexicalComposerContext();
  const handlers = useRef({ onArmChange, onRemove: attachmentContext.onRemove, onRestore, onSubmit, onTextChange });
  useLayoutEffect(() => {
    handlers.current = {
      onArmChange,
      onRemove: attachmentContext.onRemove,
      onRestore,
      onSubmit,
      onTextChange,
    };
  }, [attachmentContext.onRemove, onArmChange, onRestore, onSubmit, onTextChange]);
  const armedContentRef = useRef<string | null>(null);
  const contentSignatureRef = useRef('');
  const desiredRef = useRef<readonly string[]>(attachmentIds);
  const syncQueuedRef = useRef(false);
  const exitTimersRef = useRef(new Set<number>());
  const viewsRef = useRef(attachmentContext.views);
  /** Ids whose removal was already reported, so the diff observer stays quiet. */
  const announcedRef = useRef(new Set<string>());
  /** Ids an undo brought back that the target has not confirmed yet. */
  const optimisticAddsRef = useRef(new Set<string>());
  const lastDocumentIdsRef = useRef<string[]>([]);
  const textRef = useRef('');
  /**
   * Removals waiting to be undone, each with the document as it was before.
   *
   * `HistoryPlugin` cannot undo the first change it records — there is no prior
   * state to restore — and a tag that is selected and then immediately dropped is
   * exactly that first change. Selecting a component and changing your mind is
   * the common case, so the removal keeps its own undo entry here and Ctrl+Z
   * prefers it while no typing has happened in between.
   */
  const removalHistoryRef = useRef<Array<{ selectionId: string; state: EditorState; text: string }>>([]);

  useLayoutEffect(() => {
    viewsRef.current = attachmentContext.views;
  }, [attachmentContext.views]);

  useLayoutEffect(() => {
    desiredRef.current = attachmentIds;
    // The target confirmed the re-selection, so the id is authoritative again.
    for (const id of attachmentIds) optimisticAddsRef.current.delete(id);
  }, [attachmentIds]);

  const reference = useCallback(
    () => attachmentReference(viewsRef.current),
    [],
  );

  /**
   * Applies the props to the document.
   *
   * `HistoryPlugin` merges everything within a second of the last change by
   * default, so a removal made right after typing folds into the typing entry and
   * there is nothing left for Ctrl+Z to bring back. A sync that is part of a
   * removal therefore joins the removal's own entry, which the removal opens
   * explicitly with `HISTORY_PUSH_TAG`.
   */
  const runSync = useCallback(
    (desired: readonly string[]) => {
      editor.update(
        () => {
          const result = $reconcileTagNodes(desired);
          if (result.removed.length > 0 || $removingAttachmentIds().length > 0) {
            $addUpdateTag(HISTORY_MERGE_TAG);
          }
        },
        { discrete: true, tag: ATTACHMENT_SYNC_TAG },
      );
    },
    [editor],
  );

  useLayoutEffect(() => {
    runSync(desiredRef.current);
  }, [attachmentKey, runSync]);

  /**
   * Controlled list: the props are the single source of truth. A tag removed
   * optimistically, a stray node, or a second block left over from a previous
   * send is reconciled back on the next commit. Keying this on prop *identity*
   * is what let the document and the selection drift apart before.
   */
  const reconcile = useCallback(() => {
    if (syncQueuedRef.current) return;
    const observed = editor.getEditorState().read(() => ({
      current: $documentTagIds(),
      removing: $removingAttachmentIds(),
      blocks: $blockCount(),
    }));
    if (observed.blocks !== 1) {
      editor.update(() => { $normalizeComposerBlocks(); }, { discrete: true, tag: 'composer-normalize' });
    }
    // An id an undo restored has to survive until the target confirms it, or the
    // reconcile would delete the very node the user just brought back.
    const props = desiredRef.current;
    const restored = [...optimisticAddsRef.current].filter((id) => !props.includes(id));
    const target = (restored.length === 0 ? props : [...props, ...restored])
      .filter((id) => !observed.removing.includes(id));
    if (sameSet(observed.current, target)) return;
    syncQueuedRef.current = true;
    editor.update(
      () => {
        $reconcileTagNodes(target);
      },
      { discrete: true, tag: ATTACHMENT_SYNC_TAG },
    );
    queueMicrotask(() => {
      syncQueuedRef.current = false;
    });
  }, [editor]);

  /**
   * Removal is two-phase so the tag can animate out while the deselect request
   * travels, then it is dropped from the document.
   */
  const requestRemove = useCallback(
    (selectionId: string) => {
      announcedRef.current.add(selectionId);
      removalHistoryRef.current.push({
        selectionId,
        state: editor.getEditorState(),
        text: textRef.current,
      });
      if (removalHistoryRef.current.length > MAX_REMOVAL_HISTORY) {
        removalHistoryRef.current.shift();
      }
      editor.update(
        () => {
          $markAttachmentRemoving(selectionId);
        },
        // Opens its own history entry: the default one second merge window would
        // otherwise swallow the removal into whatever the user typed before it.
        { discrete: true, tag: [REMOVE_START_TAG, HISTORY_PUSH_TAG] },
      );
      handlers.current.onRemove(selectionId);
      const finalize = () => {
        editor.update(
          () => {
            $finalizeRemovingAttachments();
            $reconcileTagNodes(desiredRef.current);
          },
          { discrete: true, tag: [REMOVE_END_TAG, HISTORY_MERGE_TAG] },
        );
      };
      const delay = attachmentExitMs();
      if (delay <= 0) {
        finalize();
        return;
      }
      const timer = window.setTimeout(() => {
        exitTimersRef.current.delete(timer);
        finalize();
      }, delay);
      exitTimersRef.current.add(timer);
    },
    [editor],
  );

  /**
   * A tag can leave the document without going through the two-step removal: a
   * drag that swallows it, a cut, or an undo. Those are gestures, so the target
   * selection has to follow instead of the composer and the page disagreeing.
   *
   * The mirror image is deliberately narrow. An undo restores a whole editor
   * state, which also brings back tags the props had legitimately dropped, so
   * only an id this composer announced as removed counts as a restore. Anything
   * else is reconciled back out in the same commit.
   */
  const observeTagDiff = useCallback((ids: readonly string[]) => {
    const previous = lastDocumentIdsRef.current;
    lastDocumentIdsRef.current = [...ids];
    const current = new Set(ids);
    const prior = new Set(previous);
    const vanished = previous.filter((id) => !current.has(id));
    const appeared = ids.filter((id) => !prior.has(id));
    const unannounced = vanished.filter((id) => !announcedRef.current.has(id));
    if (unannounced.length === 0 && appeared.length === 0) return;
    for (const id of unannounced) {
      announcedRef.current.add(id);
      optimisticAddsRef.current.delete(id);
      handlers.current.onRemove(id);
    }
    for (const id of appeared) {
      if (!announcedRef.current.delete(id)) continue;
      optimisticAddsRef.current.add(id);
      handlers.current.onRestore?.(id);
    }
  }, []);

  useEffect(() => {
    const timers = exitTimersRef.current;
    const arm = createBackspaceArmController({
      onArmChange: (selectionId) => {
        armedContentRef.current = selectionId === null ? null : contentSignatureRef.current;
        handlers.current.onArmChange(selectionId);
      },
    });

    /**
     * Word and line deletion are held back whenever a tag is involved: they are
     * shortcuts, not deliberate gestures, so a tag must survive them.
     */
    const touchesTag = (): boolean =>
      $adjacentAttachment() !== null || $tagsInSelection().length > 0;

    /**
     * Backspace and Delete share one state machine. A drag that covers a tag
     * deletes it outright — a multi-node gesture is deliberate enough — while a
     * collapsed caret keeps the two-step arm so a stray keystroke cannot destroy
     * a citation.
     */
    const handleDelete = (event: KeyboardEvent | null): boolean => {
      const selection = $getSelection();
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        const doomed = $tagsInSelection();
        if (doomed.length === 0) return false;
        event?.preventDefault();
        editor.update(
          () => {
            const live = $getSelection();
            if ($isRangeSelection(live) && !live.isCollapsed()) live.removeText();
            for (const id of doomed) $markAttachmentRemoving(id);
          },
          { discrete: true, tag: 'composer-range-delete' },
        );
        for (const id of doomed) requestRemove(id);
        return true;
      }
      const adjacent = $adjacentAttachment();
      const decision = arm.press({
        selectionId: adjacent,
        caret: adjacent ? `tag:${adjacent}` : '',
        repeat: event?.repeat === true,
        composing: event ? isImeComposing(event, editor.isComposing()) : false,
        modified: event ? hasBlockingModifier(event) : false,
      });
      // `passthrough` must reach the browser: a held Backspace deletes text only
      // if the default action is left alone.
      if (decision.kind === 'passthrough') return false;
      event?.preventDefault();
      if (decision.kind === 'remove' && decision.selectionId) requestRemove(decision.selectionId);
      return true;
    };

    const unregister = mergeRegister(
      editor.registerCommand(KEY_BACKSPACE_COMMAND, handleDelete, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_DELETE_COMMAND, handleDelete, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event) return false;
          if (!isSendEnter(event, editor.isComposing())) return false;
          event.preventDefault();
          handlers.current.onSubmit();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        DELETE_WORD_COMMAND,
        () => touchesTag(),
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        DELETE_LINE_COMMAND,
        () => touchesTag(),
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const clipboard = (event as ClipboardEvent | null)?.clipboardData;
          const text = clipboard?.getData('text/plain') ?? '';
          if (text.length === 0) return false;
          (event as ClipboardEvent | null)?.preventDefault();
          editor.update(() => { $insertComposerText(text); }, { tag: 'composer-paste' });
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(KEY_ESCAPE_COMMAND,
        () => {
          arm.disarm();
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      /**
       * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
       *
       * `HistoryPlugin` only registers the commands, it binds no keys, so without
       * this the shortcut did nothing at all.
       *
       * A removal that has not been followed by typing is undone from the
       * removal's own snapshot, which puts the tag back exactly where it was; the
       * diff observer then asks the target to re-select the component. Anything
       * else is ordinary text history, where Lexical does the right thing.
       */
      editor.registerCommand(
        KEY_MODIFIER_COMMAND,
        (event) => {
          const keyboard = event as KeyboardEvent | null;
          if (!keyboard || typeof keyboard.key !== 'string') return false;
          const key = keyboard.key.toLowerCase();
          if (key !== 'z' && key !== 'y') return false;
          if (keyboard.altKey) return false;
          const redo = key === 'y' || keyboard.shiftKey;
          event.preventDefault();
          const pending = redo ? null : removalHistoryRef.current.at(-1) ?? null;
          if (pending && pending.text === textRef.current) {
            removalHistoryRef.current.pop();
            editor.setEditorState(pending.state, { tag: HISTORIC_TAG });
            return true;
          }
          editor.dispatchCommand(redo ? REDO_COMMAND : UNDO_COMMAND, undefined);
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          arm.disarm();
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection) && arm.matchesCaret($armCaretSignature(selection))) {
            return false;
          }
          arm.disarm();
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerUpdateListener(({ editorState, tags }) => {
        const snapshot = editorState.read(() => ({
          signature: $composerSignature(),
          typed: composeTypedText($composerSegments()),
          ids: $documentTagIds(),
        }));
        contentSignatureRef.current = snapshot.signature;
        textRef.current = snapshot.typed;
        handlers.current.onTextChange(snapshot.typed);
        if (armedContentRef.current !== null && armedContentRef.current !== snapshot.signature) {
          arm.disarm();
        }
        let internal = false;
        for (const tag of tags) {
          if (INTERNAL_UPDATE_TAGS.has(tag)) {
            internal = true;
            break;
          }
        }
        if (!internal) observeTagDiff(snapshot.ids);
        reconcile();
      }),
    );

    return () => {
      unregister();
      arm.dispose();
      armedContentRef.current = null;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, [editor, observeTagDiff, reconcile, requestRemove]);

  useEffect(() => {
    const controller: ComposerEditorController = {
      getPlainText: () => readPlainText(editor, reference()),
      getTypedText: () => readTypedText(editor),
      hasText: () => hasSendableText(readTypedText(editor)),
      clear: () => {
        // A sent message starts a new history: the tags it released must not be
        // restorable, and neither must anything the target confirmed.
        announcedRef.current.clear();
        optimisticAddsRef.current.clear();
        removalHistoryRef.current = [];
        lastDocumentIdsRef.current = [];
        editor.update(
          () => {
            $clearComposerContent();
          },
          { discrete: true, tag: 'composer-clear' },
        );
      },
      clearAttachments: () => {
        announcedRef.current.clear();
        lastDocumentIdsRef.current = [];
        editor.update(
          () => {
            $clearAttachmentNodes();
          },
          { discrete: true, tag: 'attachment-clear' },
        );
      },
      focus: () => {
        editor.focus();
      },
      placeCaretAtEnd: () => {
        editor.update(
          () => {
            $placeCaretAtEnd();
          },
          { discrete: true, tag: 'composer-caret' },
        );
        editor.focus();
      },
      insertText: (text: string) => {
        editor.update(
          () => {
            $insertComposerText(text);
          },
          { tag: 'composer-insert' },
        );
      },
    };
    onReady(controller);
    return () => onReady(null);
  }, [editor, onReady, reference]);

  const context: AttachmentContextValue = {
    views: attachmentContext.views,
    armedSelectionId: attachmentContext.armedSelectionId,
    onRemove: requestRemove,
    onRefresh: attachmentContext.onRefresh,
    onOpen: attachmentContext.onOpen,
    focusEditor: () => editor.focus(),
  };

  return (
    <AttachmentViewProvider value={context}>
      <div className="compose-input-wrap">
        <PlainTextPlugin
          contentEditable={(
            <ContentEditable
              className="compose-input"
              ariaLabel="Ask about the inspected UI"
              placeholder={attachmentIds.length > 0
                ? () => null
                : <span className="compose-placeholder">{placeholder}</span>}
              aria-placeholder={placeholder}
            />
          )}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
    </AttachmentViewProvider>
  );
}

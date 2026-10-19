import { StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { observedEditorChange } from './anchors';
import type HighnotePlugin from './main';

export const refreshComments = StateEffect.define<null>();

export function commentEditor(plugin: HighnotePlugin) {
  return ViewPlugin.fromClass(class {
    private previousPath = '';
    constructor(private view: EditorView) {
      plugin.editorViews.add(view);
      this.previousPath = view.state.field(editorInfoField, false)?.file?.path ?? '';
    }
    destroy(): void {
      plugin.editorViews.delete(this.view);
    }
    update(update: ViewUpdate): void {
      // Classify each transaction separately: one update may contain both input and synchronization.
      for (const transaction of update.transactions) {
        const beforePath = transaction.startState.field(editorInfoField, false)?.file?.path ?? '';
        const path = transaction.state.field(editorInfoField, false)?.file?.path ?? '';
        const change = observedEditorChange(transaction, this.previousPath, beforePath, path,
          update.view.hasFocus, transaction.startState.facet(EditorView.editable));
        if (change) plugin.editorChanged(change.path, change.before, change.after, change.changes, change.userEdit);
        this.previousPath = path;
      }
      this.previousPath = update.state.field(editorInfoField, false)?.file?.path ?? '';
    }
  });
}

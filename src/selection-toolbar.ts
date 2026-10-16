import { Component } from 'obsidian';
import { commentIcon } from './comment-icon';
import { highlightIcon } from './highlight-icon';
import { COMMENT_TOOLBAR_SIZE, toolbarPosition, type ScreenRect } from './selection-position';

export interface SelectionAction {
  owner: object;
  document: Document;
  anchor: ScreenRect;
  boundary: ScreenRect;
  valid: () => boolean;
  perform: () => void;
  highlight?: () => void;
}

/** A single live toolbar across editors and popout windows; its listeners live only while visible. */
export class SelectionToolbar {
  private popup: Component | null = null;
  private owner: object | null = null;
  private element: HTMLElement | null = null;
  show(action: SelectionAction): void {
    this.hide();
    const win = action.document.defaultView;
    if (!win || !action.valid()) return;
    const bounds = {left: Math.max(0, action.boundary.left), top: Math.max(0, action.boundary.top),
      right: Math.min(win.innerWidth, action.boundary.right), bottom: Math.min(win.innerHeight, action.boundary.bottom)};
    const position = toolbarPosition(action.anchor, bounds, COMMENT_TOOLBAR_SIZE.width, COMMENT_TOOLBAR_SIZE.height);
    if (!position) return;
    this.owner = action.owner;
    const popup = new Component();
    this.popup = popup;
    popup.load();
    const root = win.createDiv({cls: 'hn-selection-toolbar', attr: {role: 'toolbar', 'aria-label': '选区标注'}});
    this.element = root;
    popup.register(() => root.remove());
    // Coordinates are measured at runtime; visual styling remains in the stylesheet.
    root.style.setProperty('--hn-toolbar-left', `${position.left}px`);
    root.style.setProperty('--hn-toolbar-top', `${position.top}px`);
    popup.registerDomEvent(root, 'pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    popup.registerDomEvent(root, 'mousedown', event => event.preventDefault());
    for (const [label, cls, icon, perform] of [
      ['标记所选文字', 'hn-selection-highlight', highlightIcon, action.highlight],
      ['评论所选文字', 'hn-selection-comment', commentIcon, action.perform]
    ] as const) {
      if (!perform) continue;
      const button = root.createEl('button', {cls, attr: {type: 'button', 'aria-label': label, title: label}});
      icon(button);
      popup.registerDomEvent(button, 'click', event => {
        event.preventDefault(); event.stopPropagation();
        const valid = action.valid(); this.hide();
        if (valid) perform();
      });
    }
    popup.registerDomEvent(action.document, 'pointerdown', event => {
      const target = event.target;
      if (!(target instanceof win.Node) || !root.contains(target)) this.hide();
    }, true);
    popup.registerDomEvent(action.document, 'selectionchange', () => { if (!action.valid()) this.hide(); });
    popup.registerDomEvent(action.document, 'keydown', event => { if (event.key === 'Escape') this.hide(); });
    popup.registerDomEvent(action.document, 'focusin', event => {
      const target = event.target;
      if (target instanceof win.Element && target.closest('.hn-sidebar, .modal')) this.hide();
    });
    popup.registerDomEvent(action.document, 'scroll', () => this.hide(), true);
    popup.registerDomEvent(win, 'resize', () => this.hide());
    popup.registerDomEvent(win, 'blur', () => this.hide());
    if (this.popup === popup) action.document.body.append(root);
  }
  hide(owner?: object): void {
    if (owner && this.owner !== owner) return;
    const popup = this.popup;
    const element = this.element;
    this.popup = null;
    this.owner = null;
    this.element = null;
    popup?.unload();
    element?.remove();
  }
}

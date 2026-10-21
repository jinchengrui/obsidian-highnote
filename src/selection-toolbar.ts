import { Component } from 'obsidian';
import { commentIcon } from './comment-icon';
import { highlightIcon } from './highlight-icon';
import { COMMENT_TOOLBAR_SIZE, toolbarPosition, touchToolbarPosition, type ScreenRect } from './selection-position';

export interface SelectionAction {
  owner: object;
  document: Document;
  anchor: ScreenRect;
  boundary: ScreenRect;
  touch?: boolean;
  valid: () => boolean;
  perform: () => void;
  highlight?: () => void;
}

/** A single live toolbar across editors and popout windows; its listeners live only while visible. */
export class SelectionToolbar {
  private popup: Component | null = null;
  private owner: object | null = null;
  private element: HTMLElement | null = null;
  private pressed = false;
  get interacting(): boolean { return this.pressed; }
  show(action: SelectionAction): void {
    this.hide();
    const win = action.document.defaultView;
    if (!win || !action.valid()) return;
    const viewport = win.visualViewport;
    const bounds = {left: Math.max(viewport?.offsetLeft ?? 0, action.boundary.left), top: Math.max(viewport?.offsetTop ?? 0, action.boundary.top),
      right: Math.min((viewport?.offsetLeft ?? 0) + (viewport?.width ?? win.innerWidth), action.boundary.right),
      bottom: Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight), action.boundary.bottom)};
    if (action.touch) {
      const navigation = action.document.querySelector('.mobile-navbar')?.getBoundingClientRect();
      if (navigation && navigation.width > 0 && navigation.height > 0 && navigation.top > bounds.top) {
        bounds.bottom = Math.min(bounds.bottom, navigation.top);
      }
    }
    const position = action.touch ? touchToolbarPosition(action.anchor, bounds)
      : toolbarPosition(action.anchor, bounds, COMMENT_TOOLBAR_SIZE.width, COMMENT_TOOLBAR_SIZE.height);
    if (!position) return;
    this.owner = action.owner;
    const popup = new Component();
    this.popup = popup;
    popup.load();
    const root = win.createDiv({cls: 'hn-selection-toolbar', attr: {role: 'toolbar', 'aria-label': '选区标注'}});
    root.toggleClass('hn-selection-touch', Boolean(action.touch));
    this.element = root;
    popup.register(() => root.remove());
    // Coordinates are measured at runtime; visual styling remains in the stylesheet.
    root.style.setProperty('--hn-toolbar-left', `${position.left}px`);
    root.style.setProperty('--hn-toolbar-top', `${position.top}px`);
    popup.registerDomEvent(root, 'pointerdown', event => { this.pressed = action.valid(); event.preventDefault(); event.stopPropagation(); });
    popup.registerDomEvent(root, 'touchstart', event => { this.pressed = this.pressed || action.valid(); event.preventDefault(); event.stopPropagation(); }, {passive: false});
    popup.registerDomEvent(root, 'mousedown', event => event.preventDefault());
    for (const [label, cls, icon, perform] of [
      ['标记所选文字', 'hn-selection-highlight', highlightIcon, action.highlight],
      ['评论所选文字', 'hn-selection-comment', commentIcon, action.perform]
    ] as const) {
      if (!perform) continue;
      const button = root.createEl('button', {cls, attr: {type: 'button', 'aria-label': label, title: label}});
      icon(button);
      if (action.touch) button.createSpan({text: cls === 'hn-selection-highlight' ? '标记' : '评论'});
      const activate = (event: Event) => {
        event.preventDefault(); event.stopPropagation();
        if (this.popup !== popup) return;
        const valid = this.pressed || action.valid(); this.hide();
        if (valid) perform();
      };
      popup.registerDomEvent(button, 'click', activate);
      if (action.touch) popup.registerDomEvent(button, 'touchend', activate, {passive: false});
    }
    popup.registerDomEvent(action.document, 'pointerdown', event => {
      const target = event.target;
      if (!(target instanceof win.Node) || !root.contains(target)) this.hide();
    }, true);
    popup.registerDomEvent(action.document, 'selectionchange', () => { if (!this.pressed && !action.valid()) this.hide(); });
    popup.registerDomEvent(root, 'touchcancel', () => this.hide());
    popup.registerDomEvent(root, 'pointercancel', () => this.hide());
    popup.registerDomEvent(action.document, 'keydown', event => { if (event.key === 'Escape') this.hide(); });
    popup.registerDomEvent(action.document, 'focusin', event => {
      const target = event.target;
      if (target instanceof win.Element && target.closest('.hn-sidebar, .modal')) this.hide();
    });
    popup.registerDomEvent(action.document, 'scroll', () => this.hide(), true);
    popup.registerDomEvent(win, 'resize', () => this.hide());
    if (viewport) {
      const hide = () => this.hide();
      viewport.addEventListener('resize', hide); viewport.addEventListener('scroll', hide);
      popup.register(() => { viewport.removeEventListener('resize', hide); viewport.removeEventListener('scroll', hide); });
    }
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
    this.pressed = false;
    popup?.unload();
    element?.remove();
  }
}

import { MarkdownRenderChild, type MarkdownPostProcessorContext } from 'obsidian';
import type HighnotePlugin from './main';
import type { Thread, Highlight, Anchor } from './model';
import { plainMarkdown, renderedAnchorOffset, selectionInSection } from './reading-map';

/** Text mappings are section-scoped. Ambiguous selections are rejected rather than guessed. */
export interface TextPoint { node: Text; offset: number }
export interface ReadingText { text: string; points: TextPoint[] }

export function collectText(root: HTMLElement): ReadingText {
  const points: TextPoint[] = [];
  let text = '';
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text;
    if (node.parentElement?.closest('button, .copy-code-button')) continue;
    const value = node.data;
    for (let offset = 0; offset < value.length; offset++) points.push({node, offset});
    text += value;
  }
  return {text, points};
}

export class ReadingComments extends MarkdownRenderChild {
  private wrappers: HTMLElement[] = [];
  private selectionFrame: number | null = null;
  private source = '';
  private disposed = false;
  private generation = 0;
  private refreshDeferred = false;
  private renderedSource = '';
  private renderedSignature = '';
  constructor(container: HTMLElement, private context: MarkdownPostProcessorContext, private plugin: HighnotePlugin) { super(container); }
  onload(): void {
    this.plugin.readingViews.add(this);
    this.plugin.registerInteractionDocument(this.containerEl.ownerDocument);
    this.registerDomEvent(this.containerEl.ownerDocument, 'pointerup', () => this.scheduleSelection());
    this.registerDomEvent(this.containerEl.ownerDocument, 'selectionchange', () => {
      if (this.refreshDeferred && this.containerEl.ownerDocument.getSelection()?.isCollapsed) {
        this.refreshDeferred = false;
        this.plugin.run(() => this.refresh());
      }
    });
    this.registerDomEvent(this.containerEl, 'keyup', event => {
      if (event.key === 'Escape') { this.cancelSelection(); this.plugin.selectionToolbar.hide(this); }
      else if (event.key !== 'Tab') this.scheduleSelection();
    });
    this.plugin.run(() => this.refresh());
  }
  onunload(): void {
    this.disposed = true;
    this.generation++;
    this.plugin.readingViews.delete(this);
    this.cancelSelection();
    this.clear();
  }
  private clear(): void {
    this.plugin.selectionToolbar.hide(this);
    for (const span of [...this.wrappers].reverse()) span.replaceWith(...span.childNodes);
    this.wrappers = [];
    this.renderedSignature = '';
  }
  refreshFocus(): void {
    for (const span of this.wrappers) {
      span.toggleClass('hn-mark-active', Boolean(span.dataset.hnThread && span.dataset.hnThread === this.plugin.focused));
      span.toggleClass('hn-highlight-active', Boolean(span.dataset.hnHighlight && span.dataset.hnHighlight === this.plugin.focusedHighlight));
    }
  }
  async refresh(): Promise<void> {
    if (!this.plugin.isReadingContainer(this.containerEl)) { this.clear(); return; }
    this.refreshFocus();
    const generation = ++this.generation;
    const file = this.plugin.app.vault.getFileByPath(this.context.sourcePath);
    if (!file) return;
    const source = await this.plugin.app.vault.cachedRead(file);
    if (this.disposed || generation !== this.generation || !this.containerEl.isConnected) return;
    this.source = source;
    const highlights = this.plugin.fileHighlights(this.context.sourcePath);
    const threads = this.plugin.fileThreads(this.context.sourcePath);
    const signature = JSON.stringify([...highlights, ...threads].map(item => ({id: item.id, anchor: item.anchor,
      missing: item.fileMissing, resolved: 'resolved' in item ? item.resolved : false})));
    if (this.renderedSource === source && this.renderedSignature === signature && this.wrappers.every(span => span.isConnected)) return;
    const selection = this.containerEl.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && this.containerEl.contains(selection.anchorNode)) {
      this.refreshDeferred = true; return;
    }
    this.refreshDeferred = false;
    this.clear();
    const section = this.context.getSectionInfo(this.containerEl);
    if (!section) return;
    const start = this.source.split('\n').slice(0, section.lineStart).reduce((sum, s) => sum + s.length + 1, 0);
    const end = this.source.split('\n').slice(0, section.lineEnd + 1).join('\n').length;
    for (const item of highlights) {
      if (item.fileMissing || item.anchor.state !== 'attached' || item.anchor.from < start || item.anchor.to > end) continue;
      if (this.source.slice(item.anchor.from, item.anchor.to) !== item.anchor.quote) continue;
      this.decorate(item, true);
    }
    for (const thread of threads) {
      if (thread.resolved || thread.fileMissing || thread.anchor.state !== 'attached' || thread.anchor.from < start || thread.anchor.to > end) continue;
      if (this.source.slice(thread.anchor.from, thread.anchor.to) !== thread.anchor.quote) continue;
      this.decorate(thread);
    }
    this.renderedSource = source; this.renderedSignature = signature;
  }
  private decorate(thread: Thread | Highlight, highlight = false): void {
    const rendered = collectText(this.containerEl);
    const plain = plainMarkdown(thread.anchor.quote);
    const section = this.context.getSectionInfo(this.containerEl);
    if (!section) return;
    const base = this.source.split('\n').slice(0, section.lineStart).reduce((sum, line) => sum + line.length + 1, 0);
    const end = this.source.split('\n').slice(0, section.lineEnd + 1).join('\n').length;
    const start = renderedAnchorOffset(this.source.slice(base, end), rendered.text, thread.anchor.from - base, thread.anchor.to - base);
    if (start === null) return;
    const points = rendered.points.slice(start, start + plain.length);
    const groups = new Map<Text, {from: number; to: number}>();
    for (const point of points) {
      const group = groups.get(point.node);
      groups.set(point.node, {from: group?.from ?? point.offset, to: point.offset + 1});
    }
    for (const [node, bounds] of [...groups].reverse()) {
      const range = this.containerEl.ownerDocument.createRange();
      range.setStart(node, bounds.from);
      range.setEnd(node, bounds.to);
      const span = this.containerEl.ownerDocument.defaultView!.createSpan();
      span.className = highlight ? `hn-highlight${this.plugin.focusedHighlight === thread.id ? ' hn-highlight-active' : ''}`
        : `hn-mark${this.plugin.focused === thread.id ? ' hn-mark-active' : ''}`;
      if (highlight) span.dataset.hnHighlight = thread.id;
      else span.dataset.hnThread = thread.id;
      span.tabIndex = 0;
      span.setAttribute('role', 'button');
      span.setAttribute('aria-label', highlight ? '查看标记' : '查看评论');
      const show = () => highlight ? this.plugin.revealHighlight(thread.id) : this.plugin.showThread(thread.id);
      span.addEventListener('click', event => {
        if (!this.containerEl.ownerDocument.getSelection()?.isCollapsed) return;
        event.stopPropagation(); this.plugin.run(show);
      });
      span.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); this.plugin.run(show); }
      });
      range.surroundContents(span);
      this.wrappers.push(span);
    }
  }
  locateAnchor(anchor: Anchor): boolean {
    const section = this.context.getSectionInfo(this.containerEl);
    if (!section) return false;
    const base = this.source.split('\n').slice(0, section.lineStart).reduce((sum, line) => sum + line.length + 1, 0);
    const end = this.source.split('\n').slice(0, section.lineEnd + 1).join('\n').length;
    if (anchor.from < base || anchor.to > end) return false;
    const rendered = collectText(this.containerEl);
    const offset = renderedAnchorOffset(this.source.slice(base, end), rendered.text, anchor.from - base, anchor.to - base);
    const point = offset === null ? undefined : rendered.points[offset];
    if (point?.node.parentElement) point.node.parentElement.scrollIntoView({block: 'center'});
    else this.containerEl.scrollIntoView({block: 'center'});
    return true;
  }
  private cancelSelection(): void {
    if (this.selectionFrame !== null) this.containerEl.ownerDocument.defaultView?.cancelAnimationFrame(this.selectionFrame);
    this.selectionFrame = null;
  }
  private scheduleSelection(): void {
    this.cancelSelection();
    if (this.disposed) return;
    this.selectionFrame = this.containerEl.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.selectionFrame = null;
      this.showSelectionAction();
    });
  }
  private showSelectionAction(): void {
    if (this.disposed || this.plugin.openModals.size || !this.containerEl.isConnected || !this.plugin.canModify || !this.plugin.isReadingContainer(this.containerEl)) return;
    const selection = this.containerEl.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!this.containerEl.contains(range.startContainer) || !this.containerEl.contains(range.endContainer)) return;
    const section = this.context.getSectionInfo(this.containerEl);
    if (!section) return;
    const selected = selection.toString();
    if (!selected.trim()) return;
    const offsets = selectionInSection(this.source, section.lineStart, section.lineEnd, selected);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    const anchor = rects[0];
    if (!anchor) return;
    const source = this.source;
    this.plugin.selectionToolbar.show({owner: this, document: this.containerEl.ownerDocument, anchor,
      boundary: (this.containerEl.closest('.markdown-preview-view') ?? this.containerEl).getBoundingClientRect(),
      valid: () => {
        const current = this.containerEl.ownerDocument.getSelection();
        if (!current || current.isCollapsed || !current.rangeCount || this.disposed || !this.containerEl.isConnected || !this.plugin.canModify || !this.plugin.isReadingContainer(this.containerEl)) return false;
        const next = current.getRangeAt(0);
        return current.toString() === selected && next.startContainer === range.startContainer && next.startOffset === range.startOffset
          && next.endContainer === range.endContainer && next.endOffset === range.endOffset;
      },
      perform: () => {
        if (!offsets) { this.plugin.notify('这段选区无法可靠定位，请缩小到同一段落中的普通文字。'); return; }
        this.plugin.compose({filePath: this.context.sourcePath, source, ...offsets});
      },
      highlight: () => {
        if (!offsets) { this.plugin.notify('这段选区无法可靠定位，请缩小到同一段落中的普通文字。'); return; }
        this.plugin.run(() => this.plugin.highlight({filePath: this.context.sourcePath, source, ...offsets}));
      }
    });
  }
  hasSelection(): boolean {
    if (this.disposed || !this.plugin.isReadingContainer(this.containerEl)) return false;
    const selection = this.containerEl.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return this.containerEl.contains(range.startContainer) && this.containerEl.contains(range.endContainer) && Boolean(selection.toString().trim());
  }
  performSelection(kind: 'comment' | 'highlight'): void {
    if (!this.hasSelection() || !this.plugin.canModify) return;
    const section = this.context.getSectionInfo(this.containerEl);
    const text = this.containerEl.ownerDocument.getSelection()?.toString() ?? '';
    const offsets = section && selectionInSection(this.source, section.lineStart, section.lineEnd, text);
    if (!offsets) { this.plugin.notify('这段选区无法可靠定位，请缩小到同一段落中的普通文字。'); return; }
    const selection = {filePath: this.context.sourcePath, source: this.source, ...offsets};
    if (kind === 'comment') this.plugin.compose(selection);
    else this.plugin.run(() => this.plugin.highlight(selection));
  }
}

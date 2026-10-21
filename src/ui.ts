import { ItemView, Menu, Modal, WorkspaceLeaf, setIcon, type App } from 'obsidian';
import { checkBody, type Thread, type Message, type Highlight } from './model';
import { renderMessage, renderSummary } from './format';
import { commentTime } from './comment-time';
import { annotationOrder, cannotLocate, fileLabels, MessageBatches, MESSAGE_BATCH_SIZE } from './sidebar-model';
import type HighnotePlugin from './main';

export const COMMENTS_VIEW = 'highnote-comments';
const READING_MODE_HINT = '阅读模式下可添加或修改评论与标记。';
type PaneKind = 'comments' | 'highlights';

interface ReplyState {
  expanded: boolean;
  busy: boolean;
  composing: boolean;
}

function formatInput(field: HTMLTextAreaElement, style: 'bold' | 'bullet' | 'ordered'): void {
  const from = field.selectionStart;
  const to = field.selectionEnd;
  const selected = field.value.slice(from, to);
  const replacement = style === 'bold' ? `**${selected || '加粗文字'}**`
    : (selected || '列表内容').split('\n').map((line, i) => `${style === 'bullet' ? '-' : `${i + 1}.`} ${line}`).join('\n');
  field.setRangeText(replacement, from, to, 'select');
  field.dispatchEvent(new field.ownerDocument.defaultView!.Event('input'));
  field.focus();
}

export class MessageModal extends Modal {
  private textarea!: HTMLTextAreaElement;
  private busy = false;
  private composing = false;
  private releaseViewport?: () => void;
  constructor(app: App, private title: string, private initial: string, private save: (body: string) => Promise<void>,
    private report: (error: unknown) => void, private draft?: (body: string) => void, private submitLabel = '保存') { super(app); }
  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.addClass('hn-modal');
    this.modalEl.addClass('hn-message-modal');
    const win = this.contentEl.ownerDocument.defaultView;
    if (win?.visualViewport) {
      const viewport = win.visualViewport;
      const resize = () => this.modalEl.style.setProperty('--hn-visible-height', `${viewport.height}px`);
      viewport.addEventListener('resize', resize); resize();
      this.releaseViewport = () => viewport.removeEventListener('resize', resize);
    }
    const toolbar = this.contentEl.createDiv({cls: 'hn-format-toolbar'});
    this.textarea = this.contentEl.createEl('textarea', {attr: {'aria-label': '评论内容', rows: '8', placeholder: '写下评论…'}});
    this.textarea.value = this.initial;
    for (const [label, style] of [['加粗', 'bold'], ['无序列表', 'bullet'], ['有序列表', 'ordered']] as const) {
      const button = toolbar.createEl('button', {text: label, attr: {type: 'button'}});
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => this.format(style));
    }
    this.contentEl.createEl('p', {text: `支持加粗、有序列表和无序列表。完成后点击“${this.submitLabel}”。`, cls: 'hn-muted'});
    const preview = this.contentEl.createDiv({cls: 'hn-preview hn-message-body'});
    const updatePreview = () => { preview.empty(); renderMessage(preview, this.textarea.value); preview.hidden = !this.textarea.value.trim(); this.draft?.(this.textarea.value); };
    this.textarea.addEventListener('input', updatePreview);
    updatePreview();
    const actions = this.contentEl.createDiv({cls: 'hn-actions'});
    const cancel = actions.createEl('button', {text: '取消', attr: {type: 'button'}});
    cancel.addEventListener('click', () => { if (!this.busy) this.close(); });
    const submit = actions.createEl('button', {text: this.submitLabel, cls: 'mod-cta', attr: {type: 'button'}});
    const save = async () => {
      if (this.busy || this.composing) return;
      try {
        const body = checkBody(this.textarea.value);
        this.busy = true;
        submit.disabled = true;
        this.textarea.disabled = true;
        await this.save(body);
        this.draft?.('');
        this.textarea.value = '';
        this.close();
      } catch (error) { this.report(error); }
      finally { this.busy = false; submit.disabled = false; this.textarea.disabled = false; }
    };
    submit.addEventListener('click', () => { void save(); });
    this.textarea.addEventListener('compositionstart', () => { this.composing = true; });
    this.textarea.addEventListener('compositionend', () => { this.composing = false; });
    this.textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void save(); }
    });
    this.textarea.focus();
  }
  private format(style: 'bold' | 'bullet' | 'ordered'): void {
    formatInput(this.textarea, style);
  }
  onClose(): void { this.releaseViewport?.(); this.draft?.(this.textarea?.value ?? this.initial); this.contentEl.empty(); }
}

export class ConfirmModal extends Modal {
  constructor(app: App, private description: string, private confirm: () => Promise<void>, private report: (error: unknown) => void) { super(app); }
  onOpen(): void {
    this.setTitle('确认删除');
    this.contentEl.createEl('p', {text: this.description});
    const row = this.contentEl.createDiv({cls: 'hn-actions'});
    row.createEl('button', {text: '取消'}).addEventListener('click', () => { this.close(); });
    const remove = row.createEl('button', {text: '删除', cls: 'mod-warning'});
    const confirm = async () => {
      if (remove.disabled) return;
      remove.disabled = true;
      try { await this.confirm(); this.close(); }
      catch (error) { this.report(error); remove.disabled = false; }
    };
    remove.addEventListener('click', () => { void confirm(); });
  }
  onClose(): void { this.contentEl.empty(); }
}

export class CommentsView extends ItemView {
  viewScope: 'current' | 'all' = 'current';
  public paneKind: PaneKind = 'comments';
  private paneState: Record<PaneKind, {status: string; query: string; unlocatable: boolean}> = {
    comments: {status: 'active', query: '', unlocatable: false},
    highlights: {status: 'all', query: '', unlocatable: false}
  };
  private get status(): string { return this.paneState[this.paneKind].status; }
  private set status(value: string) { this.paneState[this.paneKind].status = value; }
  private get query(): string { return this.paneState[this.paneKind].query; }
  private set query(value: string) { this.paneState[this.paneKind].query = value; }
  private list!: HTMLElement;
  private count!: HTMLElement;
  private filter!: HTMLSelectElement;
  private search!: HTMLInputElement;
  private locationFilter!: HTMLInputElement;
  private clearFilters!: HTMLButtonElement;
  private scopeSelect!: HTMLSelectElement;
  private moreButton!: HTMLButtonElement;
  private readingModeHint!: HTMLElement;
  private tabs = new Map<PaneKind, HTMLButtonElement>();
  private searchComposing = false;
  private currentPath = '';
  private page = 1;
  private replies = new Map<string, ReplyState>();
  private messageBatches = new MessageBatches();
  private visibleThreads: string[] = [];
  private pendingRender = false;
  private openedMenus = new Set<Menu>();
  private menuVersion = -1;
  private expandedOverview = '';
  private expandedQuotes = new Set<string>();
  private expandedPaths = new Set<string>();
  constructor(leaf: WorkspaceLeaf, private plugin: HighnotePlugin) { super(leaf); }
  getViewType(): string { return COMMENTS_VIEW; }
  getDisplayText(): string { return '正文标注'; }
  getIcon(): string { return 'messages-square'; }
  onOpen(): Promise<void> {
    this.plugin.registerInteractionDocument(this.contentEl.ownerDocument);
    this.contentEl.empty();
    this.tabs.clear();
    this.searchComposing = false;
    this.contentEl.addClass('hn-sidebar');
    this.contentEl.toggleClass('hn-sidebar-mobile', this.plugin.isMobile);
    const header = this.contentEl.createDiv({cls: 'hn-header'});
    header.createEl('h3', {text: '正文标注'});
    const headerActions = header.createDiv({cls: 'hn-header-actions'});
    if (this.plugin.isMobile) {
      const back = this.iconButton(headerActions, '返回阅读', 'book-open', 'hn-return-reading');
      back.addEventListener('click', () => this.plugin.run(() => this.plugin.returnToReading()));
      const filters = this.iconButton(headerActions, '展开或收起筛选', 'list-filter', 'hn-landscape-filters');
      filters.setAttribute('aria-expanded', 'false');
      filters.addEventListener('click', () => {
        const expanded = !this.contentEl.hasClass('hn-filters-open');
        this.contentEl.toggleClass('hn-filters-open', expanded);
        filters.setAttribute('aria-expanded', String(expanded));
      });
    }
    const scope = headerActions.createEl('select', {cls: 'hn-scope', attr: {'aria-label': '文档范围'}});
    scope.createEl('option', {text: '当前文档', value: 'current'});
    scope.createEl('option', {text: '全部文档', value: 'all'});
    this.scopeSelect = scope;
    scope.value = this.viewScope;
    scope.addEventListener('change', () => { this.viewScope = scope.value === 'all' ? 'all' : 'current'; this.expandedOverview = ''; this.page = 1; this.render(); });
    const tablist = this.contentEl.createDiv({cls: 'hn-tabs', attr: {role: 'tablist', 'aria-label': '正文标注类型'}});
    for (const kind of ['comments', 'highlights'] as const) {
      const tab = tablist.createEl('button', {attr: {type: 'button', role: 'tab', 'data-hn-tab': kind}});
      this.tabs.set(kind, tab);
      tab.addEventListener('click', () => this.switchPane(kind));
      tab.addEventListener('keydown', event => {
        let target: PaneKind;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = kind === 'comments' ? 'highlights' : 'comments';
        else if (event.key === 'Home') target = 'comments';
        else if (event.key === 'End') target = 'highlights';
        else return;
        event.preventDefault();
        this.switchPane(target);
        this.tabs.get(target)?.focus();
      });
    }
    tablist.addClass('hn-tab-row');
    this.moreButton = this.iconButton(headerActions, '正文标注更多操作', 'ellipsis', 'hn-sidebar-more');
    this.moreButton.setAttribute('aria-haspopup', 'menu');
    this.menu(this.moreButton, menu => {
      menu.addItem(item => item.setTitle('阅读回顾').setIcon('book-open')
        .onClick(() => this.plugin.run(() => this.plugin.openReview())));
      menu.addItem(item => item.setTitle('重新加载数据').setIcon('refresh-cw')
        .onClick(() => this.plugin.run(() => this.plugin.refreshData())));
    });
    const searchRow = this.contentEl.createDiv({cls: 'hn-search-row'});
    const searchIcon = searchRow.createSpan({cls: 'hn-search-icon', attr: {'aria-hidden': 'true'}});
    setIcon(searchIcon, 'search');
    this.search = searchRow.createEl('input', {cls: 'hn-search', attr: {type: 'search'}});
    this.search.addEventListener('input', event => {
      if ('isComposing' in event && event.isComposing) return;
      this.query = this.search.value; this.page = 1; this.render();
    });
    this.search.addEventListener('compositionstart', () => { this.searchComposing = true; });
    this.search.addEventListener('compositionend', () => {
      this.searchComposing = false;
      this.query = this.search.value; this.page = 1; this.render();
    });
    const filters = this.contentEl.createDiv({cls: 'hn-filters'});
    this.filter = filters.createEl('select', {cls: 'hn-status-filter', attr: {'aria-label': '评论状态'}});
    for (const [value, text] of [['all', '全部状态'], ['active', '未解决'], ['resolved', '已解决']]) {
      this.filter.createEl('option', {value, text});
    }
    this.filter.addEventListener('change', () => { this.status = this.filter.value; this.page = 1; this.render(); });
    const locationLabel = filters.createEl('label', {cls: 'hn-location-filter'});
    this.locationFilter = locationLabel.createEl('input', {attr: {type: 'checkbox', 'aria-label': '仅看无法定位'}});
    locationLabel.createSpan({text: '仅看无法定位'});
    this.locationFilter.addEventListener('change', () => {
      this.paneState[this.paneKind].unlocatable = this.locationFilter.checked;
      this.page = 1; this.render();
    });
    this.clearFilters = this.iconButton(filters, '清除筛选', 'filter-x', 'hn-clear-filters');
    this.clearFilters.addEventListener('click', () => {
      this.status = this.paneKind === 'comments' ? 'active' : 'all'; this.query = ''; this.paneState[this.paneKind].unlocatable = false;
      this.page = 1; this.render();
    });
    this.readingModeHint = this.contentEl.createDiv({cls: 'hn-reading-mode-hint hn-muted', text: READING_MODE_HINT});
    this.count = this.contentEl.createDiv({cls: 'hn-count'});
    this.list = this.contentEl.createDiv({cls: 'hn-thread-list', attr: {role: 'tabpanel'}});
    const observer = new this.contentEl.ownerDocument.defaultView!.ResizeObserver(() => this.updateQuoteControls());
    observer.observe(this.list);
    this.register(() => observer.disconnect());
    this.render();
    return Promise.resolve();
  }
  public switchPane(kind: PaneKind): void {
    if (this.paneKind === kind) return;
    this.paneKind = kind;
    this.page = 1;
    this.searchComposing = false;
    for (const state of this.replies.values()) state.composing = false;
    if (this.list) this.list.scrollTop = 0;
    this.render();
  }
  reveal(id: string, messageId?: string): void {
    if (this.plugin.store.get(id)) this.switchPane('comments');
    else if (this.plugin.store.getHighlight(id)) this.switchPane('highlights');
    if (this.paneKind === 'comments' && this.viewScope === 'all') this.expandedOverview = id;
    if (this.paneKind === 'comments') {
      const target = this.plugin.store.get(id);
      if (target && (this.status === 'active' && target.resolved || this.status === 'resolved' && !target.resolved)) this.status = 'all';
      if (target && messageId) this.messageBatches.reveal(target, messageId);
    }
    this.query = '';
    this.paneState[this.paneKind].unlocatable = false;
    this.searchComposing = false;
    const candidates = [...(this.paneKind === 'highlights' ? this.highlightsForScope()
      : this.viewScope === 'all' ? this.plugin.store.viewAll() : this.plugin.store.viewFile(this.plugin.activePath))]
      .filter(item => this.paneKind !== 'comments' || !('resolved' in item) || this.status === 'all'
        || (this.status === 'resolved' ? item.resolved : !item.resolved))
      .sort(annotationOrder(this.viewScope === 'all'));
    this.currentPath = this.plugin.activePath;
    this.page = Math.max(1, Math.ceil((candidates.findIndex(t => t.id === id) + 1) / 40));
    this.render();
    const card = this.list.querySelector<HTMLElement>(`[data-${this.paneKind === 'comments' ? 'thread' : 'highlight'}-id="${id}"]`);
    const message = messageId ? [...(card?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])]
      .find(row => row.dataset.messageId === messageId) : null;
    (message ?? card)?.scrollIntoView({block: 'nearest'});
  }
  private highlightsForScope(): readonly Readonly<Highlight>[] {
    if (this.viewScope === 'all') return this.plugin.store.viewHighlights();
    return this.plugin.activePath ? this.plugin.store.viewHighlights(this.plugin.activePath) : [];
  }
  private syncControls(): void {
    const highlights = this.paneKind === 'highlights';
    const label = highlights ? '标记' : '评论';
    this.scopeSelect.value = this.viewScope;
    this.contentEl.toggleClass('is-readonly', !this.plugin.canModify);
    this.readingModeHint.hidden = this.plugin.canModify;
    for (const [kind, tab] of this.tabs) {
      const total = kind === 'highlights' ? this.highlightsForScope().length
        : (this.viewScope === 'all' ? this.plugin.store.viewAll() : this.plugin.store.viewFile(this.plugin.activePath)).length;
      tab.empty();
      tab.createSpan({text: kind === 'comments' ? '评论' : '标记'});
      tab.createSpan({cls: 'hn-tab-count', text: String(total)});
      tab.setAttribute('aria-selected', String(kind === this.paneKind));
      tab.tabIndex = kind === this.paneKind ? 0 : -1;
    }
    this.filter.hidden = highlights;
    this.filter.value = this.status;
    this.locationFilter.checked = this.paneState[this.paneKind].unlocatable;
    this.clearFilters.hidden = !this.query.trim() && (highlights || this.status === 'active') && !this.locationFilter.checked;
    this.search.setAttribute('aria-label', `搜索${label}`);
    this.search.placeholder = highlights ? '搜索原文或文件名' : '搜索原文、评论或文件名';
    if (!this.searchComposing && this.search.value !== this.query) this.search.value = this.query;
    this.moreButton.disabled = false;
    this.count.hidden = !this.query.trim() && (highlights || this.status === 'active') && !this.locationFilter.checked;
    this.list.setAttribute('aria-label', label);
  }
  render(): void {
    if (!this.list || !this.plugin.store) return;
    // Mobile focus/layout events can fire while the native menu animates in.
    // Keep it open unless records or the permission to edit actually changed.
    if (this.plugin.isMobile && this.openedMenus.size && this.menuVersion === this.plugin.store.version && this.plugin.canModify) return;
    this.syncControls();
    if (this.plugin.canModify && this.paneKind === 'comments' && [...this.replies.values()].some(state => state.composing)) { this.pendingRender = true; return; }
    if (!this.plugin.canModify) for (const state of this.replies.values()) state.composing = false;
    this.pendingRender = false;
    const activeElement = this.list.ownerDocument.activeElement;
    const activeInput = activeElement?.matches('.hn-inline-reply-input') ? activeElement as HTMLTextAreaElement : null;
    const restore = activeInput ? {id: activeInput.dataset.threadId, from: activeInput.selectionStart, to: activeInput.selectionEnd} : null;
    const activeNavigation = activeElement?.matches('[data-hn-navigation]') ? activeElement as HTMLButtonElement : null;
    const restoreNavigation = activeNavigation ? {id: activeNavigation.closest<HTMLElement>('[data-thread-id]')?.dataset.threadId,
      direction: activeNavigation.dataset.hnNavigation} : null;
    const activeMessage = activeElement?.closest<HTMLElement>('[data-message-id]');
    const restoreMessage = activeMessage ? {id: activeMessage.closest<HTMLElement>('[data-thread-id]')?.dataset.threadId,
      messageId: activeMessage.dataset.messageId} : null;
    const activeMessagePage = activeElement?.matches('[data-hn-message-page]') ? activeElement as HTMLButtonElement : null;
    const restoreMessagePage = activeMessagePage ? {id: activeMessagePage.closest<HTMLElement>('[data-thread-id]')?.dataset.threadId,
      direction: activeMessagePage.dataset.hnMessagePage} : null;
    const path = this.plugin.activePath;
    if (path !== this.currentPath) { this.page = 1; this.currentPath = path; }
    if (this.paneKind === 'highlights') { this.renderHighlights(); return; }
    const search = this.query.trim().toLocaleLowerCase();
    const threads = (this.viewScope === 'all' ? this.plugin.store.viewAll() : this.plugin.store.viewFile(path)).filter(t => {
      if (this.status === 'active' && t.resolved) return false;
      if (this.status === 'resolved' && !t.resolved) return false;
      if (this.paneState.comments.unlocatable && !cannotLocate(t)) return false;
      return !search || [t.filePath, t.anchor.quote, ...t.messages.filter(m => !m.deleted).map(m => m.body)].join('\n').toLocaleLowerCase().includes(search);
    }).sort(annotationOrder(this.viewScope === 'all'));
    this.page = Math.max(1, Math.min(this.page, Math.ceil(threads.length / 40)));
    const total = this.viewScope === 'all' ? this.plugin.store.viewAll().length : this.plugin.store.viewFile(path).length;
    this.count.setText(`${threads.length} / ${total} 条评论`);
    const scroll = this.list.scrollTop;
    this.closeMenus();
    this.list.empty();
    this.visibleThreads = threads.map(thread => thread.id);
    if (!threads.length) this.list.createDiv({cls: 'hn-empty', text: this.viewScope === 'current' && !path ? '打开一篇 Markdown 笔记开始评论。'
      : `暂无符合条件的评论。${this.plugin.canModify ? '选中文字后点击浮动评论图标。' : ''}`});
    let group = '';
    const labels = fileLabels((this.viewScope === 'all' ? this.plugin.store.viewAll() : threads).map(t => t.filePath));
    const groupCounts = this.groupCounts(threads);
    for (const thread of threads.slice((this.page - 1) * 40, this.page * 40)) {
      if (this.viewScope === 'all' && group !== thread.filePath) {
        group = thread.filePath;
        this.fileHeading(group, labels.get(group) ?? group, groupCounts.get(group) ?? 0);
      }
      if (this.viewScope === 'all' && this.expandedOverview !== thread.id) this.summary(thread);
      else this.card(thread);
    }
    if (threads.length > 40) {
      const nav = this.list.createDiv({cls: 'hn-message-pagination', attr: {'aria-label': '讨论批次'}});
      const previous = nav.createEl('button', {text: '更早讨论', attr: {type: 'button', 'data-hn-thread-page': 'previous'}});
      previous.disabled = this.page === 1;
      nav.createSpan({text: `${(this.page - 1) * 40 + 1}–${Math.min(this.page * 40, threads.length)} / ${threads.length}`});
      const next = nav.createEl('button', {text: '后续讨论', attr: {type: 'button', 'data-hn-thread-page': 'next'}});
      next.disabled = this.page * 40 >= threads.length;
      for (const [button, offset] of [[previous, -1], [next, 1]] as const) button.addEventListener('click', () => {
        if (button.disabled) return;
        this.page += offset; this.render();
        if (this.pendingRender) return;
        this.list.scrollTop = 0;
        const preferred = this.list.querySelector<HTMLButtonElement>(`[data-hn-thread-page="${button.dataset.hnThreadPage}"]:not(:disabled)`)
          ?? this.list.querySelector<HTMLButtonElement>('[data-hn-thread-page]:not(:disabled)');
        preferred?.focus({preventScroll: true});
      });
    }
    this.list.scrollTop = scroll;
    this.updateQuoteControls();
    if (this.plugin.canModify && restore?.id) {
      const input = this.list.querySelector<HTMLTextAreaElement>(`textarea[data-thread-id="${restore.id}"]`);
      if (input && !input.disabled) { input.focus({preventScroll: true}); input.setSelectionRange(restore.from, restore.to); }
    }
    if (restoreNavigation?.id && this.plugin.focused === restoreNavigation.id) {
      this.focusNavigation(restoreNavigation.id, restoreNavigation.direction === 'previous' ? -1 : 1);
    }
    if (restoreMessage?.id) {
      const card = this.list.querySelector<HTMLElement>(`[data-thread-id="${restoreMessage.id}"]`);
      const row = [...(card?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])]
        .find(row => row.dataset.messageId === restoreMessage.messageId);
      row?.querySelector<HTMLButtonElement>('.hn-message-more')?.focus({preventScroll: true});
    }
    if (restoreMessagePage?.id) {
      const card = this.list.querySelector<HTMLElement>(`[data-thread-id="${restoreMessagePage.id}"]`);
      const button = card?.querySelector<HTMLButtonElement>(`[data-hn-message-page="${restoreMessagePage.direction}"]:not(:disabled)`)
        ?? card?.querySelector<HTMLButtonElement>('[data-hn-message-page]:not(:disabled)');
      button?.focus({preventScroll: true});
    }
  }
  private renderHighlights(): void {
    const search = this.query.trim().toLocaleLowerCase();
    const highlights = [...this.highlightsForScope()].filter(highlight => {
      if (this.paneState.highlights.unlocatable && !cannotLocate(highlight)) return false;
      return !search || [highlight.filePath, highlight.anchor.quote].join('\n').toLocaleLowerCase().includes(search);
    }).sort(annotationOrder(this.viewScope === 'all'));
    this.count.setText(`${highlights.length} / ${this.highlightsForScope().length} 条标记`);
    const scroll = this.list.scrollTop;
    this.closeMenus();
    this.list.empty();
    this.visibleThreads = [];
    if (!highlights.length) this.list.createDiv({cls: 'hn-empty', text: this.viewScope === 'current' && !this.plugin.activePath
      ? '打开一篇 Markdown 笔记查看标记。' : `暂无符合条件的标记。${this.plugin.canModify ? '选中文字后点击浮动标记图标。' : ''}`});
    let group = '';
    const labels = fileLabels(this.plugin.store.viewHighlights().map(h => h.filePath));
    const groupCounts = this.groupCounts(highlights);
    for (const highlight of highlights.slice(0, this.page * 40)) {
      if (this.viewScope === 'all' && group !== highlight.filePath) {
        group = highlight.filePath;
        this.fileHeading(group, labels.get(group) ?? group, groupCounts.get(group) ?? 0);
      }
      this.highlightCard(highlight);
    }
    if (highlights.length > this.page * 40) {
      this.list.createEl('button', {text: '加载更多标记'}).addEventListener('click', () => { this.page++; this.render(); });
    }
    this.list.scrollTop = scroll;
    this.updateQuoteControls();
  }
  private groupCounts(items: readonly {filePath: string}[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.filePath, (counts.get(item.filePath) ?? 0) + 1);
    return counts;
  }
  private fileHeading(path: string, label: string, count: number): void {
    const heading = this.list.createDiv({cls: 'hn-file-group'});
    const row = heading.createDiv({cls: 'hn-file-group-row'});
    const toggle = row.createEl('button', {cls: 'hn-file-name', text: label,
      attr: {type: 'button', title: path, 'aria-label': `展开文件路径：${path}`}});
    row.createSpan({cls: 'hn-file-count', text: String(count)});
    const detail = heading.createDiv({cls: 'hn-file-path', text: path});
    detail.hidden = !this.expandedPaths.has(path);
    toggle.setAttribute('aria-expanded', String(!detail.hidden));
    toggle.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden) this.expandedPaths.delete(path); else this.expandedPaths.add(path);
      toggle.setAttribute('aria-expanded', String(!detail.hidden));
    });
  }
  private quote(parent: HTMLElement, item: Readonly<Thread> | Readonly<Highlight>, highlight = false): HTMLElement {
    const wrapper = parent.createDiv({cls: 'hn-quote-block'});
    const quote = wrapper.createEl('button', {cls: highlight ? 'hn-highlight-quote' : 'hn-quote', text: item.anchor.quote,
      attr: {type: 'button', 'aria-label': cannotLocate(item) ? '查看无法定位的原文' : '定位原文',
        title: cannotLocate(item) ? '原文已无法定位' : '定位原文'}});
    quote.addEventListener('click', () => {
      const selection = quote.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(quote)) return;
      this.plugin.run(() => highlight ? this.plugin.locateHighlight(item.id) : this.plugin.locate(item.id));
    });
    const expanded = this.expandedQuotes.has(item.id);
    quote.toggleClass('is-expanded', expanded);
    const expand = wrapper.createEl('button', {cls: 'hn-quote-expand', text: expanded ? '收起原文' : '展开原文',
      attr: {type: 'button', 'aria-expanded': String(expanded)}});
    expand.hidden = !expanded;
    expand.addEventListener('click', () => {
      const opened = !quote.hasClass('is-expanded');
      quote.toggleClass('is-expanded', opened);
      if (opened) this.expandedQuotes.add(item.id); else this.expandedQuotes.delete(item.id);
      expand.setText(opened ? '收起原文' : '展开原文');
      expand.setAttribute('aria-expanded', String(opened));
    });
    return wrapper;
  }
  private updateQuoteControls(): void {
    for (const wrapper of this.list.querySelectorAll<HTMLElement>('.hn-quote-block')) {
      const quote = wrapper.querySelector<HTMLElement>('.hn-quote,.hn-highlight-quote');
      const expand = wrapper.querySelector<HTMLButtonElement>('.hn-quote-expand');
      if (quote && expand) expand.hidden = !quote.hasClass('is-expanded') && quote.scrollHeight <= quote.clientHeight + 1;
    }
  }
  private flags(parent: HTMLElement, thread: Readonly<Thread>): void {
    if (cannotLocate(thread)) parent.createSpan({cls: 'hn-badge-warning', text: thread.fileMissing ? '原文件已删除' : '原文已无法定位'});
  }
  private highlightCard(highlight: Readonly<Highlight>): void {
    const selected = this.plugin.focusedHighlight === highlight.id;
    const card = this.list.createDiv({cls: `hn-card hn-highlight-card${selected ? ' hn-card-active' : ''}`});
    card.dataset.highlightId = highlight.id;
    card.setAttribute('aria-current', String(selected));
    card.addEventListener('pointerdown', event => {
      if (!(event.target instanceof card.ownerDocument.defaultView!.Element) || !event.target.closest('button:disabled')) this.plugin.focusHighlight(highlight.id);
    });
    card.addEventListener('focusin', () => this.plugin.focusHighlight(highlight.id));
    const header = card.createDiv({cls: 'hn-highlight-card-header'});
    const time = commentTime(highlight.createdAt);
    header.createSpan({cls: 'hn-highlight-color-dot', attr: {'aria-hidden': 'true'}});
    header.createEl('time', {text: time.label, attr: {datetime: highlight.createdAt, title: time.full}});
    if (this.plugin.canModify) {
      const remove = this.iconButton(header, '删除标记', 'trash-2', 'hn-highlight-remove');
      remove.addEventListener('click', () => this.plugin.run(async () => {
        this.requireModification();
        this.plugin.openModal(new ConfirmModal(this.app, '删除这条标记？原文会保留。', async () => {
          this.requireModification();
          await this.plugin.removeHighlight(highlight.id);
        }, error => this.plugin.report(error)));
      }));
    }
    this.quote(card, highlight, true);
    const invalid = cannotLocate(highlight);
    if (invalid) card.createDiv({cls: 'hn-highlight-status hn-badge-warning',
      text: highlight.fileMissing ? '原文件已删除' : '原文已无法定位'});
    const locate = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target;
      if (target instanceof card.ownerDocument.defaultView!.Element && target.closest('button,input,textarea,a')) return;
      const selection = card.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(card)) return;
      this.plugin.run(() => this.plugin.locateHighlight(highlight.id));
    };
    card.tabIndex = 0;
    card.setAttribute('aria-label', `定位标记：${highlight.anchor.quote}`);
    card.addEventListener('click', locate);
    card.addEventListener('keydown', event => {
      if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); locate(event); }
    });
  }
  private requireModification(): void {
    const canModify = this.plugin.canModify;
    this.plugin.requireReadingMode();
    if (!canModify) throw new Error(READING_MODE_HINT);
  }
  onClose(): Promise<void> {
    this.closeMenus();
    return Promise.resolve();
  }
  private closeMenus(): void {
    for (const menu of this.openedMenus) menu.hide();
    this.openedMenus.clear();
  }
  private menu(button: HTMLButtonElement, build: (menu: Menu) => void): void {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      this.closeMenus();
      const menu = new Menu();
      build(menu);
      this.menuVersion = this.plugin.store.version;
      this.openedMenus.add(menu);
      button.setAttribute('aria-expanded', 'true');
      menu.onHide(() => { this.openedMenus.delete(menu); button.setAttribute('aria-expanded', 'false'); });
      const rect = button.getBoundingClientRect();
      menu.showAtPosition({x: rect.right, y: rect.bottom}, button.ownerDocument);
    });
  }
  private iconButton(parent: HTMLElement, label: string, icon: string, className = ''): HTMLButtonElement {
    const button = parent.createEl('button', {cls: `hn-icon-button ${className}`, attr: {type: 'button', 'aria-label': label, title: label}});
    setIcon(button, icon);
    return button;
  }
  private focusNavigation(id: string, direction: number): void {
    const card = this.list.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);
    if (!card) return;
    const preferred = direction < 0 ? 'previous' : 'next';
    const fallback = direction < 0 ? 'next' : 'previous';
    const button = card.querySelector<HTMLButtonElement>(`[data-hn-navigation="${preferred}"]:not(:disabled)`)
      ?? card.querySelector<HTMLButtonElement>(`[data-hn-navigation="${fallback}"]:not(:disabled)`);
    card.scrollIntoView({block: 'nearest'});
    if (button) { button.focus({preventScroll: true}); button.scrollIntoView({block: 'nearest'}); }
    else { card.tabIndex = -1; card.focus({preventScroll: true}); }
  }
  private commentHeader(card: HTMLElement, thread: Readonly<Thread>, expanded: boolean): void {
    const header = card.createDiv({cls: 'hn-card-header'});
    this.quote(header, thread);
    const tools = header.createDiv({cls: 'hn-thread-tools'});
    if (expanded && this.viewScope === 'all') {
      const collapse = this.iconButton(tools, '返回合并展示', 'chevrons-up', 'hn-overview-collapse');
      collapse.addEventListener('click', () => {
        this.expandedOverview = '';
        this.render();
        this.list.querySelector<HTMLElement>(`[data-thread-id="${thread.id}"] .hn-summary-body`)?.focus({preventScroll: true});
      });
    }
    const current = this.visibleThreads.indexOf(thread.id);
    for (const [offset, label, icon] of [[-1, '上一条讨论', 'chevron-up'], [1, '下一条讨论', 'chevron-down']] as const) {
      const button = this.iconButton(tools, label, icon);
      button.dataset.hnNavigation = offset < 0 ? 'previous' : 'next';
      const target = this.visibleThreads[current + offset];
      button.disabled = !target;
      if (!target) button.removeAttribute('title');
      button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !button.disabled) button.click();
      });
      button.addEventListener('click', () => {
        if (button.disabled || !target || !this.plugin.store.get(target)) { this.render(); return; }
        if (expanded && this.viewScope === 'all') this.expandedOverview = target;
        this.plugin.focusThread(target);
        this.page = Math.max(1, Math.ceil((current + offset + 1) / 40));
        this.render();
        this.focusNavigation(target, offset);
      });
    }
    if (this.plugin.canModify) {
      const resolve = this.iconButton(tools, thread.resolved ? '重新打开讨论' : '解决讨论', thread.resolved ? 'rotate-ccw' : 'circle-check', 'hn-resolve');
      resolve.title = thread.resolved ? '已解决，点击重新打开' : '标为已解决';
      resolve.addEventListener('click', () => {
        if (resolve.disabled) return;
        this.plugin.run(async () => {
          try {
            this.requireModification();
            resolve.disabled = true;
            const resolved = !thread.resolved;
            await this.plugin.store.update(thread.id, t => {
              this.requireModification();
              t.resolved = resolved;
            });
          } finally { resolve.disabled = false; this.render(); }
        });
      });
    }
  }
  private summary(thread: Readonly<Thread>): void {
    const card = this.list.createDiv({cls: `hn-card hn-summary${thread.resolved ? ' hn-card-resolved' : ''}${this.plugin.focused === thread.id ? ' hn-card-active' : ''}`});
    card.dataset.threadId = thread.id;
    card.setAttribute('aria-current', String(this.plugin.focused === thread.id));
    card.addEventListener('pointerdown', event => {
      if (!(event.target instanceof card.ownerDocument.defaultView!.Element) || !event.target.closest('button:disabled')) this.plugin.focusThread(thread.id);
    });
    card.addEventListener('focusin', () => this.plugin.focusThread(thread.id));
    this.commentHeader(card, thread, false);
    const status = card.createDiv({cls: 'hn-summary-status'});
    this.flags(status, thread);
    let latest: Message | undefined;
    for (let index = thread.messages.length - 1; index >= 0; index--) {
      if (!thread.messages[index]!.deleted) { latest = thread.messages[index]; break; }
    }
    if (latest) {
      const shown = latest.updatedAt;
      const time = commentTime(shown);
      status.createEl('time', {text: time.label, attr: {datetime: shown, title: time.full}});
      if (latest.updatedAt !== latest.createdAt) status.createSpan({cls: 'hn-edited', text: '（编辑过）'});
    }
    const body = card.createEl('button', {cls: 'hn-summary-body hn-message-body',
      attr: {type: 'button', 'aria-label': '查看完整讨论', 'aria-expanded': 'false'}});
    const batch = this.messageBatches.get(thread);
    if (batch.total) renderSummary(body, batch.messages.map(message => message.body));
    else body.setText('该讨论的消息已删除');
    body.addEventListener('click', () => this.expandOverview(thread.id, false));
    this.messagePagination(card, thread, batch);
    const footer = card.createDiv({cls: 'hn-card-footer'});
    if (this.plugin.canModify) {
      const reply = footer.createEl('button', {cls: 'hn-overview-reply', text: '回复…',
        attr: {type: 'button', 'aria-label': '回复此讨论'}});
      reply.addEventListener('click', () => {
        if (this.plugin.canModify) this.expandOverview(thread.id, true);
      });
    } else footer.createDiv({cls: 'hn-inline-reply-space', attr: {'aria-hidden': 'true'}});

  }
  private expandOverview(id: string, reply: boolean): void {
    this.expandedOverview = id;
    this.plugin.focusThread(id);
    if (reply) this.replyState(id).expanded = true;
    this.render();
    const card = this.list.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);
    if (reply && this.plugin.isMobile) card?.querySelector<HTMLButtonElement>('.hn-mobile-reply')?.click();
    else card?.querySelector<HTMLElement>(reply ? '.hn-inline-reply-input' : '.hn-overview-collapse')?.focus({preventScroll: true});
  }
  private card(thread: Readonly<Thread>): void {
    const card = this.list.createDiv({cls: `hn-card${thread.resolved ? ' hn-card-resolved' : ''}${this.plugin.focused === thread.id ? ' hn-card-active' : ''}`});
    card.dataset.threadId = thread.id;
    card.setAttribute('aria-current', String(this.plugin.focused === thread.id));
    card.addEventListener('pointerdown', event => {
      if (!(event.target instanceof card.ownerDocument.defaultView!.Element) || !event.target.closest('button:disabled')) this.plugin.focusThread(thread.id);
    });
    card.addEventListener('focusin', () => this.plugin.focusThread(thread.id));
    this.commentHeader(card, thread, true);
    const messages = card.createDiv({cls: 'hn-messages'});
    const batch = this.messageBatches.get(thread);
    for (const [index, message] of batch.messages.entries()) {
      this.message(messages, thread, message, index === 0, batch.messageId === message.id);
    }
    this.messagePagination(card, thread, batch);
    const footer = card.createDiv({cls: 'hn-card-footer'});
    this.composer(footer, thread);
  }
  private messagePagination(card: HTMLElement, thread: Readonly<Thread>, batch: ReturnType<MessageBatches['get']>): void {
    if (batch.total <= MESSAGE_BATCH_SIZE) return;
    const nav = card.createDiv({cls: 'hn-message-pagination', attr: {'data-hn-message-pagination': '',
      'aria-label': `讨论消息，第 ${batch.page + 1} / ${batch.pages} 批`}});
    const first = this.iconButton(nav, '首批消息', 'chevrons-left');
    first.dataset.hnMessagePage = 'first';
    const previous = nav.createEl('button', {text: '更早消息', attr: {type: 'button', 'data-hn-message-page': 'previous'}});
    nav.createSpan({text: `${batch.start + 1}–${batch.start + batch.messages.length} / ${batch.total}`, attr: {'aria-live': 'polite'}});
    const next = nav.createEl('button', {text: '后续消息', attr: {type: 'button', 'data-hn-message-page': 'next'}});
    const last = this.iconButton(nav, '最新消息', 'chevrons-right');
    last.dataset.hnMessagePage = 'last';
    first.disabled = previous.disabled = batch.page === 0;
    next.disabled = last.disabled = batch.page === batch.pages - 1;
    for (const [button, page] of [[first, 0], [previous, batch.page - 1], [next, batch.page + 1], [last, batch.pages - 1]] as const) {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        const current = this.plugin.store.get(thread.id);
        if (!current) { this.messageBatches.delete(thread.id); this.render(); return; }
        this.messageBatches.setPage(current, page);
        this.render();
        if (this.pendingRender) return;
        const updated = this.list.querySelector<HTMLElement>(`[data-thread-id="${thread.id}"]`);
        (updated?.querySelector<HTMLElement>('.hn-message,.hn-summary-body') ?? updated)?.scrollIntoView({block: 'start'});
        const preferred = updated?.querySelector<HTMLButtonElement>(`[data-hn-message-page="${button.dataset.hnMessagePage}"]:not(:disabled)`)
          ?? updated?.querySelector<HTMLButtonElement>('[data-hn-message-page]:not(:disabled)');
        preferred?.focus({preventScroll: true});
      });
    }
  }
  private message(container: HTMLElement, thread: Readonly<Thread>, message: Message, first = false, current = false): void {
    const row = container.createDiv({cls: 'hn-message'});
    row.dataset.messageId = message.id;
    row.setAttribute('aria-current', String(current));
    const remember = () => {
      this.messageBatches.reveal(thread, message.id);
      for (const sibling of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
        sibling.setAttribute('aria-current', String(sibling === row));
      }
    };
    row.addEventListener('pointerdown', remember);
    row.addEventListener('focusin', remember);
    const content = row.createDiv({cls: 'hn-message-content'});
    const meta = content.createDiv({cls: 'hn-message-meta'});
    if (first) this.flags(meta, thread);
    const edited = message.updatedAt !== message.createdAt;
    const shownAt = edited ? message.updatedAt : message.createdAt;
    const time = commentTime(shownAt);
    meta.createEl('time', {text: time.label, attr: {datetime: shownAt, title: time.full}});
    if (edited) meta.createSpan({text: '（编辑过）', cls: 'hn-edited'});
    if (!message.deleted && this.plugin.canModify) {
      const more = this.iconButton(meta, '消息更多操作', 'ellipsis', 'hn-message-more');
      more.setAttribute('aria-haspopup', 'menu');
      this.menu(more, menu => {
        menu.addItem(item => item.setTitle('编辑').setIcon('pencil').setDisabled(!this.plugin.canModify).onClick(() => {
          this.plugin.run(async () => {
            this.requireModification();
            this.plugin.openModal(new MessageModal(this.app, '编辑评论', message.body, async body => {
              this.requireModification();
              await this.plugin.store.update(thread.id, t => {
                this.requireModification();
                const current = t.messages.find(m => m.id === message.id);
                if (!current || current.deleted) throw new Error('消息已删除。');
                if (current.updatedAt !== message.updatedAt) throw new Error('消息已更新，请重新打开编辑。');
                current.body = checkBody(body); current.updatedAt = new Date().toISOString();
              });
              const current = this.plugin.store.get(thread.id);
              if (current) this.messageBatches.reveal(current, message.id);
              this.render();
            }, error => this.plugin.report(error)));
          });
        }));
        menu.addSeparator();
        menu.addItem(item => item.setTitle('删除').setIcon('trash-2').setDisabled(!this.plugin.canModify).onClick(() => {
          this.plugin.run(async () => {
            this.requireModification();
            const last = this.plugin.store.get(thread.id)?.messages.filter(m => !m.deleted).length === 1;
            this.plugin.openModal(new ConfirmModal(this.app,
              last ? '删除最后一条消息？空讨论、原文摘录和对应下划线将一并移除，同段标记保留。'
                : '删除这条消息？删除后不再显示，其他评论和回复保留。',
              async () => {
                this.requireModification();
                const removed = await this.plugin.store.deleteMessage(thread.id, message.id, last, () => this.requireModification());
                if (removed) {
                  this.plugin.drafts.delete(`inline:${thread.id}`); this.replies.delete(thread.id);
                  this.messageBatches.delete(thread.id);
                  if (this.expandedOverview === thread.id) this.expandedOverview = '';
                  if (this.plugin.focused === thread.id) this.plugin.clearFocus();
                }
                this.render();
              }, error => this.plugin.report(error)));
          });
        }));
      });
    }
    const body = content.createDiv({cls: 'hn-message-body'});
    renderMessage(body, message.body);
  }
  private replyState(id: string): ReplyState {
    let state = this.replies.get(id);
    if (!state) {
      state = {expanded: Boolean(this.plugin.drafts.get(`inline:${id}`)), busy: false, composing: false};
      this.replies.set(id, state);
    }
    return state;
  }
  private composer(card: HTMLElement, thread: Readonly<Thread>): void {
    const state = this.replyState(thread.id);
    const key = `inline:${thread.id}`;
    if (!this.plugin.canModify) {
      card.createDiv({cls: 'hn-inline-reply-space', attr: {'aria-hidden': 'true'}});
      return;
    }
    if (this.plugin.isMobile) {
      const reply = card.createEl('button', {cls: 'hn-mobile-reply',
        text: this.plugin.drafts.has(key) ? '继续回复…' : '回复…', attr: {type: 'button', 'aria-label': '回复评论'}});
      reply.addEventListener('click', () => this.plugin.run(async () => {
        this.requireModification();
        if (this.plugin.openModals.size) return;
        this.plugin.openModal(new MessageModal(this.app, '回复评论', this.plugin.drafts.get(key) ?? '', async body => {
          const messageId = crypto.randomUUID();
          await this.plugin.store.update(thread.id, current => {
            this.requireModification();
            const now = new Date().toISOString();
            current.messages.push({id: messageId, body: checkBody(body), deleted: false, createdAt: now, updatedAt: now});
          });
          const current = this.plugin.store.get(thread.id);
          if (current) this.messageBatches.reveal(current, messageId);
          this.plugin.drafts.delete(key); this.render();
        }, error => this.plugin.report(error), body => {
          if (body) this.plugin.drafts.set(key, body); else this.plugin.drafts.delete(key);
          reply.setText(body ? '继续回复…' : '回复…');
        }, '发送'));
      }));
      return;
    }
    const composer = card.createDiv({cls: `hn-inline-reply${state.expanded ? ' is-expanded' : ''}`});
    const textarea = composer.createEl('textarea', {cls: 'hn-inline-reply-input', attr: {
      rows: state.expanded ? '3' : '1', placeholder: '回复…', 'aria-label': '回复内容', 'data-thread-id': thread.id
    }});
    textarea.value = this.plugin.drafts.get(key) ?? '';
    textarea.disabled = state.busy;
    const controls = composer.createDiv({cls: 'hn-inline-reply-controls'});
    const toolbar = controls.createDiv({cls: 'hn-inline-format'});
    const preview = controls.createDiv({cls: 'hn-inline-preview hn-message-body', attr: {'aria-label': '回复预览'}});
    const actions = controls.createDiv({cls: 'hn-inline-reply-actions'});
    const cancel = actions.createEl('button', {text: '取消', cls: 'hn-inline-cancel', attr: {type: 'button'}});
    const submit = actions.createEl('button', {text: '发送', cls: 'mod-cta hn-inline-send', attr: {type: 'button'}});
    const update = () => {
      const value = textarea.value;
      if (value) this.plugin.drafts.set(key, value); else this.plugin.drafts.delete(key);
      submit.disabled = !this.plugin.canModify || state.busy || !value.trim();
      cancel.disabled = state.busy;
      preview.empty();
      if (value.trim()) renderMessage(preview, value);
      preview.toggleClass('is-empty', !value.trim());
    };
    const expand = () => {
      state.expanded = true;
      composer.addClass('is-expanded');
      textarea.rows = 3;
    };
    for (const [label, style, icon] of [['加粗', 'bold', 'bold'], ['无序列表', 'bullet', 'list'], ['有序列表', 'ordered', 'list-ordered']] as const) {
      const button = this.iconButton(toolbar, label, icon);
      button.disabled = state.busy;
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => { if (this.plugin.canModify && !state.busy) formatInput(textarea, style); });
    }
    textarea.addEventListener('focus', expand);
    textarea.addEventListener('input', update);
    textarea.addEventListener('compositionstart', () => { state.composing = true; });
    textarea.addEventListener('compositionend', () => {
      state.composing = false;
      update();
      if (this.pendingRender) this.render();
    });
    cancel.addEventListener('click', () => {
      if (state.busy) return;
      this.plugin.drafts.delete(key);
      state.expanded = false;
      textarea.blur();
      this.render();
    });
    const send = async () => {
      if (state.busy || state.composing || !textarea.value.trim()) return;
      try {
        this.requireModification();
        const body = checkBody(textarea.value);
        state.busy = true;
        textarea.disabled = true;
        update();
        const messageId = crypto.randomUUID();
        await this.plugin.store.update(thread.id, current => {
          this.requireModification();
          const now = new Date().toISOString();
          current.messages.push({id: messageId, body, deleted: false, createdAt: now, updatedAt: now});
        });
        const current = this.plugin.store.get(thread.id);
        if (current) this.messageBatches.reveal(current, messageId);
        this.plugin.drafts.delete(key);
        state.expanded = false;
        textarea.blur();
      } catch (error) { this.plugin.report(error); }
      finally {
        state.busy = false; textarea.disabled = false; this.render();
        const batch = this.plugin.store.get(thread.id);
        const id = batch ? this.messageBatches.get(batch).messageId : '';
        if (id) [...this.list.querySelectorAll<HTMLElement>('[data-message-id]')]
          .find(row => row.dataset.messageId === id)?.scrollIntoView({block: 'nearest'});
      }
    };
    submit.addEventListener('click', () => { void send(); });
    textarea.addEventListener('keydown', event => {
      if (event.isComposing || state.composing) return;
      if (event.key === 'Enter' && !event.shiftKey && (!this.plugin.isMobile || event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); }
      else if (event.key === 'Escape' && !state.busy) {
        event.preventDefault(); textarea.blur(); state.expanded = Boolean(textarea.value); this.render(); this.plugin.clearFocus();
      }
    });
    update();
  }
}

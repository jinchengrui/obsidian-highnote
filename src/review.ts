import { ItemView, Modal, WorkspaceLeaf, type EventRef, type ViewStateResult } from 'obsidian';
import { renderMessage } from './format';
import { commentTime } from './comment-time';
import { fileLabels } from './sidebar-model';
import { localDay, renamedSourcePath, type ReviewEntry, type ReviewKind } from './review-model';
import { contentGroups, type ContentGroup } from './review-content';
import { heatmapWeeks, heatmapRange, monday, shiftDay } from './review-heatmap';
import type HighnotePlugin from './main';

export const REVIEW_VIEW = 'highnote-review';
const PAGE_SIZE = 40;
/** Source-context cards share the same live data, with bounded groups and message batches. */
export class ReviewView extends ItemView {
  kind: ReviewKind = 'comments';
  query = '';
  viewScope: 'all' | 'current' = 'all';
  sourcePath = '';
  includeReplies = true;
  calendarOpen = true;
  private heatEndWeek = '';
  private heatWeeks = 1;
  private heatRevision = 0;
  private heatKey = '';
  private heatObserver: ResizeObserver | null = null;
  private heatFrame: number | null = null;
  private heatStats!: HTMLElement;
  private heatBody!: HTMLElement;
  private heatGrid!: HTMLElement;
  private heatMonths!: HTMLElement;
  private heatRangeLabel!: HTMLElement;
  private heatOlder!: HTMLButtonElement;
  private heatNewer!: HTMLButtonElement;
  private heatLatest!: HTMLButtonElement;
  private heatToggle!: HTMLButtonElement;
  private heatActions!: HTMLElement;
  private heatSparse!: HTMLButtonElement;
  private selectedDay = '';
  private focusedDay = '';
  private page = 0;
  private results: readonly ReviewEntry[] = [];
  private groups: readonly ContentGroup[] = [];
  private allGroups: readonly ContentGroup[] = [];
  private sourceEntries: readonly ReviewEntry[] = [];
  private groupedSource: readonly ReviewEntry[] = [];
  private groupedReplies = true;
  private groupedScope = '';
  private groupedPath = '';
  private dayCounts = new Map<string, number>();
  private labels = new Map<string, string>();
  private version = -1;
  private searchTimer: number | null = null;
  private savedScroll = 0;
  private calendar!: HTMLElement;
  private feed!: HTMLElement;
  private search!: HTMLInputElement;
  private counts!: HTMLElement;
  private feedback!: HTMLElement;
  private replyToggle!: HTMLInputElement;
  private exportButton!: HTMLButtonElement;
  private scopeSelect!: HTMLSelectElement;
  private composing = false;
  private renameEvent: EventRef | null = null;
  private messagePages = new Map<string, number>();
  constructor(leaf: WorkspaceLeaf, private plugin: HighnotePlugin) { super(leaf); this.calendarOpen = !plugin.isMobile; }
  getViewType(): string { return REVIEW_VIEW; }
  getDisplayText(): string { return '阅读回顾'; }
  getIcon(): string { return 'book-open'; }
  getState(): Record<string, unknown> {
    return {kind: this.kind, query: this.query, scope: this.viewScope, sourcePath: this.sourcePath, includeReplies: this.includeReplies,
      calendarOpen: this.calendarOpen, heatEndWeek: this.heatEndWeek, selectedDay: this.selectedDay, page: this.page, scroll: this.contentEl.scrollTop};
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (state && typeof state === 'object') {
      const s = state as Record<string, unknown>;
      this.kind = s.kind === 'highlights' ? 'highlights' : 'comments'; this.viewScope = s.scope === 'current' ? 'current' : 'all';
      this.sourcePath = typeof s.sourcePath === 'string' ? s.sourcePath : '';
      this.query = typeof s.query === 'string' ? s.query : ''; this.includeReplies = s.includeReplies !== false;
      this.calendarOpen = typeof s.calendarOpen === 'boolean' ? s.calendarOpen : !this.plugin.isMobile;
      this.heatEndWeek = typeof s.heatEndWeek === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(s.heatEndWeek)
        && Number.isFinite(Date.parse(s.heatEndWeek + 'T12:00:00Z')) ? monday(s.heatEndWeek) : '';
      this.selectedDay = typeof s.selectedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(s.selectedDay) ? s.selectedDay : '';
      this.page = typeof s.page === 'number' && Number.isSafeInteger(s.page) && s.page >= 0 ? s.page : 0;
      this.savedScroll = typeof s.scroll === 'number' && Number.isFinite(s.scroll) ? Math.max(0, s.scroll) : 0;
    }
    if (this.feed) { this.search.value = this.query; this.refresh(true); this.contentEl.scrollTop = this.savedScroll; }
    await super.setState(state, result);
  }
  onOpen(): Promise<void> {
    this.contentEl.empty(); this.contentEl.addClass('hn-review');
    this.contentEl.toggleClass('hn-review-mobile', this.plugin.isMobile);
    const page = this.contentEl.createDiv({cls: 'hn-review-page'}), head = page.createDiv({cls: 'hn-review-heading'});
    const title = head.createDiv(); title.createEl('h1', {text: '阅读回顾'});
    title.createEl('p', {cls: 'hn-review-description', text: this.plugin.isMobile ? '回顾已保存的想法，回到原文继续评论与标记。' : '读回原文，也读懂当时的想法。'});
    const actions = head.createDiv({cls: 'hn-review-heading-actions'});
    this.scopeSelect = actions.createEl('select', {attr: {'aria-label': '回顾文档范围'}});
    this.scopeSelect.createEl('option', {value: 'all', text: '全部文档'});
    this.scopeSelect.createEl('option', {value: 'current', text: '当前文档'});
    if (!this.sourcePath) this.sourcePath = this.plugin.activePath;
    this.scopeSelect.addEventListener('change', () => {
      this.viewScope = this.scopeSelect.value === 'current' ? 'current' : 'all';
      if (this.viewScope === 'current' && !this.sourcePath && this.plugin.activePath) this.sourcePath = this.plugin.activePath;
      this.selectedDay = ''; this.page = 0; this.refresh(true); this.persist();
    });
    this.exportButton = actions.createEl('button', {text: '导出', attr: {type: 'button', 'aria-label': '导出阅读回顾'}});
    this.exportButton.addEventListener('click', () => {
      this.commitSearch(); this.plugin.openReviewExport(this.kind, this.query, this.includeReplies, this.exportButton, this.viewScope, this.sourcePath);
    });
    if (this.plugin.isMobile) {
      const refresh = actions.createEl('button', {text: '刷新', attr: {type: 'button', 'aria-label': '刷新阅读回顾'}});
      refresh.addEventListener('click', () => this.plugin.run(async () => {
        if (refresh.disabled) return;
        refresh.disabled = true;
        try { await this.plugin.refreshMobileData(true); this.refresh(true); }
        finally { refresh.disabled = false; }
      }));
    }
    const controls = page.createDiv({cls: 'hn-review-controls'}), tabs = controls.createDiv({cls: 'hn-review-tabs', attr: {role: 'tablist', 'aria-label': '回顾内容'}});
    for (const [kind, text] of [['comments', '评论'], ['highlights', '标记']] as const) {
      const tab = tabs.createEl('button', {text, attr: {type: 'button', role: 'tab', 'data-review-kind': kind}});
      tab.addEventListener('click', () => { this.kind = kind; this.page = 0; this.selectedDay = ''; this.refresh(true); this.persist(); });
      tab.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); const other = tabs.querySelector<HTMLButtonElement>(`[data-review-kind="${kind === 'comments' ? 'highlights' : 'comments'}"]`);
        other?.click(); other?.focus();
      });
    }
    const replies = controls.createEl('label', {cls: 'hn-review-replies'});
    this.replyToggle = replies.createEl('input', {attr: {type: 'checkbox', 'aria-label': '包含回复'}}); replies.createSpan({text: '包含回复'});
    this.replyToggle.addEventListener('change', () => { this.includeReplies = this.replyToggle.checked; this.page = 0; this.refresh(true); this.persist(); });
    this.calendar = page.createDiv({cls: 'hn-review-calendar'});
    const searchRow = page.createDiv({cls: 'hn-review-search-row'});
    this.search = searchRow.createEl('input', {cls: 'hn-review-search', attr: {type: 'search', 'aria-label': '搜索回顾', placeholder: '搜索原文、评论或来源…'}}); this.search.value = this.query;
    this.counts = searchRow.createSpan({cls: 'hn-review-count', attr: {role: 'status'}});
    const queue = () => {
      if (this.searchTimer !== null) this.contentEl.win.clearTimeout(this.searchTimer);
      if (!this.composing) this.searchTimer = this.contentEl.win.setTimeout(() => this.commitSearch(), 180);
    };
    this.search.addEventListener('input', queue);
    this.search.addEventListener('compositionstart', () => { this.composing = true; if (this.searchTimer !== null) this.contentEl.win.clearTimeout(this.searchTimer); });
    this.search.addEventListener('compositionend', () => { this.composing = false; queue(); });
    this.search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.commitSearch(); } });
    this.feedback = page.createDiv({cls: 'hn-review-feedback', attr: {role: 'status'}});
    this.feed = page.createDiv({cls: 'hn-review-feed', attr: {role: 'tabpanel', 'aria-label': '原文与连续评论'}});
    this.registerDomEvent(this.contentEl, 'scroll', () => this.persist());
    this.renameEvent = this.app.vault.on('rename', (file, oldPath) => {
      const path = renamedSourcePath(this.sourcePath, oldPath, file.path);
      if (path === this.sourcePath) return;
      this.sourcePath = path; this.version = -1;
      // The vault event can precede the store's async move and its later index sync.
      this.plugin.syncReview(); this.refresh(); this.persist();
    });
    this.refresh(true); this.contentEl.scrollTop = this.savedScroll; return Promise.resolve();
  }
  private persist(): void { this.app.workspace.requestSaveLayout(); }
  private commitSearch(): void {
    if (this.searchTimer !== null) this.contentEl.win.clearTimeout(this.searchTimer); this.searchTimer = null;
    if (this.composing || this.query === this.search.value) return;
    this.query = this.search.value; this.page = 0; this.feedback.empty(); this.refresh(true); this.contentEl.scrollTop = 0; this.persist();
  }
  refresh(force = false): void {
    if (!this.feed) return;
    const index = this.plugin.reviewIndex; if (!force && index.version === this.version) return;
    const first = !force ? [...this.feed.querySelectorAll<HTMLElement>('[data-review-key]')].find(el => el.getBoundingClientRect().bottom > this.contentEl.getBoundingClientRect().top) : undefined;
    const key = first?.dataset.reviewKey, offset = first ? first.getBoundingClientRect().top - this.contentEl.getBoundingClientRect().top : 0, scroll = this.contentEl.scrollTop;
    const source = index.search(this.kind, '', true);
    if (source !== this.sourceEntries) {
      this.sourceEntries = source; this.groupedSource = [];
      const scoped = this.viewScope === 'all' ? source : source.filter(entry => entry.filePath === this.sourcePath);
      this.labels = fileLabels(scoped.map(entry => entry.filePath));
    }
    if (this.groupedSource !== source || this.groupedReplies !== this.includeReplies || this.groupedScope !== this.viewScope || this.groupedPath !== this.sourcePath) {
      const scoped = this.viewScope === 'all' ? source : source.filter(entry => entry.filePath === this.sourcePath);
      this.allGroups = contentGroups(scoped, this.includeReplies); this.groupedSource = source; this.groupedReplies = this.includeReplies; this.groupedScope = this.viewScope; this.groupedPath = this.sourcePath;
      this.labels = fileLabels(scoped.map(entry => entry.filePath));
    }
    this.results = index.search(this.kind, this.query, this.includeReplies).filter(entry => this.viewScope === 'all' || entry.filePath === this.sourcePath);
    const matched = new Set(this.results.filter(entry => !this.selectedDay || localDay(entry.createdAt) === this.selectedDay).map(entry => entry.threadId ?? entry.key));
    this.dayCounts.clear();
    for (const entry of this.results) { const day = localDay(entry.createdAt); if (day) this.dayCounts.set(day, (this.dayCounts.get(day) ?? 0) + 1); }
    this.groups = this.allGroups.filter(group => matched.has(group.threadId ?? group.key));
    if (key) { const at = this.groups.findIndex(group => group.key === key); if (at >= 0) this.page = Math.floor(at / PAGE_SIZE); }
    this.page = Math.min(this.page, Math.max(0, Math.ceil(this.groups.length / PAGE_SIZE) - 1)); this.version = index.version;
    for (const tab of this.contentEl.querySelectorAll<HTMLButtonElement>('[data-review-kind]')) { const selected = tab.dataset.reviewKind === this.kind; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
    this.scopeSelect.value = this.viewScope;
    this.scopeSelect.querySelector<HTMLOptionElement>('[value="current"]')!.text = this.viewScope === 'current' && this.sourcePath ? this.sourcePath.split('/').at(-1)! : '当前文档';
    if (this.viewScope === 'current') this.scopeSelect.setAttribute('title', this.sourcePath || '请先打开原文再选择指定文档'); else this.scopeSelect.removeAttribute('title');
    this.replyToggle.checked = this.includeReplies; this.replyToggle.parentElement!.hidden = this.kind === 'highlights';
    this.counts.setText(`${this.selectedDay ? this.selectedDay + ' · ' : ''}${this.groups.length} ${this.kind === 'comments' ? '处摘录' : '条标记'}${this.query ? ' · 搜索结果' : ' · 全部内容'}`);
    this.exportButton.disabled = !this.sourceEntries.some(entry => this.viewScope === 'all' || entry.filePath === this.sourcePath) || this.plugin.exporting;
    this.heatRevision++; this.renderCalendar(); this.renderFeed();
    if (!force) { this.contentEl.scrollTop = scroll; const target = key ? [...this.feed.querySelectorAll<HTMLElement>('[data-review-key]')].find(el => el.dataset.reviewKey === key) : undefined;
      if (target) this.contentEl.scrollTop += target.getBoundingClientRect().top - this.contentEl.getBoundingClientRect().top - offset;
    }
  }
  private initializeCalendar(): void {
    this.calendar.empty(); this.heatKey = '';
    const header = this.calendar.createDiv({cls: 'hn-review-calendar-head'}), title = header.createDiv({cls: 'hn-review-calendar-title'});
    title.createSpan({text: '按日期回看', cls: 'hn-review-calendar-label'});
    this.heatStats = title.createSpan({cls: 'hn-review-calendar-stats'});
    const actions = header.createDiv({cls: 'hn-review-calendar-actions'});
    this.heatActions = actions.createDiv({cls: 'hn-review-heat-navigation'});
    this.heatOlder = this.heatActions.createEl('button', {text: '‹', attr: {type: 'button', 'aria-label': '查看上一段时间'}});
    this.heatNewer = this.heatActions.createEl('button', {text: '›', attr: {type: 'button', 'aria-label': '查看下一段时间'}});
    this.heatLatest = this.heatActions.createEl('button', {text: '最近', attr: {type: 'button', 'aria-label': '回到最近记录'}});
    this.heatOlder.addEventListener('click', () => this.moveHeat(-1));
    this.heatNewer.addEventListener('click', () => this.moveHeat(1));
    this.heatLatest.addEventListener('click', () => { this.heatEndWeek = ''; this.renderCalendar(); this.persist(); });
    this.heatToggle = actions.createEl('button', {attr: {type: 'button', 'aria-label': '展开或收起热力图'}});
    this.heatToggle.addEventListener('click', () => {
      this.calendarOpen = !this.calendarOpen; this.renderCalendar(); this.persist();
    });
    this.heatBody = this.calendar.createDiv({cls: 'hn-review-heat-body'});
    this.heatMonths = this.heatBody.createDiv({cls: 'hn-review-heat-months', attr: {'aria-hidden': 'true'}});
    const row = this.heatBody.createDiv({cls: 'hn-review-heat-row'}), axis = row.createDiv({cls: 'hn-review-weekdays', attr: {'aria-hidden': 'true'}});
    for (const text of ['一', '', '三', '', '五', '', '日']) axis.createSpan({text});
    this.heatGrid = row.createDiv({cls: 'hn-review-days', attr: {role: 'group', 'aria-label': '日期热力图'}});
    const footer = this.heatBody.createDiv({cls: 'hn-review-heat-footer'});
    this.heatRangeLabel = footer.createSpan({cls: 'hn-review-heat-range'});
    const legend = footer.createDiv({cls: 'hn-review-heat-legend', attr: {'aria-label': '每天新建记录数量'}});
    for (const [level, text] of [[0, '0'], [1, '1'], [2, '2–3'], [3, '4+']] as const) {
      const item = legend.createSpan(); item.createSpan({cls: `hn-review-legend-cell level-${level}`, attr: {'aria-hidden': 'true'}}); item.createSpan({text});
    }
    this.heatBody.createDiv({cls: 'hn-review-calendar-note', text: '色深表示当前搜索中新建记录的数量，编辑不改变日期。'});
    this.heatSparse = this.calendar.createEl('button', {cls: 'hn-review-sparse-date', attr: {type: 'button'}});
    this.heatSparse.addEventListener('click', () => { if (this.heatSparse.dataset.day) this.jumpDay(this.heatSparse.dataset.day); });
    this.heatObserver?.disconnect();
    const win = this.contentEl.win as Window & {ResizeObserver: typeof ResizeObserver};
    const observer = new win.ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      const weeks = heatmapWeeks(width, this.plugin.isMobile ? 32 : 22);
      if (!this.calendarOpen || weeks === null || this.heatFrame !== null) return;
      this.heatFrame = this.contentEl.win.requestAnimationFrame(() => {
        this.heatFrame = null;
        if (this.heatGrid.isConnected && this.calendarOpen) this.renderCalendar();
      });
    });
    this.heatObserver = observer;
    observer.observe(this.heatGrid);
  }
  private moveHeat(direction: -1 | 1): void {
    const range = heatmapRange(localDay(new Date().toISOString()), this.heatWeeks, this.heatEndWeek);
    const target = shiftDay(range.lastWeek, direction * this.heatWeeks * 7);
    this.heatEndWeek = target >= monday(localDay(new Date().toISOString())) ? '' : target;
    this.renderCalendar(); this.persist();
  }
  private renderCalendar(): void {
    if (!this.heatGrid?.isConnected) this.initializeCalendar();
    this.heatStats.setText(`${this.dayCounts.size} 个记录日`);
    this.heatBody.hidden = !this.calendarOpen; this.heatActions.hidden = !this.calendarOpen;
    this.heatToggle.setText(this.calendarOpen ? '收起' : '展开热力图'); this.heatToggle.setAttribute('aria-expanded', String(this.calendarOpen));
    this.heatSparse.hidden = this.calendarOpen;
    const today = localDay(new Date().toISOString());
    let earliest = today, latest = '';
    for (const day of this.dayCounts.keys()) {
      if (day < earliest) earliest = day;
      if (day <= today && day > latest) latest = day;
    }
    this.heatSparse.disabled = !latest; this.heatSparse.dataset.day = latest;
    this.heatSparse.setText(latest ? `最近记录 · ${latest}` : '暂无记录');
    if (!this.calendarOpen) return;
    const weeks = heatmapWeeks(this.heatGrid.getBoundingClientRect().width, this.plugin.isMobile ? 32 : 22);
    // Hidden leaves report zero: retain the last useful width and wait for visibility.
    if (weeks === null) return;
    this.heatWeeks = weeks;
    const range = heatmapRange(today, weeks, this.heatEndWeek);
    const currentWeek = monday(today), atLatest = range.lastWeek === currentWeek;
    this.heatOlder.disabled = !latest || range.start <= monday(earliest);
    this.heatNewer.disabled = atLatest; this.heatLatest.disabled = atLatest;
    const focus = this.focusedDay < range.start || this.focusedDay > range.end ? range.end : this.focusedDay;
    const key = JSON.stringify([weeks, range.lastWeek, today, this.heatRevision, this.selectedDay, focus]);
    if (key === this.heatKey) return;
    this.heatKey = key;
    const active = this.contentEl.doc.activeElement;
    const activeDay = active && this.heatGrid.contains(active) ? active.getAttribute('data-review-day') : null;
    this.heatMonths.empty(); this.heatGrid.empty(); this.heatBody.style.setProperty('--hn-weeks', String(weeks));
    this.heatRangeLabel.setText(`${range.start} — ${range.end} · ${weeks}周`);
    let lastMonth = '', lastLabel = -3;
    for (let week = 0; week < weeks; week++) {
      const first = shiftDay(range.start, week * 7);
      const firstOfMonth = Array.from({length: 7}, (_, day) => shiftDay(first, day)).find(day => day.endsWith('-01'));
      const month = (firstOfMonth ?? first).slice(0, 7);
      if (month !== lastMonth && week >= lastLabel + 2) {
        const label = this.heatMonths.createSpan({text: `${Number(month.slice(5))}月`});
        label.style.setProperty('left', `min(${week / weeks * 100}%, max(0px, calc(100% - 32px)))`); lastLabel = week; lastMonth = month;
      }
      for (let row = 0; row < 7; row++) {
        const day = shiftDay(first, row), count = this.dayCounts.get(day) ?? 0, isToday = day === today;
        const button = this.heatGrid.createEl('button', {cls: `hn-review-day level-${count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3}${isToday ? ' is-today' : ''}`, attr: {
          type: 'button', 'data-review-day': day, 'data-count': String(count), title: `${day} · ${count} 条记录${isToday ? ' · 今天' : ''}`,
          'aria-label': `${day}，${count} 条记录${isToday ? '，今天' : ''}`, 'aria-pressed': String(this.selectedDay === day), tabindex: day === focus ? '0' : '-1'}});
        button.createSpan({attr: {'aria-hidden': 'true'}}); button.disabled = day > today;
        button.addEventListener('click', () => { this.focusedDay = day; this.jumpDay(day); this.heatGrid.querySelector<HTMLButtonElement>(`[data-review-day="${day}"]`)?.focus({preventScroll: true}); });
        button.addEventListener('keydown', event => {
          const delta = {ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1}[event.key]; if (!delta) return;
          event.preventDefault(); const target = this.heatGrid.querySelector<HTMLButtonElement>(`[data-review-day="${shiftDay(day, delta)}"]`);
          if (target && !target.disabled) { button.tabIndex = -1; target.tabIndex = 0; this.focusedDay = target.dataset.reviewDay!; target.focus(); }
        });
      }
    }
    if (activeDay) this.heatGrid.querySelector<HTMLButtonElement>(`[data-review-day="${activeDay}"]:not(:disabled)`)?.focus({preventScroll: true});
  }
  jumpDay(day: string): void {
    this.commitSearch(); this.feedback.empty();
    if (!this.dayCounts.has(day)) { this.feedback.createSpan({text: `${day} ${this.query ? '没有匹配的批注。' : '没有批注。'}`});
      if (this.query) this.feedback.createEl('button', {text: '查看当天全部'}).addEventListener('click', () => { this.query = ''; this.search.value = ''; this.selectedDay = day; this.page = 0; this.refresh(true); }); return; }
    this.selectedDay = day; this.page = 0; this.refresh(true); this.contentEl.scrollTop = this.calendar.offsetTop; this.persist();
  }
  private renderFeed(): void {
    this.feed.empty();
    if (this.selectedDay) { const clear = this.feed.createEl('button', {cls: 'hn-review-clear-date', text: '清除日期 ×', attr: {type: 'button'}}); clear.addEventListener('click', () => { this.selectedDay = ''; this.page = 0; this.refresh(true); this.persist(); }); }
    for (const group of this.groups.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) this.card(group);
    if (!this.groups.length) this.feed.createDiv({cls: 'hn-review-empty', text: this.plugin.isMobile && !this.sourceEntries.length
      ? `还没有此类批注。可在笔记阅读模式下长按选中文字添加；已有批注请将 ${this.plugin.dataFolder}/ 同步到本机，再点“刷新”。`
      : '没有匹配的内容，可清除日期或换一个关键词。'});
    if (this.groups.length > PAGE_SIZE) {
      const nav = this.feed.createDiv({cls: 'hn-review-pagination'}), previous = nav.createEl('button', {text: '较新内容'}); previous.disabled = this.page === 0;
      nav.createSpan({text: `${this.page * PAGE_SIZE + 1}–${Math.min((this.page + 1) * PAGE_SIZE, this.groups.length)} / ${this.groups.length}`});
      const next = nav.createEl('button', {text: '较早内容'}); next.disabled = (this.page + 1) * PAGE_SIZE >= this.groups.length;
      for (const [button, offset] of [[previous, -1], [next, 1]] as const) button.addEventListener('click', () => { this.page += offset; this.renderFeed(); this.contentEl.scrollTop = 0; this.persist(); });
    }
  }
  private card(group: ContentGroup): void {
    const card = this.feed.createEl('article', {cls: 'hn-review-card', attr: {'data-review-key': group.key, 'data-review-thread': group.threadId ?? ''}});
    card.createEl('blockquote', {cls: 'hn-review-context', text: group.quote});
    const comments = card.createDiv({cls: 'hn-review-content-comments'});
    const page = Math.min(this.messagePages.get(group.key) ?? 0, Math.max(0, Math.ceil(group.entries.length / PAGE_SIZE) - 1));
    if (this.messagePages.size >= 2048 && !this.messagePages.has(group.key)) this.messagePages.delete(this.messagePages.keys().next().value!);
    this.messagePages.set(group.key, page);
    if (this.kind === 'comments') for (const entry of group.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const body = comments.createDiv({cls: `hn-review-body${this.selectedDay && localDay(entry.createdAt) === this.selectedDay ? ' is-date-hit' : ''}`, attr: {'data-review-message': entry.id}});
      renderMessage(body, entry.body);
    }
    if (this.kind === 'comments' && group.entries.length > PAGE_SIZE) {
      const nav = comments.createDiv({cls: 'hn-review-pagination'}), prev = nav.createEl('button', {text: '更早评论'}); prev.disabled = page === 0;
      nav.createSpan({text: `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, group.entries.length)} / ${group.entries.length}`});
      const next = nav.createEl('button', {text: '后续评论'}); next.disabled = (page + 1) * PAGE_SIZE >= group.entries.length;
      for (const [button, offset] of [[prev, -1], [next, 1]] as const) button.addEventListener('click', () => { this.messagePages.set(group.key, page + offset); this.renderFeed(); });
    }
    const footer = card.createDiv({cls: 'hn-review-footer'});
    const details = footer.createEl('button', {text: '查看出处与讨论 ↗', cls: 'hn-review-details-link', attr: {type: 'button', title: this.labels.get(group.filePath) ?? group.filePath}});
    details.addEventListener('click', () => this.plugin.openModal(new ReviewDetailsModal(this.plugin, group, this.leaf, details)));
  }
  onClose(): Promise<void> {
    if (this.renameEvent) this.app.vault.offref(this.renameEvent); this.renameEvent = null;
    if (this.searchTimer !== null) this.contentEl.win.clearTimeout(this.searchTimer);
    this.heatObserver?.disconnect(); this.heatObserver = null;
    if (this.heatFrame !== null) this.contentEl.win.cancelAnimationFrame(this.heatFrame); this.heatFrame = null;
    this.messagePages.clear(); this.plugin.releaseReview(this.leaf); this.contentEl.empty(); return Promise.resolve();
  }
}

class ReviewDetailsModal extends Modal {
  private body!: HTMLElement;
  private sourceName!: HTMLElement;
  private sourcePath!: HTMLElement;
  private sourceStatus!: HTMLElement;
  private sourceResolved?: HTMLElement;
  private sourceButtons: HTMLButtonElement[] = [];
  private renameEvent: EventRef | null = null;
  private pendingSourcePaths = new Set<string>();
  private page = 0;
  private timer: number | null = null;
  private version = -1;
  constructor(private plugin: HighnotePlugin, private group: ContentGroup, private origin: WorkspaceLeaf, private opener: HTMLElement) { super(plugin.app); }
  onOpen(): void {
    this.setTitle('出处与完整讨论'); this.modalEl.addClass('hn-review-details-modal'); this.contentEl.addClass('hn-review-details');
    const heading = this.contentEl.createDiv({cls: 'hn-review-detail-heading'});
    this.sourceName = heading.createEl('p', {cls: 'hn-review-source-name'});
    const controls = heading.createDiv({cls: 'hn-review-details-actions'});
    this.contentEl.createEl('p', {cls: 'hn-review-excerpt-label', text: this.group.original ? '原文摘录 · 创建时保存' : '原文摘录 · 目前保存（旧记录）'});
    this.contentEl.createEl('blockquote', {cls: 'hn-review-context', text: this.group.quote});
    const entry = this.group.entries[0];
    if (entry) {
      const open = controls.createEl('button', {text: '回到原文 ↗', attr: {type: 'button', 'aria-label': '回到原文'}}); this.sourceButtons.push(open);
      open.addEventListener('click', () => this.plugin.run(async () => {
        const current = this.group.entries[0];
        if (current) {
          await this.plugin.openReviewSource(current, this.origin);
          if (this.group.threadId && !this.group.fileMissing) await this.plugin.showThread(this.group.threadId);
        }
        this.close();
      }));
    }
    const source = this.contentEl.createEl('details'); source.createEl('summary', {text: '来源信息'}); this.sourcePath = source.createEl('p');
    this.sourceStatus = source.createEl('p');
    if (this.group.threadId) this.sourceResolved = source.createEl('p');
    this.renameEvent = this.app.vault.on('rename', (file, oldPath) => {
      const path = renamedSourcePath(this.group.filePath, oldPath, file.path);
      if (path === this.group.filePath) return;
      this.pendingSourcePaths.add(this.group.filePath);
      this.group = {...this.group, filePath: path, entries: this.group.entries.map(entry => ({...entry, filePath: path}))};
      this.renderSource();
    });
    this.body = this.contentEl.createDiv({cls: 'hn-review-detail-messages'}); this.renderMessages();
    this.timer = this.contentEl.win.setInterval(() => { if (this.version !== this.plugin.store.version) this.renderMessages(); }, 300);
  }
  private renderSource(): void {
    this.sourceName.setText(this.group.filePath.split('/').at(-1) ?? this.group.filePath);
    this.sourcePath.setText(this.group.filePath);
    const missing = this.plugin.isMobile ? !this.app.vault.getFileByPath(this.group.filePath) : this.group.fileMissing;
    this.sourceStatus.setText(missing ? this.plugin.isMobile ? '当前设备尚未找到原文件' : '原文件已删除'
      : this.group.detached ? '原文位置失效，仍可打开原文件' : '已关联原文');
    this.sourceResolved?.setText(this.group.resolved ? '已解决' : '未解决');
    for (const button of this.sourceButtons) button.disabled = missing;
  }
  private renderMessages(): void {
    this.plugin.syncReview(); this.version = this.plugin.store.version; this.body.empty();
    const source = this.plugin.reviewIndex.search(this.group.threadId ? 'comments' : 'highlights', '', true);
    const current = contentGroups(source.filter(entry => this.group.threadId ? entry.threadId === this.group.threadId : entry.key === this.group.key))[0];
    if (current) {
      // Only bridge snapshots from a rename still waiting for the store to catch up.
      if (this.pendingSourcePaths.has(current.filePath)) this.group = {...current, filePath: this.group.filePath,
        entries: current.entries.map(entry => ({...entry, filePath: this.group.filePath}))};
      else { this.group = current; this.pendingSourcePaths.clear(); }
    }
    this.renderSource();
    const entries = current?.entries ?? [];
    this.page = Math.min(this.page, Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1));
    this.body.createEl('h3', {text: `${this.group.threadId ? '评论与回复' : '标记'} · ${entries.length} 条记录`});
    for (const entry of entries.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) {
      const block = this.body.createDiv({cls: 'hn-review-context-message'}), meta = block.createDiv({cls: 'hn-review-meta'});
      const edited = entry.updatedAt !== entry.createdAt, shownAt = edited ? entry.updatedAt : entry.createdAt;
      meta.createEl('time', {text: `${commentTime(shownAt).label}${edited ? '（编辑过）' : ''}`, attr: {datetime: shownAt, title: commentTime(shownAt).full}});
      if (entry.kind !== 'highlight') renderMessage(block.createDiv({cls: 'hn-review-body'}), entry.body);
    }
    if (entries.length > PAGE_SIZE) { const nav = this.body.createDiv({cls: 'hn-review-pagination'}), prev = nav.createEl('button', {text: '更早消息'}); prev.disabled = this.page === 0;
      nav.createSpan({text: `${this.page * PAGE_SIZE + 1}–${Math.min((this.page + 1) * PAGE_SIZE, entries.length)} / ${entries.length}`}); const next = nav.createEl('button', {text: '后续消息'}); next.disabled = (this.page + 1) * PAGE_SIZE >= entries.length;
      prev.addEventListener('click', () => { this.page--; this.renderMessages(); }); next.addEventListener('click', () => { this.page++; this.renderMessages(); }); }
  }
  onClose(): void {
    if (this.renameEvent) this.app.vault.offref(this.renameEvent); this.renameEvent = null;
    if (this.timer !== null) this.contentEl.win.clearInterval(this.timer); this.timer = null;
    this.pendingSourcePaths.clear();
    this.contentEl.empty(); if (this.opener.isConnected) this.opener.focus({preventScroll: true});
  }
}

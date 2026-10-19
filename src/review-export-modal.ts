import { Modal, type EventRef } from 'obsidian';
import { exportName } from './export-reader';
import { contentGroups, type ContentGroup } from './review-content';
import { DEFAULT_FLOMO_CONFIG, FLOMO_VARIABLES, FLOMO_COLUMNS, flomoRows, type FlomoConfig, type FlomoRow } from './flomo';
import { renderMessage } from './format';
import { renamedSourcePath, type ReviewKind } from './review-model';
import type HighnotePlugin from './main';

export type ReviewExportFormat = 'md' | 'html' | 'flomo_csv';

/** One formatting rule at a time; all previews represent the actual scope exported. */
export class ReviewExportModal extends Modal {
  private busy = false;
  private format: ReviewExportFormat;
  private config: FlomoConfig;
  private previewIndex = 0;
  private rows: FlomoRow[] = [];
  private groups: readonly ContentGroup[] = [];
  private pending: number | null = null;
  private composing = false;
  private observedVersion = -1;
  private groupedVersion = -1;
  private csvCacheKey = '';
  private csvStats = {missing: 0, empty: 0, error: ''};
  private previewMessagePage = 0;
  private liveTimer: number | null = null;
  private renameEvent: EventRef | null = null;
  private titleCount!: HTMLElement;
  private summary!: HTMLElement;
  private error!: HTMLElement;
  private warning!: HTMLElement;
  private configRoot!: HTMLElement;
  private presetOptions!: HTMLElement;
  private templateOptions!: HTMLElement;
  private previewTitle!: HTMLElement;
  private fullPreview!: HTMLButtonElement;
  private standard!: HTMLElement;
  private preview!: HTMLElement;
  private previewDate!: HTMLElement;
  private index!: HTMLElement;
  private prev!: HTMLButtonElement;
  private next!: HTMLButtonElement;
  private name!: HTMLInputElement;
  private extension!: HTMLElement;
  private submit!: HTMLButtonElement;
  private cancel!: HTMLButtonElement;
  private options = new Map<keyof FlomoConfig, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  private formats = new Map<ReviewExportFormat, HTMLInputElement>();
  constructor(private plugin: HighnotePlugin, private kind: ReviewKind, private documentScope: 'all' | 'current',
    private sourcePath: string, private opener?: HTMLElement) {
    super(plugin.app); this.format = plugin.settings.reviewExportFormat ?? 'md';
    if (kind === 'highlights' && this.format === 'flomo_csv') this.format = 'md';
    this.config = {...(plugin.settings.flomo ?? DEFAULT_FLOMO_CONFIG)};
  }
  onOpen(): void {
    this.setTitle('导出阅读回顾'); this.modalEl.addClass('hn-review-export-modal'); this.contentEl.addClass('hn-review-export');
    this.titleCount = this.contentEl.createEl('p', {cls: 'hn-review-export-description'});
    this.contentEl.createEl('label', {text: '文件格式', cls: 'hn-review-export-label'});
    const formats = this.contentEl.createDiv({cls: 'hn-review-export-formats'});
    for (const [format, title, text] of [['md', 'Markdown', '在 Obsidian 继续编辑'], ['html', 'HTML', '浏览器离线阅读'], ['flomo_csv', 'flomo CSV', '导入为独立笔记']] as const) {
      const card = formats.createEl('label', {cls: 'hn-review-format-card'}), top = card.createDiv();
      const radio = top.createEl('input', {attr: {type: 'radio', name: 'hn-review-format', value: format, 'aria-label': title}});
      top.createSpan({text: title}); card.createEl('p', {text}); this.formats.set(format, radio);
      radio.addEventListener('change', () => {
        if (radio.checked && !this.busy) {
          this.cancelPending(); this.readConfig(); this.composing = false;
          this.format = format; this.previewIndex = 0; this.previewMessagePage = 0; this.update();
        }
      });
    }
    this.standard = this.contentEl.createEl('p', {cls: 'hn-muted', text: '原文在前，相关评论连续展示；详情保留创建时间和来源。导出当前文档范围的全部内容，不受首页搜索或日期筛选影响。'});
    const panels = this.contentEl.createDiv({cls: 'hn-export-panel-tabs', attr: {role: 'tablist', 'aria-label': '导出面板'}});
    for (const [value, text] of [['config', '配置'], ['preview', '预览']] as const) {
      const button = panels.createEl('button', {text, attr: {type: 'button', role: 'tab', 'aria-selected': String(value === 'config')}});
      button.addEventListener('click', () => {
        this.modalEl.toggleClass('show-preview', value === 'preview');
        for (const tab of panels.querySelectorAll('button')) tab.setAttribute('aria-selected', String(tab === button));
      });
      button.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const other = [...panels.querySelectorAll('button')].find(tab => tab !== button);
        other?.click(); other?.focus();
      });
    }
    const layout = this.contentEl.createDiv({cls: 'hn-flomo-layout'});
    this.configRoot = layout.createDiv({cls: 'hn-flomo-config'});
    const select = (key: keyof FlomoConfig, label: string, values: readonly [string, string][]) => {
      this.configRoot.createEl('label', {text: label, cls: 'hn-review-export-label'});
      const field = this.configRoot.createEl('select', {attr: {'aria-label': label}});
      for (const [value, text] of values) field.createEl('option', {value, text});
      field.value = String(this.config[key]); this.options.set(key, field); field.addEventListener('change', () => this.changed()); return field;
    };
    const check = (parent: HTMLElement, key: keyof FlomoConfig, label: string) => {
      const row = parent.createEl('label', {cls: 'hn-flomo-check'}), input = row.createEl('input', {attr: {type: 'checkbox', 'aria-label': label}});
      input.checked = Boolean(this.config[key]); row.createSpan({text: label}); this.options.set(key, input); input.addEventListener('change', () => this.changed()); return input;
    };
    select('group', '保存方式', [['thread', '一段讨论一条笔记'], ['message', '每条消息单独保存']]);
    check(this.configRoot, 'includeReplies', '包含回复');
    check(this.configRoot, 'custom', '使用自定义模板');
    this.presetOptions = this.configRoot.createDiv({cls: 'hn-flomo-preset-options'});
    const label = this.presetOptions.createDiv({cls: 'hn-flomo-section-title'}); label.createSpan({text: '正文排版'});
    const presets = this.presetOptions.createDiv({cls: 'hn-flomo-presets'});
    const preset = this.presetOptions.createEl('select', {attr: {'aria-label': '正文排版'}}); preset.hidden = true; this.options.set('preset', preset);
    for (const [value, text, hint] of [['context', '上下文 + 评论', '保留原文，再读自己的想法'], ['comments', '只保留评论', '适合积累个人想法']] as const) {
      preset.createEl('option', {value, text});
      const choice = presets.createEl('label', {cls: 'hn-flomo-preset'}), top = choice.createDiv();
      const radio = top.createEl('input', {attr: {type: 'radio', name: 'hn-flomo-preset', value, 'aria-label': text}});
      top.createSpan({text}); choice.createEl('p', {text: hint});
      radio.addEventListener('change', () => { if (radio.checked) { preset.value = value; this.changed(); } });
    }
    preset.value = this.config.preset;
    const flags = this.presetOptions.createDiv({cls: 'hn-flomo-flags'});
    check(flags, 'labels', '显示“原文／想法”'); check(flags, 'source', '附上来源文档');
    select('separator', '多次评论之间', [['blank', '空一行'], ['line', '换一行'], ['rule', '分隔线'], ['custom', '自定义连接文字']]);
    const customRow = this.configRoot.createDiv({cls: 'hn-flomo-custom-separator'});
    customRow.createEl('label', {text: '连接文字', cls: 'hn-review-export-label'});
    const separator = customRow.createEl('textarea', {attr: {'aria-label': '连接文字', rows: '2', spellcheck: 'false', maxlength: '10000'}});
    separator.value = this.config.customSeparator; this.options.set('customSeparator', separator);
    separator.addEventListener('input', () => this.changed(true));
    const advanced = this.configRoot.createDiv({cls: 'hn-flomo-advanced'}); this.templateOptions = advanced;
    advanced.createEl('label', {text: '模板', cls: 'hn-review-export-label'});
    const template = advanced.createEl('textarea', {cls: 'hn-flomo-template', attr: {'aria-label': '正文模板', rows: '6', spellcheck: 'false', maxlength: '50000'}});
    template.value = this.config.template; this.options.set('template', template); template.addEventListener('input', () => this.changed(true));
    for (const field of [separator, template]) {
      field.addEventListener('compositionstart', () => { this.cancelPending(); this.composing = true; this.validateName(); });
      field.addEventListener('compositionend', () => { this.composing = false; this.changed(true); });
    }
    const tokens = advanced.createDiv({cls: 'hn-flomo-variables'});
    for (const token of FLOMO_VARIABLES) tokens.createEl('button', {text: `{${token}}`, attr: {type: 'button', 'data-flomo-insert': token}}).addEventListener('click', () => {
      if (template.disabled) return; const start = template.selectionStart; template.setRangeText(`{${token}}`, start, template.selectionEnd, 'end'); template.focus(); this.changed();
    });
    advanced.createEl('p', {cls: 'hn-muted', text: '变量按钮插入到光标处。{评论} 使用上面的连接方式，Enter 换行。'});
    const preview = layout.createDiv({cls: 'hn-flomo-preview-panel'}), previewHead = preview.createDiv({cls: 'hn-flomo-preview-head'});
    this.previewTitle = previewHead.createSpan({text: '内容预览'});
    const paging = previewHead.createDiv();
    this.prev = paging.createEl('button', {text: '‹', attr: {type: 'button', 'aria-label': '上一条导出预览'}});
    this.index = paging.createSpan(); this.next = paging.createEl('button', {text: '›', attr: {type: 'button', 'aria-label': '下一条导出预览'}});
    this.prev.addEventListener('click', () => { this.previewIndex--; this.previewMessagePage = 0; this.renderPreview(); }); this.next.addEventListener('click', () => { this.previewIndex++; this.previewMessagePage = 0; this.renderPreview(); });
    const note = preview.createDiv({cls: 'hn-flomo-note'}); this.preview = note.createDiv({cls: 'hn-flomo-preview-content'});
    this.previewDate = note.createDiv({cls: 'hn-flomo-preview-date'});
    this.fullPreview = preview.createEl('button', {text: '查看完整内容', cls: 'hn-preview-full', attr: {type: 'button'}});
    this.fullPreview.addEventListener('click', () => {
      const row = this.format === 'flomo_csv' ? this.rows[this.previewIndex] : undefined;
      const group = this.format !== 'flomo_csv' ? this.groups[this.previewIndex] : undefined;
      if (!row && !group) return;
      this.plugin.openModal(new ExportPreviewModal(this.plugin, row, group, this.fullPreview));
    });
    preview.createEl('p', {cls: 'hn-flomo-date-note'});
    preview.createEl('p', {cls: 'hn-flomo-plain-note', text: '预览折叠长内容，CSV 文件保留全文。'});
    this.warning = preview.createDiv({cls: 'hn-review-warning', attr: {role: 'status'}});
    this.contentEl.createEl('label', {text: '文件名', cls: 'hn-review-export-label'});
    const filename = this.contentEl.createDiv({cls: 'hn-review-export-filename'});
    this.name = filename.createEl('input', {attr: {type: 'text', 'aria-label': '回顾导出文件名', spellcheck: 'false'}});
    this.name.value = this.kind === 'comments' ? '阅读回顾-评论' : '阅读回顾-标记'; this.extension = filename.createSpan();
    this.error = this.contentEl.createDiv({cls: 'hn-review-warning hn-flomo-error', attr: {role: 'status'}});
    this.name.addEventListener('input', () => this.validateName());
    const footer = this.contentEl.createDiv({cls: 'hn-review-export-footer'}); this.summary = footer.createSpan();
    const actions = footer.createDiv({cls: 'hn-actions'});
    this.cancel = actions.createEl('button', {text: '取消', attr: {type: 'button'}}); this.cancel.addEventListener('click', () => this.close());
    this.submit = actions.createEl('button', {cls: 'mod-cta', attr: {type: 'button'}}); this.submit.addEventListener('click', () => { void this.save(); });
    this.renameEvent = this.app.vault.on('rename', (file, oldPath) => {
      const path = renamedSourcePath(this.sourcePath, oldPath, file.path);
      if (path === this.sourcePath) return;
      this.sourcePath = path; this.groupedVersion = -1; this.csvCacheKey = '';
      this.update();
    });
    this.liveTimer = this.contentEl.win.setInterval(() => { if (!this.busy && this.observedVersion !== this.plugin.store.version) this.update(); }, 300);
    this.update();
  }
  private readConfig(): void {
    for (const [key, field] of this.options) {
      if (key === 'custom' || key === 'includeReplies' || key === 'labels' || key === 'source') this.config[key] = (field as HTMLInputElement).checked;
      else if (key === 'template' || key === 'customSeparator') this.config[key] = field.value;
      else if (key === 'group') this.config.group = field.value === 'message' ? 'message' : 'thread';
      else if (key === 'preset') this.config.preset = field.value === 'comments' ? 'comments' : 'context';
      else if (key === 'separator') this.config.separator = field.value as FlomoConfig['separator'];
    }
  }
  private cancelPending(): void {
    if (this.pending !== null) this.contentEl.win.clearTimeout(this.pending);
    this.pending = null;
  }
  private changed(delayed = false): void {
    this.cancelPending();
    this.readConfig(); this.previewIndex = 0; this.previewMessagePage = 0;
    this.submit.disabled = true;
    if (this.composing) return;
    if (delayed) this.pending = this.contentEl.win.setTimeout(() => { this.pending = null; this.update(); }, 180);
    else this.update();
  }
  private update(): void {
    this.plugin.syncReview(); this.observedVersion = this.plugin.store.version;
    const entries = this.plugin.reviewIndex.search(this.kind, '', true).filter(entry => this.documentScope === 'all' || entry.filePath === this.sourcePath);
    if (this.groupedVersion !== this.observedVersion) {
      this.groups = contentGroups(entries); this.groupedVersion = this.observedVersion;
    }
    const threads = this.documentScope === 'all' ? this.plugin.store.viewAll() : this.plugin.store.viewFile(this.sourcePath);
    this.titleCount.setText(`${this.documentScope === 'all' ? '全部文档' : this.sourcePath || '未选择文档'} · ${this.groups.length} ${this.kind === 'comments' ? '组讨论' : '条标记'} · ${entries.length} 条记录`);
    this.titleCount.title = '导出所选文档的全部已保存内容，首页搜索、日期和回复开关不缩小范围。';
    const csv = this.format === 'flomo_csv'; this.configRoot.hidden = !csv; this.standard.hidden = csv;
    this.presetOptions.hidden = this.config.custom; this.templateOptions.hidden = !this.config.custom;
    this.modalEl.toggleClass('is-csv', csv); this.extension.setText(csv ? '.csv' : `.${this.format}`);
    for (const [format, radio] of this.formats) {
      radio.checked = format === this.format;
      radio.disabled = this.busy || format === 'flomo_csv' && this.kind === 'highlights';
      const card = radio.closest('label')!;
      card.toggleClass('is-selected', radio.checked);
      card.toggleClass('is-disabled', radio.disabled);
    }
    this.contentEl.querySelector<HTMLElement>('.hn-flomo-custom-separator')!.hidden = this.config.separator !== 'custom';
    for (const [key, field] of this.options) field.disabled = this.busy || this.config.custom && ['preset', 'labels', 'source'].includes(key) || !this.config.custom && key === 'template';
    for (const radio of this.contentEl.querySelectorAll<HTMLInputElement>('input[name="hn-flomo-preset"]')) {
      radio.checked = radio.value === this.config.preset; radio.disabled = this.busy || this.config.custom; radio.closest('label')!.toggleClass('is-selected', radio.checked);
    }
    for (const button of this.contentEl.querySelectorAll<HTMLButtonElement>('[data-flomo-insert]')) button.disabled = this.busy || !this.config.custom;
    if (csv) {
      const cacheKey = JSON.stringify([this.observedVersion, this.documentScope, this.sourcePath, this.config]);
      if (cacheKey !== this.csvCacheKey) {
        const result = flomoRows(threads, this.config); this.rows = result.rows; this.csvStats = result; this.csvCacheKey = cacheKey;
      }
      const result = this.csvStats;
      this.error.setText(result.error); this.warning.setText([result.empty ? `${result.empty} 条空内容已跳过。` : '', result.missing ? `${result.missing} 条创建时间缺失，将留空；导入日期请在 flomo 中确认。` : ''].filter(Boolean).join(' '));
      this.summary.setText(`将生成 ${this.rows.length} 条 flomo 笔记`);
    } else { this.warning.setText(''); this.error.setText(''); this.summary.setText(`保留 ${entries.length} 条记录与完整内容`); }
    this.name.disabled = this.busy; this.cancel.disabled = this.busy;
    const dateNote = this.contentEl.querySelector<HTMLElement>('.hn-flomo-date-note')!;
    dateNote.setText(csv ? '保存为 .csv · content 正文 / created_at 创建时间' : '正文在前，时间与来源放入详情。');
    dateNote.title = this.config.group === 'thread' ? '合并讨论取最早有效主评论时间，缺失时取最早有效回复时间。' : '每条消息保留自己的创建时间。';
    this.contentEl.querySelector<HTMLElement>('.hn-flomo-plain-note')!.hidden = !csv;
    this.validateName(); this.renderPreview();
  }
  private validateName(): void {
    let error = this.error.textContent ?? '';
    if (!this.busy) {
      if (!this.format || this.format !== 'flomo_csv') error = '';
      else error = flomoRows([], this.config).error;
      try { exportName(this.name.value); } catch (failure) { error = failure instanceof Error ? failure.message : '文件名无效'; }
      this.error.setText(error);
    }
    this.submit.disabled = this.busy || this.composing || this.pending !== null || Boolean(error) || (this.format === 'flomo_csv' ? !this.rows.length : !this.groups.length);
    this.submit.setText(this.busy ? '导出中…' : this.format === 'flomo_csv' ? '导出 CSV' : `导出 .${this.format}`);
  }
  private renderPreview(): void {
    const total = this.format === 'flomo_csv' ? this.rows.length : this.groups.length;
    this.previewIndex = Math.max(0, Math.min(this.previewIndex, total - 1));
    this.index.setText(total ? `${this.previewIndex + 1} / ${total}` : '0 / 0'); this.prev.disabled = this.busy || this.previewIndex === 0; this.next.disabled = this.busy || this.previewIndex >= total - 1;
    this.preview.empty();
    this.previewTitle.setText(this.format === 'flomo_csv' ? 'CSV 预览 · 一行一条笔记' : '内容预览');
    this.fullPreview.disabled = this.busy || !total;
    this.previewDate.hidden = this.format === 'flomo_csv';
    if (this.format === 'flomo_csv') {
      const row = this.rows[this.previewIndex];
      const table = this.preview.createEl('table', {cls: 'hn-csv-preview', attr: {'aria-label': 'CSV 两列预览'}});
      const head = table.createEl('thead').createEl('tr');
      for (const column of FLOMO_COLUMNS) head.createEl('th', {text: column});
      const line = table.createEl('tbody').createEl('tr');
      line.createEl('td').createDiv({cls: 'hn-csv-content', text: row?.content ?? '没有可导出的笔记'});
      line.createEl('td', {cls: 'hn-csv-created', text: row?.created_at || '留空'});
      this.previewDate.setText(row?.created_at || '创建时间为空');
    }
    else {
      const group: ContentGroup | undefined = this.groups[this.previewIndex];
      if (group) {
        this.preview.createEl('blockquote', {text: group.quote});
        const entries = group.entries.filter(entry => entry.kind !== 'highlight'), size = 40;
        this.previewMessagePage = Math.min(this.previewMessagePage, Math.max(0, Math.ceil(entries.length / size) - 1));
        for (const entry of entries.slice(this.previewMessagePage * size, (this.previewMessagePage + 1) * size)) renderMessage(this.preview.createDiv({cls: 'hn-review-body'}), entry.body);
        if (entries.length > size) {
          const nav = this.preview.createDiv({cls: 'hn-review-pagination'}), prev = nav.createEl('button', {text: '更早评论'});
          prev.disabled = this.busy || this.previewMessagePage === 0;
          nav.createSpan({text: `${this.previewMessagePage * size + 1}–${Math.min(entries.length, (this.previewMessagePage + 1) * size)} / ${entries.length}`});
          const next = nav.createEl('button', {text: '后续评论'}); next.disabled = this.busy || (this.previewMessagePage + 1) * size >= entries.length;
          prev.addEventListener('click', () => { this.previewMessagePage--; this.renderPreview(); });
          next.addEventListener('click', () => { this.previewMessagePage++; this.renderPreview(); });
        }
      }
      else this.preview.setText('没有可导出的记录');
      this.previewDate.setText('原文与全部评论 · 内容快照');
    }
  }
  private async save(): Promise<void> {
    if (this.busy || this.composing) return;
    this.cancelPending();
    this.readConfig(); this.update(); if (this.submit.disabled) return;
    this.busy = true; this.update();
    try {
      const file = await this.plugin.exportReview(this.kind, '', true, this.name.value, this.format, this.documentScope, this.sourcePath, this.config);
      if (file) { this.busy = false; this.close(); }
      else { this.busy = false; this.update(); }
    } catch (failure) { this.busy = false; this.update(); this.error.setText(failure instanceof Error ? failure.message : '导出失败，请重试'); }
  }
  close(): void { if (!this.busy) super.close(); }
  closeForUnload(): void { this.busy = false; super.close(); }
  onClose(): void {
    if (this.renameEvent) this.app.vault.offref(this.renameEvent); this.renameEvent = null;
    this.cancelPending(); this.composing = false;
    if (this.liveTimer !== null) this.contentEl.win.clearInterval(this.liveTimer); this.liveTimer = null;
    this.contentEl.empty();
    if (this.opener?.isConnected) this.opener.focus({preventScroll: true});
  }
}

/** A separate bounded reader keeps long content out of the export form. */
class ExportPreviewModal extends Modal {
  private page = 0;
  constructor(private plugin: HighnotePlugin, private row: FlomoRow | undefined, private group: ContentGroup | undefined,
    private opener: HTMLElement) { super(plugin.app); }
  onOpen(): void {
    this.setTitle('完整导出内容'); this.modalEl.addClass('hn-full-preview-modal'); this.contentEl.addClass('hn-full-preview'); this.render();
  }
  private render(): void {
    this.contentEl.empty();
    const entries = this.group?.entries.filter(entry => entry.kind !== 'highlight') ?? [];
    const size = this.row ? 4000 : 40;
    const total = this.row ? this.row.content.length : entries.length;
    const pages = Math.max(1, Math.ceil(total / size)); this.page = Math.max(0, Math.min(this.page, pages - 1));
    if (this.row) {
      this.contentEl.createEl('p', {cls: 'hn-muted', text: `content · ${this.row.content.length} 字符 / created_at · ${this.row.created_at || '留空'}`});
      this.contentEl.createDiv({cls: 'hn-full-preview-text', text: this.row.content.slice(this.page * size, (this.page + 1) * size)});
    } else if (this.group) {
      this.contentEl.createEl('blockquote', {cls: 'hn-review-context', text: this.group.quote});
      for (const entry of entries.slice(this.page * size, (this.page + 1) * size)) renderMessage(this.contentEl.createDiv({cls: 'hn-review-body'}), entry.body);
    }
    if (pages > 1) {
      const nav = this.contentEl.createDiv({cls: 'hn-review-pagination'});
      const previous = nav.createEl('button', {text: '上一段', attr: {type: 'button'}}); previous.disabled = this.page === 0;
      nav.createSpan({text: `${this.page + 1} / ${pages}`});
      const next = nav.createEl('button', {text: '下一段', attr: {type: 'button'}}); next.disabled = this.page + 1 >= pages;
      previous.addEventListener('click', () => { if (!previous.disabled) { this.page--; this.render(); } });
      next.addEventListener('click', () => { if (!next.disabled) { this.page++; this.render(); } });
    }
  }
  onClose(): void { this.contentEl.empty(); if (this.opener.isConnected) this.opener.focus({preventScroll: true}); }
}

import { Component, FileSystemAdapter, Modal, MarkdownView, Notice, Platform, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath } from 'obsidian';
import type { ChangeDesc } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { commentEditor, refreshComments } from './editor';
import { mapAnchor, makeAnchor, relocateAnchor } from './anchors';
import { DATA_FOLDER, type Anchor, type Thread, type Highlight } from './model';
import { ThreadStore, type ThreadFiles } from './store';
import {NoteFiles} from './note-files';
import {ReviewFiles} from './review-files';
import {annotationDirectory, savedDataDirectory} from './data-directory';
import {migrateAnnotations, type MigrationProgress, type MigrationResult} from './data-migration';
import { COMMENTS_VIEW, CommentsView, MessageModal } from './ui';
import { ReadingComments } from './reading';
import { SelectionToolbar } from './selection-toolbar';
import {exportBaseName, exportMarkdown, exportHighlightBaseName, exportHighlightsMarkdown, type ExportScope} from './export';
import {exportHtml, exportName, type ExportChoice, type ExportFormat, type ExportKind} from './export-reader';
import { AnnotationSettingsTab, highlightColor, DEFAULT_HIGHLIGHT_COLOR, type AnnotationSettings } from './settings';
import { ReviewIndex, type ReviewEntry, type ReviewKind } from './review-model';
import { contentGroups, exportContentMarkdown, exportContentHtml } from './review-content';
import { REVIEW_VIEW, ReviewView } from './review';
import { ReviewExportModal, type ReviewExportFormat } from './review-export-modal';
import { DEFAULT_FLOMO_CONFIG, normalizeFlomoConfig, flomoRows, flomoCsv } from './flomo';

export interface NoteSelection {filePath: string; source: string; from: number; to: number}

export default class HighnotePlugin extends Plugin {
  store!: ThreadStore;
  reviewIndex = new ReviewIndex();
  private reviewVersion = -1;
  private reviewSources = new Map<WorkspaceLeaf, WorkspaceLeaf>();
  private reviewSourceRequest = 0;
  private reviewSourceOpening = new Set<WorkspaceLeaf>();
  openModals = new Set<Modal>();
  selectionToolbar = new SelectionToolbar();
  focused = '';
  focusedHighlight = '';
  settings: AnnotationSettings = {highlightColor: DEFAULT_HIGHLIGHT_COLOR, exportFormat:'md'};
  activePath = '';
  drafts = new Map<string, string>();
  readingViews = new Set<ReadingComments>();
  editorViews = new Set<EditorView>();
  private pendingAnchors = new Map<string, Anchor>();
  private pendingHighlights = new Map<string, Anchor>();
  private knownSources = new Map<string, string>();
  private sourceVersions = new Map<string, number>();
  private saving: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private refreshTimer: number | null = null;
  private externalTimer: number | null = null;
  private writing = 0;
  private dataWatcher: {close(): void} | null = null;
  private ownDataWrites = new Map<string, string>();
  private refreshOperation: Promise<void> | null = null;
  private disposed = false;
  private reconciliations = new Map<string, Promise<void>>();
  exporting = false;
  private interactionDocuments = new Map<Document, Component>();
  private reviewFiles: ReviewFiles | null = null;
  private activeDataDirectory = DATA_FOLDER;
  private changingDataDirectory = false;
  private dataWritesPaused = false;
  private dataWatcherGeneration = 0;
  get dataFolder(): string { return this.activeDataDirectory; }
  get isMobileReview(): boolean { return Platform.isMobile; }

  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    this.activeDataDirectory = savedDataDirectory(saved && typeof saved === 'object' && 'dataDirectory' in saved ? saved.dataDirectory : undefined);
    this.settings.dataDirectory = this.activeDataDirectory;
    this.settings.highlightColor = highlightColor(saved && typeof saved === 'object' && 'highlightColor' in saved ? saved.highlightColor : undefined);
    this.settings.exportFormat = saved && typeof saved === 'object' && 'exportFormat' in saved && saved.exportFormat === 'html' ? 'html' : 'md';
    this.settings.reviewExportFormat = saved && typeof saved === 'object' && 'reviewExportFormat' in saved && (saved.reviewExportFormat === 'html' || saved.reviewExportFormat === 'flomo_csv') ? saved.reviewExportFormat : 'md';
    this.settings.flomo = normalizeFlomoConfig(saved && typeof saved === 'object' && 'flomo' in saved ? saved.flomo : undefined);
    this.addSettingTab(new AnnotationSettingsTab(this.app, this));
    this.store = new ThreadStore(this.fileAccess(), () => this.scheduleRefresh(), error => this.report(error));
    this.register(() => this.closeDataWatcher());
    if (!this.isMobileReview) {
      this.registerInteractionDocument(this.app.workspace.containerEl.ownerDocument);
      this.registerEvent(this.app.workspace.on('window-open', (_workspaceWindow, win) => this.registerInteractionDocument(win.document)));
      this.registerEvent(this.app.workspace.on('window-close', (_workspaceWindow, win) => {
        const component = this.interactionDocuments.get(win.document);
        if (component) { this.removeChild(component); this.interactionDocuments.delete(win.document); }
      }));
      this.registerView(COMMENTS_VIEW, leaf => new CommentsView(leaf, this));
      this.registerEditorExtension(commentEditor(this));
      this.registerMarkdownPostProcessor((element, context) => {
        if (context.sourcePath.endsWith('.md')) context.addChild(new ReadingComments(element, context, this));
      });
      this.addRibbonIcon('messages-square', '打开评论', () => this.run(() => this.openSidebar()));
      this.addCommand({id: 'open-comments', name: '打开评论', callback: () => this.run(() => this.openSidebar())});
      for (const [id, name, kind] of [['add-comment', '评论所选文字', 'comment'], ['add-highlight', '标记所选文字', 'highlight']] as const) {
        this.addCommand({id, name, checkCallback: checking => {
          if (!this.canModify) return false;
          const view = this.currentMarkdownView();
          const reading = [...this.readingViews].find(render => view?.contentEl.contains(render.containerEl) && render.hasSelection());
          if (!reading) return false;
          if (!checking) reading.performSelection(kind);
          return true;
        }});
      }
      this.addCommand({id: 'refresh-comments', name: '重新读取评论数据', callback: () => this.run(() => this.refreshData())});
      this.addCommand({id: 'export-current-comments', name: '导出当前文档评论', checkCallback: checking => {
        const available = this.canModify && !this.exporting && Boolean(this.activePath && this.store.viewFile(this.activePath).length);
        if (available && !checking) this.openExport('current','comments');
        return available;
      }});
      this.addCommand({id: 'export-all-comments', name: '导出全部文档评论', checkCallback: checking => {
        const available = this.canModify && !this.exporting && this.store.viewAll().length > 0;
        if (available && !checking) this.openExport('all','comments');
        return available;
      }});
      for (const [id, name, scope] of [['export-current-highlights', '导出当前文档标记', 'current'], ['export-all-highlights', '导出全部文档标记', 'all']] as const) {
        this.addCommand({id, name, checkCallback: checking => {
          const available = this.canModify && !this.exporting && this.store.viewHighlights(scope === 'current' ? this.activePath : undefined).length > 0;
          if (available && !checking) this.openExport(scope,'highlights');
          return available;
        }});
      }
    }
    this.registerView(REVIEW_VIEW, leaf => new ReviewView(leaf, this));
    this.addCommand({id: 'open-review', name: '打开阅读回顾', callback: () => this.run(() => this.openReview())});
    if (this.isMobileReview) {
      this.addRibbonIcon('book-open', '打开阅读回顾', () => this.run(() => this.openReview()));
      this.addCommand({id: 'refresh-review', name: '刷新阅读回顾', callback: () => this.run(() => this.refreshMobileReview(true))});
      const doc = this.app.workspace.containerEl.ownerDocument;
      this.registerDomEvent(doc, 'visibilitychange', () => {
        if (!doc.hidden) this.run(() => this.refreshMobileReview(true));
      });
      if (doc.defaultView) this.registerDomEvent(doc.defaultView, 'focus', () => this.run(() => this.refreshMobileReview(true)));
      this.registerInterval(window.setInterval(() => {
        if (!doc.hidden && this.app.workspace.getActiveViewOfType(ReviewView)) this.run(() => this.refreshMobileReview());
      }, 15000));
    }
    this.registerEvent(this.app.workspace.on('file-open', file => {
      this.selectionToolbar.hide();
      const activeFile = file ?? this.app.workspace.getActiveFile();
      this.activePath = activeFile?.extension === 'md' ? activeFile.path : '';
      this.scheduleRefresh();
      if (!this.changingDataDirectory && !this.isMobileReview && file?.extension === 'md') this.run(() => this.reconcileFile(file));
    }));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (this.changingDataDirectory) return;
      if (this.isMobileReview) { if (this.isDataFile(file.path)) this.externalChanged(); return; }
      if (this.isDataFile(file.path)) this.externalChanged();
      else if (file instanceof TFile && file.extension === 'md') {
        this.sourceVersions.set(file.path, (this.sourceVersions.get(file.path) ?? 0) + 1);
        this.run(() => this.reconcileFile(file));
      }
    }));
    this.registerEvent(this.app.vault.on('create', file => {
      if (this.changingDataDirectory) return;
      if (this.isMobileReview) { if (this.isDataFile(file.path)) this.externalChanged(); return; }
      if (this.isDataFile(file.path)) this.externalChanged();
      else if (file instanceof TFile && file.extension === 'md') this.run(() => this.reconcileFile(file));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.changingDataDirectory) return;
      if (this.isMobileReview) { this.externalChanged(); return; }
      if (oldPath === this.dataFolder || this.dataFolder.startsWith(`${oldPath}/`) || oldPath.startsWith(`${this.dataFolder}/`) || this.isDataFile(file.path)) {
        this.externalChanged(); return;
      }
      if (this.activePath === oldPath || this.activePath.startsWith(`${oldPath}/`)) this.activePath = file.path + this.activePath.slice(oldPath.length);
      this.run(async () => {
        await this.flushAnchors();
        if (this.changingDataDirectory || this.disposed) return;
        for (const path of this.store.paths()) if (path === oldPath || (file instanceof TFolder && path.startsWith(`${oldPath}/`))) {
          if (this.changingDataDirectory || this.disposed) return;
          const next = file.path + path.slice(oldPath.length);
          if (next.endsWith('.md')) await this.store.moveFile(path, next);
          else await this.markFileMissing(path);
          this.knownSources.delete(path);
        }
      });
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (this.changingDataDirectory) return;
      if (this.isMobileReview) { this.externalChanged(); return; }
      if (this.isDataFile(file.path) || file.path === this.dataFolder || this.dataFolder.startsWith(`${file.path}/`)) { this.externalChanged(); return; }
      this.run(async () => {
        await this.flushAnchors();
        if (this.changingDataDirectory || this.disposed) return;
        for (const path of this.store.paths()) if (path === file.path || path.startsWith(`${file.path}/`)) {
          if (this.changingDataDirectory || this.disposed) return;
          await this.markFileMissing(path);
          this.knownSources.delete(path);
        }
      });
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.modeChanged()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.modeChanged()));
    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.activePath = this.app.workspace.getActiveFile()?.extension === 'md' ? this.app.workspace.getActiveFile()!.path : '';
      this.run(() => this.refreshData());
    });
  }

  onunload(): void {
    this.disposed = true;
    this.selectionToolbar.hide();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.externalTimer !== null) window.clearTimeout(this.externalTimer);
    // Best effort only: a shutdown can interrupt this. Persisted quotes are revalidated on startup.
    void this.flushAnchors().catch(error => console.error('Highnote: anchor flush failed', error));
    for (const modal of this.openModals) {
      if (modal instanceof ReviewExportModal) modal.closeForUnload(); else modal.close();
    }
    this.openModals.clear();
    this.drafts.clear();
    this.reconciliations.clear();
    this.knownSources.clear();
    this.sourceVersions.clear();
    for (const reading of [...this.readingViews]) reading.unload();
    this.editorViews.clear();
    this.readingViews.clear();
    this.interactionDocuments.clear();
    this.pendingHighlights.clear();
    this.reviewIndex.clear(); this.reviewSources.clear(); this.reviewSourceOpening.clear();
    this.ownDataWrites.clear();
  }

  syncReview(): void {
    if (this.reviewVersion === this.store.version) return;
    this.reviewIndex.sync(this.store.viewAll(), this.store.viewHighlights());
    this.reviewVersion = this.store.version;
  }
  releaseReview(leaf: WorkspaceLeaf): void { this.reviewSources.delete(leaf); }
  async refreshMobileReview(force = false): Promise<void> {
    if (this.disposed || this.changingDataDirectory || !this.isMobileReview) return;
    if (force) {
      if (this.refreshOperation) await this.refreshOperation;
      if (this.disposed) return;
      this.reviewFiles?.invalidate();
    }
    await this.refreshData();
    if (!this.disposed) { this.syncReview(); this.scheduleRefresh(); }
  }
  async openReview(): Promise<void> {
    if (this.changingDataDirectory) return;
    if (this.isMobileReview) await this.refreshMobileReview(true);
    if (this.refreshOperation) await this.refreshOperation;
    await this.store.idle(); this.syncReview();
    const existing = this.app.workspace.getLeavesOfType(REVIEW_VIEW)[0];
    if (existing) { await this.app.workspace.revealLeaf(existing); return; }
    const sourcePath = this.activePath;
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({type: REVIEW_VIEW, state: {sourcePath}, active: true}); await this.app.workspace.revealLeaf(leaf);
  }
  async openReviewSource(entry: ReviewEntry, origin: WorkspaceLeaf): Promise<void> {
    if (this.disposed) return;
    const sourceRequest = ++this.reviewSourceRequest;
    const file = this.app.vault.getFileByPath(entry.filePath);
    if (!file || (!this.isMobileReview && entry.fileMissing)) { this.notify(this.isMobileReview ? '当前设备找不到原文件，请确认笔记已同步。摘录和批注仍保留。' : '原文件已删除，保存的摘录和批注仍在回顾页中。'); return; }
    if (this.isMobileReview) {
      const source = await this.app.vault.cachedRead(file);
      if (sourceRequest !== this.reviewSourceRequest || this.disposed) return;
      const prior = this.reviewSources.get(origin);
      const target = prior && prior !== origin && this.app.workspace.getLeavesOfType('markdown').includes(prior)
        && !prior.getViewState().pinned && prior.view instanceof MarkdownView && prior.view.getMode() === 'preview'
        ? prior : this.app.workspace.getLeaf('tab');
      this.reviewSources.set(origin, target);
      await target.openFile(file);
      if (!(target.view instanceof MarkdownView) || sourceRequest !== this.reviewSourceRequest || this.disposed) return;
      await target.setViewState({type: 'markdown', state: {...target.view.getState(), mode: 'preview'}, active: true});
      await this.app.workspace.revealLeaf(target);
      if (sourceRequest !== this.reviewSourceRequest || this.disposed) return;
      const item = entry.threadId ? this.store.get(entry.threadId) : this.store.getHighlight(entry.id);
      const anchor = item && relocateAnchor(source, item.anchor);
      if (anchor?.state === 'attached') target.view.previewMode.applyScroll(source.slice(0, anchor.from).split('\n').length - 1);
      else this.notify('已打开原文件；位置无法确认，请参考回顾页中的摘录。');
      return;
    }
    // Seed the current source before Obsidian synchronizes a newly opened editor.
    await this.reconcileFile(file);
    if (sourceRequest !== this.reviewSourceRequest || this.disposed) return;
    const prior = this.reviewSources.get(origin);
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    const reusable = prior && !prior.getViewState().pinned && (this.reviewSourceOpening.has(prior)
      || leaves.includes(prior) && prior.view instanceof MarkdownView && prior.view.getMode() === 'preview');
    const wide = this.app.workspace.containerEl.getBoundingClientRect().width >= 1000;
    const target = reusable ? prior : wide ? this.app.workspace.createLeafBySplit(origin, 'vertical') : this.app.workspace.getLeaf('tab');
    this.reviewSources.set(origin, target);
    this.reviewSourceOpening.add(target);
    try { await target.openFile(file); } finally { this.reviewSourceOpening.delete(target); }
    if (!(target.view instanceof MarkdownView) || this.disposed || sourceRequest !== this.reviewSourceRequest) return;
    await target.setViewState({type: 'markdown', state: {...target.view.getState(), mode: 'preview'}, active: true});
    await this.app.workspace.revealLeaf(target);
    if (sourceRequest !== this.reviewSourceRequest || this.disposed) return;
    await this.reconcileFile(file);
    if (sourceRequest !== this.reviewSourceRequest || this.disposed) return;
    const item = entry.threadId ? this.store.get(entry.threadId) : this.store.getHighlight(entry.id);
    if (!item || item.fileMissing || item.anchor.state !== 'attached') {
      this.notify('已打开原文件；原文位置失效，请参考回顾页中保存的摘录。'); return;
    }
    if (entry.threadId) this.focusThread(entry.threadId); else this.focusHighlight(entry.id);
    const request = ++this.locationRequest;
    await this.locateReading(target.view, item.anchor, entry.threadId ?? entry.id, !entry.threadId, request);
  }
  openReviewExport(kind: ReviewKind, _query: string, _includeReplies: boolean, returnFocus?: HTMLElement,
    scope: 'all' | 'current' = 'all', sourcePath = this.activePath): void {
    if (this.disposed || this.changingDataDirectory || this.exporting || [...this.openModals].some(modal => modal instanceof ReviewExportModal)) return;
    this.syncReview(); this.openModal(new ReviewExportModal(this, kind, scope, sourcePath, returnFocus));
  }
  async exportReview(kind: ReviewKind, _query: string, _includeReplies: boolean, name: string,
    format: ReviewExportFormat = 'md', scope: 'all' | 'current' = 'all', sourcePath = '', config = this.settings.flomo ?? DEFAULT_FLOMO_CONFIG): Promise<TFile | undefined> {
    if (this.disposed || this.changingDataDirectory || this.exporting) return;
    this.exporting = true;
    try {
      if (this.isMobileReview) await this.refreshMobileReview(true);
      if (this.refreshOperation) await this.refreshOperation;
      await this.flushAnchors(); await this.store.idle(); this.syncReview();
      if (!['md', 'html', 'flomo_csv'].includes(format) || format === 'flomo_csv' && kind === 'highlights') throw new Error('导出格式不支持此类记录。');
      const entries = this.reviewIndex.search(kind, '', true).filter(entry => scope === 'all' || entry.filePath === sourcePath);
      const groups = contentGroups(entries);
      let csv = '', count = entries.length;
      if (format === 'flomo_csv') {
        const threads = scope === 'all' ? this.store.viewAll() : this.store.viewFile(sourcePath);
        const result = flomoRows(threads, config); if (result.error) throw new Error(result.error);
        csv = flomoCsv(result.rows); count = result.rows.length;
      }
      if (!count) { this.notify('所选范围没有可导出的内容。'); return; }
      const base = exportName(name), exportedAt = new Date();
      const extension = format === 'flomo_csv' ? 'csv' : format;
      let number = 0;
      while (!this.disposed) {
        const title = `${base}${number ? `(${number})` : ''}`, path = normalizePath(`${title}.${extension}`);
        if (this.app.vault.getAbstractFileByPath(path)) { number++; continue; }
        const label = scope === 'all' ? '全部文档' : sourcePath;
        const contents = format === 'flomo_csv' ? csv : format === 'html' ? exportContentHtml(title, groups, label, exportedAt,
          this.app.workspace.containerEl.ownerDocument.body.hasClass('theme-dark')) : exportContentMarkdown(title, groups, label, exportedAt);
        let file: TFile;
        try { file = await this.app.vault.create(path, contents); }
        catch (error) { if (this.app.vault.getAbstractFileByPath(path)) { number++; continue; } throw error; }
        this.notify(`已导出 ${count} 条${format === 'flomo_csv' ? 'flomo 笔记' : '记录'}到“${path}”。`);
        const previous = {format: this.settings.reviewExportFormat, config: this.settings.flomo};
        this.settings.reviewExportFormat = format;
        if (format === 'flomo_csv') this.settings.flomo = {...config};
        try { await this.saveData(this.settings); } catch { this.settings.reviewExportFormat = previous.format; this.settings.flomo = previous.config; this.notify('文件已保存，但未能记住导出设置。'); }
        try {
          if (format === 'html' && !this.isMobileReview) await this.openExportInBrowser(file);
          else if (format === 'md') {
            const leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(file);
            if (leaf.view instanceof MarkdownView) await leaf.setViewState({type: 'markdown', state: {...leaf.view.getState(), mode: 'preview'}, active: true});
          }
        } catch { this.notify(`文件已保存到“${path}”，请从笔记库中打开。`); }
        return file;
      }
    } finally { this.exporting = false; }
  }

  private currentMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const recent = this.app.workspace.getMostRecentLeaf()?.view;
    return recent instanceof MarkdownView ? recent : null;
  }
  get canModify(): boolean {
    if (this.isMobileReview || this.changingDataDirectory) return false;
    const view = this.currentMarkdownView();
    return !this.disposed && view?.file?.extension === 'md' && view.getMode() === 'preview';
  }
  requireReadingMode(): void {
    if (this.isMobileReview) throw new Error('手机版仅支持阅读回顾，评论与标记请在桌面端操作。');
    if (!this.canModify) throw new Error('请切换到阅读模式后再添加或修改评论与标记。');
  }
  isReadingContainer(container: HTMLElement): boolean {
    if (this.isMobileReview) return false;
    const leaf = this.app.workspace.getLeavesOfType('markdown').find(item => item.view instanceof MarkdownView && item.view.contentEl.contains(container));
    return leaf?.view instanceof MarkdownView && leaf.view.getMode() === 'preview';
  }
  modeChanged(): void {
    this.selectionToolbar.hide();
    this.scheduleRefresh();
  }
  async setHighlightColor(value: string): Promise<void> {
    if (this.isMobileReview) return;
    if (this.changingDataDirectory) throw new Error('批注目录正在变更，请稍后修改设置。');
    this.settings.highlightColor = highlightColor(value);
    this.applyHighlightColor();
    await this.saveData(this.settings);
  }

  async setDataDirectory(value: string): Promise<void> {
    const directory = annotationDirectory(value, this.app.vault.configDir);
    await this.changeDataDirectory(directory);
    this.notify(`批注目录已设为“${directory}”。原目录保留；未自动搬移批注。`);
  }

  async migrateDataDirectory(source: string, target: string, progress?: (progress: MigrationProgress) => void): Promise<MigrationResult> {
    if (this.isMobileReview) throw new Error('请在桌面端迁移批注，手机同步新目录后即可查看。');
    const directory = annotationDirectory(target, this.app.vault.configDir);
    const result = await this.changeDataDirectory(directory, () => migrateAnnotations(this.app.vault.adapter, source, directory, {
      configDirectory: this.app.vault.configDir,
      checkActive: () => { if (this.disposed) throw new Error('插件已关闭，迁移停止；源文件保留。'); },
      progress, yieldToUi: () => new Promise(resolve => window.setTimeout(resolve, 0))
    }));
    if (!result) throw new Error('迁移未完成，请重试。');
    this.notify(`迁移完成：新增 ${result.copied} 个文件，跳过 ${result.skipped} 个相同文件。当前目录为“${directory}”，源文件保留为备份。`);
    return result;
  }

  private async changeDataDirectory(directory: string,
    migrate?: () => Promise<MigrationResult & {verify: () => Promise<void>}>
  ): Promise<MigrationResult | undefined> {
    if (this.disposed || this.changingDataDirectory) throw new Error('目录正在切换，请稍后重试。');
    if (directory === this.dataFolder && !migrate) return;
    if (this.exporting || this.openModals.size || this.drafts.size) throw new Error('请先保存或取消正在输入的评论，并关闭批注或导出窗口，再切换目录。');
    this.changingDataDirectory = true;
    this.selectionToolbar.hide();
    const previousReviewFiles = this.reviewFiles;
    let result: (MigrationResult & {verify: () => Promise<void>}) | undefined;
    let committed = false;
    try {
      // Each adapter captures its directory, so delayed writes cannot change
      // target. Drain existing operations before replacing the active store.
      if (this.saveTimer !== null) window.clearTimeout(this.saveTimer); this.saveTimer = null;
      if (this.externalTimer !== null) window.clearTimeout(this.externalTimer); this.externalTimer = null;
      if (this.refreshOperation) await this.refreshOperation;
      await Promise.all([...this.reconciliations.values()]);
      await this.flushAnchors(); await this.store.idle();
      this.dataWritesPaused = true;
      result = await migrate?.();
      const errors: unknown[] = [];
      const next = new ThreadStore(this.fileAccess(directory), () => { if (this.store === next) this.scheduleRefresh(); }, error => {
        if (this.store === next) this.report(error); else errors.push(error);
      });
      await next.load();
      if (errors.length) throw new Error('目标目录中有无法读取或不支持的批注文件；未切换目录，原数据保留。');
      await result?.verify();
      if (this.disposed) throw new Error('插件已关闭，目录未切换。');
      await this.saveData({...this.settings, dataDirectory: directory});
      if (this.disposed) throw new Error('插件已关闭；目录配置已保存，重新启用后生效。源文件保留。');
      this.closeDataWatcher(); this.ownDataWrites.clear();
      this.activeDataDirectory = directory; this.settings.dataDirectory = directory;
      this.store = next;
      committed = true;
      this.reviewSourceRequest++; this.locationRequest++;
      this.reviewVersion = -1; this.reviewIndex.clear();
      this.focused = ''; this.focusedHighlight = '';
      this.pendingAnchors.clear(); this.pendingHighlights.clear();
      this.knownSources.clear(); this.sourceVersions.clear(); this.reviewSources.clear();
      for (const doc of this.interactionDocuments.keys()) doc.getSelection()?.removeAllRanges();
    } catch (error) { this.reviewFiles = previousReviewFiles; throw error; }
    finally {
      this.changingDataDirectory = false;
      this.dataWritesPaused = false;
      this.scheduleRefresh();
      if (!committed) this.externalChanged(true);
    }
    try { await this.refreshData(); } catch (error) { this.report(error); }
    this.syncReview(); this.scheduleRefresh();
    return result;
  }
  private applyHighlightColor(): void {
    for (const doc of this.interactionDocuments.keys()) doc.body.style.setProperty('--hn-highlight-color', this.settings.highlightColor);
  }

  notify(message: string): void { new Notice(message); }
  report(error: unknown): void {
    const message = error instanceof Error ? error.message : '操作失败，原数据已保留。';
    if (!this.disposed) new Notice(message, 9000);
    console.error('Highnote:', error);
  }
  run(action: () => Promise<unknown>): void { void action().catch(error => this.report(error)); }

  registerInteractionDocument(doc: Document): void {
    if (this.disposed || this.interactionDocuments.has(doc)) return;
    const component = this.addChild(new Component());
    this.interactionDocuments.set(doc, component);
    doc.body.style.setProperty('--hn-highlight-color', this.settings.highlightColor);
    component.register(() => doc.body.style.removeProperty('--hn-highlight-color'));
    component.registerDomEvent(doc, 'pointerdown', event => {
      if (event.button !== 0 || (!this.focused && !this.focusedHighlight) || this.openModals.size) return;
      const target = event.target;
      if (!(target instanceof doc.defaultView!.Element)) return;
      if (target.closest('.hn-card, .hn-mark, .hn-highlight, .hn-selection-toolbar, .modal, .menu')) return;
      this.clearFocus();
    });
    component.registerDomEvent(doc, 'keydown', event => {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented && !this.openModals.size) this.clearFocus();
    });
  }

  fileThreads(path: string): Thread[] {
    return this.store.viewFile(path).map(t => ({...t, anchor: this.pendingAnchors.get(t.id) ?? t.anchor}));
  }
  fileHighlights(path: string): Highlight[] {
    return this.store.viewHighlights(path).map(item => ({...item, anchor: this.pendingHighlights.get(item.id) ?? item.anchor}));
  }
  editorChanged(path: string, before: string, after: string, changes: ChangeDesc, trusted = true): void {
    if (this.isMobileReview || this.changingDataDirectory) return;
    const known = this.knownSources.get(path);
    if (!trusted && known !== undefined && (after === known || before !== known)) {
      if (after !== known) {
        const file = this.app.vault.getFileByPath(path);
        if (file) this.run(() => this.reconcileFile(file));
      }
      return;
    }
    this.knownSources.set(path, after);
    this.sourceVersions.set(path, (this.sourceVersions.get(path) ?? 0) + 1);
    for (const thread of this.fileThreads(path)) {
      if (thread.fileMissing) continue;
      const anchor = mapAnchor(thread.anchor, before, after, changes, trusted);
      if (JSON.stringify(anchor) !== JSON.stringify(thread.anchor)) this.pendingAnchors.set(thread.id, anchor);
    }
    for (const item of this.fileHighlights(path)) {
      if (item.fileMissing) continue;
      const anchor = mapAnchor(item.anchor, before, after, changes, trusted);
      if (JSON.stringify(anchor) !== JSON.stringify(item.anchor)) this.pendingHighlights.set(item.id, anchor);
    }
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; this.run(() => this.flushAnchors()); }, 150);
  }
  async flushAnchors(): Promise<void> {
    if (this.isMobileReview) return;
    if (this.saving) { await this.saving; if (this.pendingAnchors.size || this.pendingHighlights.size) await this.flushAnchors(); return; }
    this.saving = (async () => {
      const groups = new Map<string, {id: string; anchor: Anchor}[]>();
      for (const [id, anchor] of this.pendingAnchors) {
        const path = this.store.pathOf(id);
        if (!path) { this.pendingAnchors.delete(id); continue; }
        const group = groups.get(path) ?? [];
        group.push({id, anchor});
        groups.set(path, group);
      }
      for (const [path, group] of groups) {
        await this.store.updateFile(path, threads => {
          const latest = new Map(threads.map(thread => [thread.id, thread]));
          for (const {id, anchor} of group) {
            const thread = latest.get(id);
            if (thread) thread.anchor = anchor;
          }
        });
        for (const {id, anchor} of group) if (this.pendingAnchors.get(id) === anchor) this.pendingAnchors.delete(id);
      }
      const highlightGroups = new Map<string, {id: string; anchor: Anchor}[]>();
      for (const [id, anchor] of this.pendingHighlights) {
        const item = this.store.getHighlight(id);
        if (!item) { this.pendingHighlights.delete(id); continue; }
        const group = highlightGroups.get(item.filePath) ?? [];
        group.push({id, anchor}); highlightGroups.set(item.filePath, group);
      }
      for (const [path, group] of highlightGroups) {
        await this.store.updateHighlights(path, items => {
          const latest = new Map(items.map(item => [item.id, item]));
          for (const {id, anchor} of group) { const item = latest.get(id); if (item) item.anchor = anchor; }
        });
        for (const {id, anchor} of group) if (this.pendingHighlights.get(id) === anchor) this.pendingHighlights.delete(id);
      }
    })();
    try { await this.saving; } finally { this.saving = null; }
  }

  compose(selection: NoteSelection): void {
    if (this.isMobileReview) { this.notify('手机版仅支持阅读回顾，评论请在桌面端添加。'); return; }
    if (!this.canModify) { this.notify('请切换到阅读模式后添加评论。'); return; }
    this.selectionToolbar.hide();
    const key = `new:${selection.filePath}:${selection.from}:${selection.to}`;
    const originalFile = this.app.vault.getFileByPath(selection.filePath);
    const modal = new MessageModal(this.app, '添加评论', this.drafts.get(key) ?? '', async body => {
      this.requireReadingMode();
      if (!originalFile || this.app.vault.getFileByPath(selection.filePath) !== originalFile) throw new Error('笔记已移动或删除，请重新选择原文。');
      const source = await this.app.vault.read(originalFile);
      const original = makeAnchor(selection.source, selection.from, selection.to);
      const anchor = source === selection.source ? original : relocateAnchor(source, original);
      if (anchor.state !== 'attached') throw new Error('原文已变化，请关闭此窗口并重新选择。评论草稿会保留到本次会话结束。');
      this.requireReadingMode();
      this.knownSources.set(originalFile.path, source);
      const thread = await this.store.create(originalFile.path, source, anchor.from, anchor.to, body, () => this.requireReadingMode());
      this.currentMarkdownView()?.contentEl.ownerDocument.getSelection()?.removeAllRanges();
      await this.showThread(thread.id);
    }, error => this.report(error), body => body ? this.drafts.set(key, body) : this.drafts.delete(key));
    this.openModal(modal);
  }
  async highlight(selection: NoteSelection): Promise<void> {
    this.requireReadingMode();
    const file = this.app.vault.getFileByPath(selection.filePath);
    if (!file) throw new Error('原文件已移动或删除，请重新选择。');
    await this.flushAnchors();
    const source = await this.app.vault.read(file);
    const original = makeAnchor(selection.source, selection.from, selection.to);
    const anchor = source === selection.source ? original : relocateAnchor(source, original);
    if (anchor.state !== 'attached') throw new Error('原文已变化，请重新选择要标记的文字。');
    this.requireReadingMode();
    this.knownSources.set(file.path, source);
    const item = await this.store.createHighlight(file.path, source, anchor.from, anchor.to, () => this.requireReadingMode());
    const view = this.currentMarkdownView();
    view?.contentEl.ownerDocument.getSelection()?.removeAllRanges();
    await this.showHighlight(item.id);
  }
  async removeHighlight(id: string): Promise<void> {
    this.requireReadingMode();
    await this.store.removeHighlight(id, () => this.requireReadingMode());
    this.pendingHighlights.delete(id);
    if (this.focusedHighlight === id) this.clearFocus();
  }
  openModal(modal: Modal): void {
    this.selectionToolbar.hide();
    this.openModals.add(modal);
    const onClose = modal.onClose.bind(modal);
    modal.onClose = () => { onClose(); this.openModals.delete(modal); };
    modal.open();
  }
  async openSidebar(): Promise<void> {
    if (this.isMobileReview) { await this.openReview(); return; }
    let leaf = this.app.workspace.getLeavesOfType(COMMENTS_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) throw new Error('无法打开评论侧栏。');
      await leaf.setViewState({type: COMMENTS_VIEW, active: true});
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  async showThread(id: string): Promise<void> {
    const thread = this.store.get(id);
    if (!thread) return;
    this.focusThread(id);
    this.activePath = thread.filePath;
    await this.openSidebar();
    this.scheduleRefresh();
    for (const leaf of this.app.workspace.getLeavesOfType(COMMENTS_VIEW)) if (leaf.view instanceof CommentsView) {
      leaf.view.switchPane('comments'); leaf.view.reveal(id);
    }
  }
  private async showHighlight(id: string): Promise<void> {
    const item = this.store.getHighlight(id);
    if (!item) return;
    this.activePath = item.filePath;
    this.focusHighlight(id);
    await this.openSidebar();
    for (const leaf of this.app.workspace.getLeavesOfType(COMMENTS_VIEW)) if (leaf.view instanceof CommentsView) {
      leaf.view.switchPane('highlights'); leaf.view.reveal(id);
    }
    this.scheduleRefresh();
  }
  async revealHighlight(id: string): Promise<void> { await this.showHighlight(id); }
  focusThread(id: string): void {
    if (!this.store.get(id)) return;
    this.setFocus(id);
  }
  focusHighlight(id: string): void {
    if (!this.store.getHighlight(id)) return;
    this.focused = ''; this.focusedHighlight = id; this.refreshFocus();
  }
  clearFocus(): void { this.focusedHighlight = ''; this.setFocus(''); this.refreshFocus(); }
  private setFocus(id: string): void {
    if (this.focused === id && !this.focusedHighlight) return;
    this.focusedHighlight = '';
    this.focused = id;
    this.refreshFocus();
  }
  private refreshFocus(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(COMMENTS_VIEW)) {
      if (!(leaf.view instanceof CommentsView)) continue;
      for (const card of leaf.view.contentEl.querySelectorAll<HTMLElement>('.hn-card')) {
        const selected = Boolean(card.dataset.highlightId ? card.dataset.highlightId === this.focusedHighlight : card.dataset.threadId === this.focused);
        card.toggleClass('hn-card-active', selected);
        card.setAttribute('aria-current', String(selected));
      }
    }
    for (const view of this.editorViews) view.dispatch({effects: refreshComments.of(null)});
    for (const view of this.readingViews) view.refreshFocus();
  }
  private locationRequest = 0;
  async locate(id: string): Promise<void> { await this.locateAnnotation(id, false); }
  async locateHighlight(id: string): Promise<void> { await this.locateAnnotation(id, true); }
  private async locateAnnotation(id: string, highlight: boolean): Promise<void> {
    const request = ++this.locationRequest;
    const reading = this.currentMarkdownView()?.getMode() === 'preview';
    const get = () => highlight ? this.store.getHighlight(id) : this.store.get(id);
    const focus = () => highlight ? this.focusHighlight(id) : this.focusThread(id);
    focus();
    await this.flushAnchors();
    let item = get();
    if (!item || request !== this.locationRequest) return;
    if (item.fileMissing || item.anchor.state !== 'attached') {
      this.notify(item.fileMissing ? '原文件已删除，记录仍保留在侧栏中。' : '原文已无法定位，评论和标记仍保留。');
      return;
    }
    const file = this.app.vault.getFileByPath(item.filePath);
    if (!file) { this.notify('原文件已删除，记录仍保留在侧栏中。'); return; }
    await this.reconcileFile(file);
    item = get();
    if (!item || request !== this.locationRequest) return;
    if (item.anchor.state !== 'attached') {
      this.notify('原文已无法定位，评论和标记仍保留。'); return;
    }
    const current = this.currentMarkdownView();
    const existing = current?.file === file ? current.leaf : this.app.workspace.getLeavesOfType('markdown')
      .find(leaf => leaf.view instanceof MarkdownView && leaf.view.file === file && (reading ? leaf.view.getMode() === 'preview' : true));
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    await leaf.openFile(file);
    if (request !== this.locationRequest) return;
    if (reading && leaf.view instanceof MarkdownView && leaf.view.getMode() !== 'preview') {
      await leaf.setViewState({type: 'markdown', state: {...leaf.view.getState(), mode: 'preview'}, active: true});
    }
    await this.app.workspace.revealLeaf(leaf);
    if (request !== this.locationRequest) return;
    this.activePath = file.path; focus(); this.scheduleRefresh();
    if (!(leaf.view instanceof MarkdownView)) return;
    const view = leaf.view;
    if (view.getMode() === 'preview') {
      await this.locateReading(view, item.anchor, id, highlight, request);
    } else {
      const from = view.editor.offsetToPos(item.anchor.from);
      const to = view.editor.offsetToPos(item.anchor.to);
      view.editor.setSelection(from, to); view.editor.scrollIntoView({from, to}, true);
    }
  }
  private async locateReading(view: MarkdownView, anchor: Anchor, id: string, highlight: boolean, request: number): Promise<void> {
    const source = this.knownSources.get(view.file?.path ?? '') ?? view.previewMode.get();
    const line = source.slice(0, anchor.from).split('\n').length - 1;
    // The public preview scroll API uses source lines and renders distant blocks on demand.
    view.previewMode.applyScroll(line);
    const win = view.contentEl.ownerDocument.defaultView;
    if (!win) return;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
      const path = highlight ? this.store.getHighlight(id)?.filePath : this.store.pathOf(id);
      if (this.disposed || request !== this.locationRequest || view.file?.path !== path || view.getMode() !== 'preview') return;
      view.previewMode.applyScroll(line);
      const renders = [...this.readingViews].filter(render => view.contentEl.contains(render.containerEl));
      for (const render of renders) await render.refresh();
      const span = view.contentEl.querySelector<HTMLElement>(highlight ? `[data-hn-highlight="${id}"]` : `[data-hn-thread="${id}"]`);
      if (span) { span.scrollIntoView({block: 'center'}); return; }
      for (const render of renders) if (render.locateAnchor(anchor)) return;
    }
    // Source location is known even when a custom renderer cannot map individual characters.
    this.notify('已跳转到原文所在段落。');
  }
  private sourceForFile(file: TFile): string | null {
    const active = this.currentMarkdownView();
    if (active?.file === file && active.getMode() === 'source') {
      const source = active.editor.getValue();
      const known = this.knownSources.get(file.path);
      // A mode switch may expose an editor before its old document has synchronized.
      if (known === undefined || source === known) return source;
    }
    return null;
  }
  private reconcileFile(file: TFile): Promise<void> {
    if (this.isMobileReview || this.changingDataDirectory) return Promise.resolve();
    const path = file.path;
    const previous = this.reconciliations.get(path) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => this.reconcileCurrentFile(file, path));
    this.reconciliations.set(path, pending);
    void pending.finally(() => {
      if (this.reconciliations.get(path) === pending) this.reconciliations.delete(path);
    }).catch(() => undefined);
    return pending;
  }
  private async reconcileCurrentFile(file: TFile, path: string): Promise<void> {
    while (!this.disposed && !this.changingDataDirectory && this.app.vault.getFileByPath(path) === file) {
      if (!this.store.viewFile(path).length && !this.store.viewHighlights(path).length) return;
      await this.flushAnchors();
      const version = this.sourceVersions.get(path) ?? 0;
      const source = this.sourceForFile(file) ?? await this.app.vault.read(file);
      if ((this.sourceVersions.get(path) ?? 0) !== version) continue;
      this.knownSources.set(path, source);
      const changes = this.store.forFile(path).map(thread => ({id: thread.id, anchor: relocateAnchor(source, thread.anchor),
        missing: thread.fileMissing, before: JSON.stringify(thread.anchor)}))
        .filter(item => item.missing || JSON.stringify(item.anchor) !== item.before);
      let retry = false;
      if (changes.length) await this.store.updateFile(path, threads => {
        if (this.disposed || this.app.vault.getFileByPath(path) !== file) return;
        const live = this.sourceForFile(file);
        if ((this.sourceVersions.get(path) ?? 0) !== version || (live !== null && live !== source)) { retry = true; return; }
        for (const change of changes) {
          const thread = threads.find(item => item.id === change.id);
          if (!thread) continue;
          if (this.pendingAnchors.has(thread.id) || JSON.stringify(thread.anchor) !== change.before) { retry = true; continue; }
          thread.fileMissing = false; thread.anchor = change.anchor;
        }
      });
      if (retry) continue;
      const highlights = this.store.fileHighlights(path).map(item => ({id: item.id, anchor: relocateAnchor(source, item.anchor),
        missing: item.fileMissing, before: JSON.stringify(item.anchor)}))
        .filter(item => item.missing || JSON.stringify(item.anchor) !== item.before);
      if (highlights.length) await this.store.updateHighlights(path, items => {
        if (this.disposed || this.app.vault.getFileByPath(path) !== file) return;
        const live = this.sourceForFile(file);
        if ((this.sourceVersions.get(path) ?? 0) !== version || (live !== null && live !== source)) { retry = true; return; }
        for (const change of highlights) {
          const item = items.find(candidate => candidate.id === change.id);
          if (!item) continue;
          if (this.pendingHighlights.has(item.id) || JSON.stringify(item.anchor) !== change.before) { retry = true; continue; }
          item.fileMissing = false; item.anchor = change.anchor;
        }
      });
      if (!retry) return;
    }
  }
  async refreshData(): Promise<void> {
    if (this.changingDataDirectory || this.disposed) return;
    if (this.refreshOperation) return this.refreshOperation;
    this.refreshOperation = this.reloadData();
    try { await this.refreshOperation; } finally { this.refreshOperation = null; }
  }
  openExport(scope: ExportScope, kind: ExportKind, returnFocus?: HTMLElement): void {
    this.openReviewExport(kind, '', true, returnFocus, scope, this.activePath);
  }
  async exportComments(scope: ExportScope, format: ExportFormat = 'md'): Promise<TFile | undefined> {
    return this.exportSelected({scope,kind:'comments',format,name:exportBaseName(scope,this.activePath),sourcePath:this.activePath});
  }
  async exportHighlights(scope: ExportScope, format: ExportFormat = 'md'): Promise<TFile | undefined> {
    return this.exportSelected({scope,kind:'highlights',format,name:exportHighlightBaseName(scope,this.activePath),sourcePath:this.activePath});
  }
  async exportSelected(choice: ExportChoice): Promise<TFile | undefined> {
    this.requireReadingMode();
    if (this.exporting) return;
    const {scope,kind,format,sourcePath} = choice;
    if (format !== 'md' && format !== 'html') throw new Error('导出格式无效。');
    const base = exportName(choice.name);
    this.exporting = true;
    try {
      if (this.refreshOperation) await this.refreshOperation;
      await this.flushAnchors();
      await this.store.idle();
      if (this.disposed) return;
      const threads = scope === 'all' ? this.store.all() : this.store.forFile(sourcePath);
      const highlights = scope === 'all' ? this.store.allHighlights() : this.store.fileHighlights(sourcePath);
      const count = kind === 'comments' ? threads.length : highlights.length;
      if (!count) { this.notify(`所选范围没有已保存的${kind === 'comments' ? '评论' : '标记'}。`); return; }
      const exportedAt = new Date();
      let number = 0;
      while (!this.disposed) {
        const title = `${base}${number ? `(${number})` : ''}`;
        const path = normalizePath(`${title}.${format}`);
        if (this.app.vault.getAbstractFileByPath(path)) { number++; continue; }
        let file: TFile;
        this.requireReadingMode();
        const contents = format === 'html' ? exportHtml(title,kind,kind === 'comments' ? threads : highlights,this.app.vault.getName(),exportedAt,
          this.app.workspace.containerEl.ownerDocument.body.hasClass('theme-dark'))
          : kind === 'comments' ? exportMarkdown(title, threads, exportedAt) : exportHighlightsMarkdown(title, highlights, exportedAt);
        try { file = await this.app.vault.create(path,contents); }
        catch (error) {
          if (this.app.vault.getAbstractFileByPath(path)) { number++; continue; }
          throw error;
        }
        this.notify(`已导出 ${count} 条${kind === 'comments' ? '讨论' : '标记'}到“${path}”。`);
        const previous = this.settings.exportFormat;
        this.settings.exportFormat = format;
        try {await this.saveData(this.settings);} catch {this.settings.exportFormat = previous;this.notify('文件已保存，但未能记住导出格式。');}
        try {
          if (format === 'html') await this.openExportInBrowser(file);
          else {
            const leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(file);
            if (leaf.view instanceof MarkdownView) await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});
          }
        } catch {this.notify(`文件已保存到“${file.path}”，自动打开失败，请从笔记库中打开。`);}
        return file;
      }
    } finally { this.exporting = false; }
  }
  async openExportInBrowser(file: TFile): Promise<void> {
    if (!Platform.isDesktop || this.isMobileReview) return;
    const {shell} = await import('electron');
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('无法取得本地导出文件路径。');
    const failure = await shell.openPath(adapter.getFullPath(file.path));
    if (failure) throw new Error('系统浏览器未能打开导出文件。');
  }
  private async reloadData(): Promise<void> {
    if (this.isMobileReview) { await this.store.load(); return; }
    try { await this.flushAnchors(); }
    catch (error) {
      // Only positional caches are discarded; saved messages and input drafts remain intact.
      this.pendingAnchors.clear(); this.pendingHighlights.clear();
      if (!this.disposed) this.notify('位置缓存未能保存，正在重新读取评论和标记并校验原文。输入草稿仍保留。');
      if (!(error instanceof Error)) throw error;
    }
    await this.store.load(path => Boolean(this.app.vault.getFileByPath(path)));
    for (const path of this.store.paths()) {
      const file = this.app.vault.getFileByPath(path);
      if (file && path === this.activePath) await this.reconcileFile(file);
      else if (!file && (this.store.viewFile(path).some(thread => !thread.fileMissing) || this.store.viewHighlights(path).some(item => !item.fileMissing))) await this.markFileMissing(path);
    }
  }
  private async markFileMissing(path: string): Promise<void> {
    const store = this.store;
    await store.updateFile(path, threads => { for (const thread of threads) { thread.fileMissing = true; thread.anchor.state = 'detached'; } });
    if (store !== this.store || this.changingDataDirectory) return;
    await store.updateHighlights(path, items => { for (const item of items) { item.fileMissing = true; item.anchor.state = 'detached'; } });
  }
  private externalChanged(confirmedExternal = false): void {
    if (this.disposed || this.changingDataDirectory || this.writing && !confirmedExternal) return;
    if (this.externalTimer !== null) window.clearTimeout(this.externalTimer);
    this.externalTimer = window.setTimeout(() => { this.externalTimer = null; this.run(() => this.refreshData()); }, 400);
  }
  private scheduleRefresh(): void {
    if (this.disposed || this.changingDataDirectory || this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.disposed || this.changingDataDirectory) return;
      if (!this.activePath) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile?.extension === 'md') this.activePath = activeFile.path;
      }
      for (const view of this.editorViews) view.dispatch({effects: refreshComments.of(null)});
      for (const leaf of this.app.workspace.getLeavesOfType(COMMENTS_VIEW)) if (leaf.view instanceof CommentsView) leaf.view.render();
      const reviews = this.app.workspace.getLeavesOfType(REVIEW_VIEW);
      if (reviews.length) { this.syncReview(); for (const leaf of reviews) if (leaf.view instanceof ReviewView) leaf.view.refresh(); }
      for (const view of this.readingViews) this.run(() => view.refresh());
    }, 70);
  }
  private isDataFile(path: string): boolean { return path.startsWith(`${this.dataFolder}/`) && path.endsWith('.json'); }
  private async dataDigest(raw: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  private closeDataWatcher(): void {
    this.dataWatcherGeneration++;
    this.dataWatcher?.close(); this.dataWatcher = null;
  }
  private async watchData(directory = this.dataFolder): Promise<void> {
    if (!Platform.isDesktop) return;
    if (this.isMobileReview || this.disposed || this.changingDataDirectory || directory !== this.dataFolder || this.dataWatcher || !(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    const generation = this.dataWatcherGeneration;
    // Guard before loading Node: mobile must be able to evaluate the bundle.
    const {watch} = await import('node:fs');
    if (this.isMobileReview || this.disposed || this.changingDataDirectory || generation !== this.dataWatcherGeneration || directory !== this.dataFolder || this.dataWatcher) return;
    const watcher = watch(this.app.vault.adapter.getFullPath(directory), (_event, filename) => {
      if (directory !== this.dataFolder || generation !== this.dataWatcherGeneration) return;
      if (filename && !filename.toString().endsWith('.json')) return;
      if (!filename) { this.externalChanged(true); return; }
      const name = filename.toString();
      this.run(async () => {
        // Watch events may arrive after a local write completes; don't reload the whole vault for them.
        if (this.ownDataWrites.has(name)) {
          const path = `${directory}/${name}`;
          if (await this.app.vault.adapter.exists(path)
            && await this.dataDigest(await this.app.vault.adapter.read(path)) === this.ownDataWrites.get(name)) return;
        }
        if (directory === this.dataFolder && generation === this.dataWatcherGeneration) this.externalChanged(true);
      });
    });
    this.dataWatcher = watcher;
    watcher.on('error', error => {
      watcher.close(); if (this.dataWatcher === watcher) this.dataWatcher = null;
      if (directory === this.dataFolder && generation === this.dataWatcherGeneration) this.report(error);
    });
  }
  private fileAccess(directory = this.dataFolder): ThreadFiles {
    if (this.isMobileReview) { this.reviewFiles = new ReviewFiles(this.app.vault.adapter, directory); return this.reviewFiles; }
    const files = new NoteFiles(this.app.vault.adapter, () => this.run(() => this.watchData(directory)), directory);
    const write = async (id: string, raw: string, action: () => Promise<unknown>) => {
      if (this.dataWritesPaused) throw new Error('批注目录正在变更，请完成后再修改批注。');
      if (directory !== this.dataFolder) throw new Error('批注目录已切换，请刷新后重试。');
      this.writing++;
      const name = `${id}.json`;
      this.ownDataWrites.delete(name);
      if (this.ownDataWrites.size >= 128) this.ownDataWrites.delete(this.ownDataWrites.keys().next().value!);
      try { this.ownDataWrites.set(name, await this.dataDigest(raw)); await action(); }
      catch (error) { this.ownDataWrites.delete(name); throw error; }
      finally { this.writing--; }
    };
    return {
      list: () => files.list(),
      read: id => files.read(id),
      create: (id, raw) => write(id, raw, () => files.create(id, raw)),
      compareAndWrite: (id, expected, next) => write(id, next, () => files.compareAndWrite(id, expected, next))
    };
  }
}

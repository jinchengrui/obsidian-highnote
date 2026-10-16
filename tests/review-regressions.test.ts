import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {ModuleKind, ScriptTarget, transpileModule} from 'typescript';
import {Window} from 'happy-dom';
import type {WorkspaceLeaf} from 'obsidian';
import type HighnotePlugin from '../src/main';
import {ReviewIndex} from '../src/review-model';
import {ThreadStore, type ThreadFiles} from '../src/store';
import {DEFAULT_FLOMO_CONFIG, FLOMO_COLUMNS} from '../src/flomo';

function environment(t: TestContext) {
  const window = new Window();
  t.after(() => window.happyDOM.abort());
  const document = window.document as unknown as Document;
  const prototype = window.HTMLElement.prototype as unknown as HTMLElement;
  const createEl = function(this: HTMLElement, tag: string, options: {text?: string; cls?: string; value?: string; attr?: Record<string, string | null>} = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.text !== undefined) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    if (options.value !== undefined) element.setAttribute('value', options.value);
    for (const [key, value] of Object.entries(options.attr ?? {})) if (value !== null) element.setAttribute(key, value);
    this.append(element); return element;
  };
  Object.assign(prototype, {
    createEl,
    createDiv(this: HTMLElement, options?: Parameters<typeof createEl>[1]) { return createEl.call(this, 'div', options); },
    createSpan(this: HTMLElement, options?: Parameters<typeof createEl>[1]) { return createEl.call(this, 'span', options); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    addClass(this: HTMLElement, name: string) { this.classList.add(name); },
    toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); }
  });
  Object.defineProperties(prototype, {
    win: {configurable: true, get(this: HTMLElement) { return this.ownerDocument.defaultView; }},
    doc: {configurable: true, get(this: HTMLElement) { return this.ownerDocument; }}
  });
  const listeners = new Set<(file: {path: string}, oldPath: string) => void>();
  const app = {
    vault: {
      on(_event: string, listener: (file: {path: string}, oldPath: string) => void) { listeners.add(listener); return listener; },
      offref(listener: (file: {path: string}, oldPath: string) => void) { listeners.delete(listener); }
    },
    workspace: {requestSaveLayout() { savedStates.push(view?.getState()); }}
  };
  const savedStates: (Record<string, unknown> | undefined)[] = [];
  class ItemView {
    app = app;
    contentEl = document.body.appendChild(document.createElement('div'));
    leaf: unknown;
    constructor(leaf: unknown) { this.leaf = leaf; }
    setState(): Promise<void> { return Promise.resolve(); }
    registerDomEvent(element: HTMLElement, event: string, callback: EventListener) { element.addEventListener(event, callback); }
  }
  class Modal {
    app = app;
    modalEl = document.body.appendChild(document.createElement('div'));
    contentEl = this.modalEl.appendChild(document.createElement('div'));
    containerEl = this.modalEl;
    scope = {register() {}};
    setTitle(_title: string) {}
    onOpen() {}
    onClose() {}
    open() { this.onOpen(); }
    close() { this.onClose(); this.modalEl.remove(); }
  }
  const loaded = new Map<string, Record<string, unknown>>();
  function load(file: string): Record<string, unknown> {
    const cached = loaded.get(file); if (cached) return cached;
    const url = new URL(`../src/${file}.ts`, import.meta.url), nativeRequire = createRequire(url);
    const code = transpileModule(readFileSync(url, 'utf8'), {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022}}).outputText;
    const module = {exports: {}};
    new Function('require', 'exports', 'module', code)((id: string) => {
      if (id === 'obsidian') return {ItemView, Modal};
      return nativeRequire(id);
    }, module.exports, module);
    loaded.set(file, module.exports); return module.exports;
  }
  const ReviewView = load('review').ReviewView as typeof import('../src/review').ReviewView;
  const ReviewExportModal = load('review-export-modal').ReviewExportModal as typeof import('../src/review-export-modal').ReviewExportModal;
  const data = new Map<string, string>();
  const files: ThreadFiles = {
    list: async () => [...data.keys()],
    read: async key => { if (!data.has(key)) throw new Error('不存在'); return data.get(key)!; },
    create: async (key, raw) => { assert.equal(data.has(key), false); data.set(key, raw); },
    compareAndWrite: async (key, expected, next) => { assert.equal(data.get(key), expected); data.set(key, next); }
  };
  const store = new ThreadStore(files, () => {}, error => { throw error; });
  const reviewIndex = new ReviewIndex();
  let modal: Modal | undefined;
  let view: InstanceType<typeof ReviewView> | undefined;
  const openedSources: string[] = [];
  const exportedSources: string[] = [];
  const plugin = {
    app, store, reviewIndex, activePath: '阅读/原文.md', exporting: false, canModify: true,
    settings: {exportFormat: 'md', reviewExportFormat: 'md', flomo: {...DEFAULT_FLOMO_CONFIG}},
    syncReview() { reviewIndex.sync(store.viewAll(), store.viewHighlights()); },
    releaseReview() {},
    openModal(value: Modal) { modal = value; value.open(); },
    async run(operation: () => Promise<void>) { await operation(); },
    async openReviewSource(entry: {filePath: string}) { openedSources.push(entry.filePath); },
    async showThread() {},
    async exportReview(_kind: string, _query: string, _replies: boolean, _name: string, _format: string, _scope: string, path: string) { exportedSources.push(path); return {}; }
  };
  const highnote = plugin as unknown as HighnotePlugin;
  const leaf = {} as WorkspaceLeaf;
  const byLabel = <T extends HTMLElement>(root: HTMLElement, label: string) => {
    const element = root.querySelector<T>(`[aria-label="${label}"]`); assert.ok(element); return element;
  };
  return {
    window, app, plugin, store, listeners, savedStates, openedSources, exportedSources, byLabel,
    event(name: string) { return new window.Event(name) as unknown as Event; },
    createView() {
      view = new ReviewView(leaf, highnote); view.viewScope = 'current'; view.sourcePath = plugin.activePath;
      t.after(() => view?.onClose()); return view;
    },
    reviewExport(scope: 'all' | 'current' = 'current') {
      const result = new ReviewExportModal(highnote, 'comments', scope, plugin.activePath);
      t.after(() => result.onClose()); result.onOpen(); return result;
    },
    details() { assert.ok(modal); t.after(() => modal?.onClose()); return modal; },
    emitRename(oldPath: string, newPath: string) { for (const listener of [...listeners]) listener({path: newPath}, oldPath); },
    tick() { return new Promise(resolve => setImmediate(resolve)); }
  };
}

async function source(env: ReturnType<typeof environment>) {
  await env.store.create(env.plugin.activePath, '保存的原文', 0, 5, '当时的想法');
  env.plugin.syncReview();
}

test('current review follows file and folder renames before the store syncs', async t => {
  for (const [oldPath, nextPath, movedPath] of [
    ['阅读/原文.md', '阅读/新名.md', '阅读/新名.md'],
    ['阅读', '归档/阅读', '归档/阅读/原文.md']
  ]) await t.test(nextPath!, async t => {
    const env = environment(t); await source(env);
    const view = env.createView(); await view.onOpen();
    assert.equal(view.contentEl.querySelectorAll('.hn-review-card').length, 1);
    const move = env.store.moveFile('阅读/原文.md', movedPath!);
    env.emitRename(oldPath!, nextPath!);
    assert.equal(view.sourcePath, movedPath);
    assert.equal(env.savedStates.at(-1)?.sourcePath, movedPath);
    await move; env.plugin.syncReview(); view.refresh();
    assert.equal(view.contentEl.querySelectorAll('.hn-review-card').length, 1);
    assert.equal(env.byLabel<HTMLButtonElement>(view.contentEl, '导出阅读回顾').disabled, false);
    assert.equal(env.byLabel<HTMLSelectElement>(view.contentEl, '回顾文档范围').title, movedPath);
    await view.onClose(); assert.equal(env.listeners.size, 0);
  });
});

test('renaming a similar folder does not change the current review source', async t => {
  const env = environment(t); await source(env);
  const view = env.createView(); await view.onOpen();
  env.emitRename('阅', '归档');
  assert.equal(view.sourcePath, '阅读/原文.md');
  assert.equal(env.savedStates.length, 0);
  assert.equal(view.contentEl.querySelectorAll('.hn-review-card').length, 1);
});

test('open review export refreshes its scope and preserves an edited filename after asynchronous rename', async t => {
  const env = environment(t); await source(env);
  const review = env.reviewExport();
  env.byLabel<HTMLInputElement>(review.contentEl, '回顾导出文件名').value = '自定义名称';
  env.byLabel<HTMLInputElement>(review.contentEl, '回顾导出文件名').dispatchEvent(env.event('input'));
  const move = env.store.moveFile('阅读/原文.md', '归档/原文.md');
  env.emitRename('阅读', '归档'); await move;
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.match(review.contentEl.querySelector('.hn-review-export-description')!.textContent!, /归档\/原文\.md.*1 组讨论/u);
  assert.equal(review.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.disabled, false);
  assert.equal(env.byLabel<HTMLInputElement>(review.contentEl, '回顾导出文件名').value, '自定义名称');
  review.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.click(); await env.tick();
  assert.deepEqual(env.exportedSources, ['归档/原文.md']);
  assert.equal(env.listeners.size, 0);
});

test('already open source details use the renamed path before and after store sync', async t => {
  const env = environment(t); await source(env);
  const view = env.createView(); await view.onOpen();
  view.contentEl.querySelector<HTMLButtonElement>('.hn-review-details-link')!.click();
  const details = env.details();
  env.emitRename('阅读', '归档');
  assert.equal(details.contentEl.querySelector('.hn-review-source-name')!.textContent, '原文.md');
  assert.ok(details.contentEl.textContent!.includes('归档/原文.md'));
  await env.store.moveFile('阅读/原文.md', '归档/原文.md');
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.match(details.contentEl.querySelector('.hn-review-detail-messages')!.textContent!, /当时的想法/u);
  [...details.contentEl.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === '回到原文')!.click();
  await env.tick(); assert.deepEqual(env.openedSources, ['归档/原文.md']);
});

test('source details accept later index migrations once a rename has synchronized', async t => {
  const env = environment(t); await source(env);
  const view = env.createView(); await view.onOpen();
  view.contentEl.querySelector<HTMLButtonElement>('.hn-review-details-link')!.click();
  const details = env.details();
  env.emitRename('阅读', '归档');
  await env.store.moveFile('阅读/原文.md', '归档/原文.md');
  await new Promise(resolve => setTimeout(resolve, 330));
  await env.store.moveFile('归档/原文.md', '迁移/最终.md');
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(details.contentEl.querySelector('.hn-review-source-name')!.textContent, '最终.md');
  [...details.contentEl.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === '回到原文')!.click();
  await env.tick(); assert.deepEqual(env.openedSources, ['迁移/最终.md']);
});

test('all-scope CSV invalidates cached source text at the same version on rename', async t => {
  const env = environment(t); await source(env);
  env.plugin.settings.flomo.source = true;
  const modal = env.reviewExport('all');
  const csv = env.byLabel<HTMLInputElement>(modal.contentEl, 'flomo CSV');
  csv.checked = true; csv.dispatchEvent(env.event('change'));
  assert.match(modal.contentEl.querySelector('.hn-flomo-preview-content')!.textContent!, /来源：原文\.md/u);
  // The index was already synchronized, but the modal has not observed its version yet.
  await env.store.moveFile('阅读/原文.md', '归档/新名.md'); env.plugin.syncReview();
  env.emitRename('阅读/原文.md', '归档/新名.md');
  assert.match(modal.contentEl.querySelector('.hn-flomo-preview-content')!.textContent!, /来源：新名\.md/u);
  assert.equal(modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.disabled, false);
});

function csvTemplate(env: ReturnType<typeof environment>) {
  env.plugin.settings.reviewExportFormat = 'flomo_csv';
  env.plugin.settings.flomo.custom = true;
  const modal = env.reviewExport();
  const template = env.byLabel<HTMLTextAreaElement>(modal.contentEl, '正文模板');
  const submit = modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!;
  assert.equal(submit.disabled, false);
  return {modal, template, submit};
}

test('immediate CSV options cancel pending template and separator edits without disabling export', async t => {
  for (const [fieldLabel, optionLabel] of [
    ['正文模板', '包含回复'], ['连接文字', '多次评论之间']
  ]) await t.test(fieldLabel!, async t => {
    const env = environment(t); await source(env);
    env.plugin.settings.flomo.separator = 'custom';
    const {modal, submit} = csvTemplate(env);
    const field = env.byLabel<HTMLTextAreaElement>(modal.contentEl, fieldLabel!);
    field.value = fieldLabel === '正文模板' ? '编辑后：{评论}' : '\n新的连接文字\n';
    field.dispatchEvent(env.event('input'));
    assert.equal(submit.disabled, true);
    const option = env.byLabel<HTMLInputElement | HTMLSelectElement>(modal.contentEl, optionLabel!);
    if (optionLabel === '包含回复') (option as HTMLInputElement).checked = false;
    else option.value = 'blank';
    option.dispatchEvent(env.event('change'));
    assert.equal(submit.disabled, false);
    assert.match(modal.contentEl.querySelector('.hn-flomo-preview-content')!.textContent!, /当时的想法/u);
    assert.equal(modal.contentEl.querySelector('.hn-flomo-error')!.textContent, '');
    submit.click(); await env.tick(); assert.deepEqual(env.exportedSources, ['阅读/原文.md']);
  });
});

test('format changes flush pending edits and permit immediate exports', async t => {
  const env = environment(t); await source(env);
  const {modal, template, submit} = csvTemplate(env);
  template.value = '修改后：{评论}'; template.dispatchEvent(env.event('input'));
  assert.equal(submit.disabled, true);
  const markdown = env.byLabel<HTMLInputElement>(modal.contentEl, 'Markdown');
  markdown.checked = true; markdown.dispatchEvent(env.event('change'));
  assert.equal(submit.disabled, false); assert.equal(submit.textContent, '导出 .md');
  const csv = env.byLabel<HTMLInputElement>(modal.contentEl, 'flomo CSV');
  csv.checked = true; csv.dispatchEvent(env.event('change'));
  assert.equal(submit.disabled, false);
  assert.equal(modal.contentEl.querySelector('.hn-csv-content')!.textContent, '修改后：当时的想法');
});

test('IME cancels an earlier edit and keeps export disabled until composition commits', async t => {
  const env = environment(t); await source(env);
  const {modal, template, submit} = csvTemplate(env);
  template.value = '输入前：{评论}'; template.dispatchEvent(env.event('input'));
  template.dispatchEvent(env.event('compositionstart'));
  template.value = '中文输入：{评论}'; template.dispatchEvent(env.event('input'));
  const replies = env.byLabel<HTMLInputElement>(modal.contentEl, '包含回复');
  replies.checked = false; replies.dispatchEvent(env.event('change'));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(submit.disabled, true);
  template.dispatchEvent(env.event('compositionend'));
  assert.equal(submit.disabled, true);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(submit.disabled, false);
  assert.equal(modal.contentEl.querySelector('.hn-csv-content')!.textContent, '中文输入：当时的想法');
});

test('closing during a pending edit leaves no callback touching the removed modal', async t => {
  const env = environment(t); await source(env);
  const {modal, template} = csvTemplate(env);
  template.value = '待关闭：{评论}'; template.dispatchEvent(env.event('input'));
  modal.close();
  let syncs = 0;
  const sync = env.plugin.syncReview;
  env.plugin.syncReview = () => { syncs++; sync(); };
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(syncs, 0); assert.equal(env.listeners.size, 0);
  assert.equal(modal.contentEl.childElementCount, 0);
});

test('CSV preview uses the exact export columns and a separate full-content reader', async t => {
  const env = environment(t); await source(env);
  const {modal} = csvTemplate(env);
  assert.deepEqual([...modal.contentEl.querySelectorAll('th')].map(cell => cell.textContent), [...FLOMO_COLUMNS]);
  assert.equal(modal.contentEl.querySelector('.hn-csv-content')!.textContent, '原文\n保存的原文\n\n想法\n当时的想法');
  assert.match(modal.contentEl.querySelector('.hn-csv-created')!.textContent!, /^\d{4}-\d{2}-\d{2} /u);
  modal.contentEl.querySelector<HTMLButtonElement>('.hn-preview-full')!.click();
  const full = env.details();
  assert.equal(full.contentEl.querySelector('.hn-full-preview-text')!.textContent, modal.contentEl.querySelector('.hn-csv-content')!.textContent);
  assert.equal(modal.contentEl.querySelector('.hn-flomo-template')!.getAttribute('maxlength'), '50000');
});

test('template and preset panels alternate without losing template edits', async t => {
  const env = environment(t); await source(env);
  const {modal, template} = csvTemplate(env);
  const presets = modal.contentEl.querySelector<HTMLElement>('.hn-flomo-preset-options')!;
  const advanced = modal.contentEl.querySelector<HTMLElement>('.hn-flomo-advanced')!;
  const custom = env.byLabel<HTMLInputElement>(modal.contentEl, '使用自定义模板');
  assert.equal(presets.hidden, true); assert.equal(advanced.hidden, false);
  template.value = '保留编辑：{评论}'; template.dispatchEvent(env.event('input'));
  custom.checked = false; custom.dispatchEvent(env.event('change'));
  assert.equal(presets.hidden, false); assert.equal(advanced.hidden, true);
  custom.checked = true; custom.dispatchEvent(env.event('change'));
  assert.equal(template.value, '保留编辑：{评论}');
  assert.equal(modal.contentEl.querySelector('.hn-csv-content')!.textContent, '保留编辑：当时的想法');
});

test('long CSV content remains inert and every character is reachable in the full preview', async t => {
  const env = environment(t); await source(env);
  const thread = env.store.viewAll()[0]!;
  const body = '<script>literal</script>\n' + '长正文，"原样"\n'.repeat(1100) + '最后一行';
  await env.store.update(thread.id, item => { item.messages[0]!.body = body; });
  env.plugin.settings.flomo.template = '{评论}';
  const {modal} = csvTemplate(env);
  assert.equal(modal.contentEl.querySelector('.hn-csv-content')!.textContent, body);
  assert.equal(modal.contentEl.querySelectorAll('script').length, 0);
  modal.contentEl.querySelector<HTMLButtonElement>('.hn-preview-full')!.click();
  const full = env.details(); const parts: string[] = [];
  while (true) {
    parts.push(full.contentEl.querySelector('.hn-full-preview-text')!.textContent!);
    const next = [...full.contentEl.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '下一段');
    if (!next || next.disabled) break;
    next.click();
  }
  assert.equal(parts.join(''), body);
  assert.ok(parts.every(part => part.length <= 4000));
  full.close();
  assert.equal(modal.contentEl.querySelector('.hn-csv-content')!.textContent, body);
});

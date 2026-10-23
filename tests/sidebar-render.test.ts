import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import {ModuleKind, ScriptTarget, transpileModule} from 'typescript';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';
import type {App, Modal, WorkspaceLeaf} from 'obsidian';
import type HighnotePlugin from '../src/main';
import type {Thread} from '../src/model';

// Obsidian supplies runtime classes in the app; only these boundaries are mocked here.
const runtime = `
export class ItemView {
  constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = leaf.contentEl; }
  register() {}
}
export class WorkspaceLeaf {}
export class Modal {
  constructor(app) { this.app = app; this.contentEl = app.document.createElement('div'); this.modalEl = this.contentEl; }
  setTitle() {}
  close() { this.onClose(); }
}
export class Menu {
  static current;
  constructor() { this.items = []; Menu.current = this; }
  addItem(build) {
    const item = {title: '', disabled: false, callback: () => {},
      setTitle(value) { this.title = value; return this; },
      setIcon() { return this; },
      setDisabled(value) { this.disabled = value; return this; },
      onClick(value) { this.callback = value; return this; }};
    build(item); this.items.push(item); return this;
  }
  addSeparator() { return this; }
  onHide(callback) { this.hidden = callback; }
  hide() { this.hidden?.(); }
  showAtPosition() {}
}
export function setIcon(element, name) { element.dataset.icon = name; }
`;
const runtimeUrl = `data:text/javascript,${encodeURIComponent(runtime)}`;
async function loadView() {
  if (typeof nodeModule.registerHooks === 'function') {
    const hooks = nodeModule.registerHooks({resolve(specifier, context, nextResolve) {
      return specifier === 'obsidian' ? {url: runtimeUrl, shortCircuit: true} : nextResolve(specifier, context);
    }});
    try { return {ui: await import('../src/ui'), obsidian: await import('obsidian')}; }
    finally { hooks.deregister(); }
  }
  // Node 22.11 predates registerHooks; reuse the repository's CommonJS boundary loader.
  const host = {exports: {}};
  const hostCode = transpileModule(runtime, {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022}}).outputText;
  new Function('exports', hostCode)(host.exports);
  const url = new URL('../src/ui.ts', import.meta.url);
  const nativeRequire = nodeModule.createRequire(url);
  const code = transpileModule(readFileSync(url, 'utf8'), {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022}}).outputText;
  const module = {exports: {}};
  new Function('require', 'exports', 'module', code)((id: string) => id === 'obsidian' ? host.exports : nativeRequire(id), module.exports, module);
  return {ui: module.exports as typeof import('../src/ui'), obsidian: host.exports as typeof import('obsidian')};
}
const {ui: {CommentsView, MessageModal}, obsidian} = await loadView();
const menus = obsidian.Menu as unknown as {current: {items: {title: string; callback: () => void}[]}};

interface ElementOptions {
  cls?: string;
  text?: string;
  value?: string;
  attr?: Record<string, string>;
}
type ElementMethods = {
  createEl(this: HTMLElement, tag: string, options?: ElementOptions): HTMLElement;
  createDiv(this: HTMLElement, options?: ElementOptions): HTMLElement;
  createSpan(this: HTMLElement, options?: ElementOptions): HTMLElement;
  addClass(this: HTMLElement, ...names: string[]): void;
  hasClass(this: HTMLElement, name: string): boolean;
  toggleClass(this: HTMLElement, name: string, force: boolean): void;
  setText(this: HTMLElement, value: string): void;
  empty(this: HTMLElement): void;
  scrollIntoView(this: HTMLElement): void;
};

function discussion(id: string, count: number, from = 0): Thread {
  const now = '2026-01-01T00:00:00Z';
  return {schemaVersion: 1, id, revision: 1, filePath: '笔记.md', fileMissing: false,
    anchor: {from, to: from + 2, quote: '原文', before: '', after: '', state: 'attached'},
    resolved: false, createdAt: now, updatedAt: now,
    messages: Array.from({length: count}, (_, index) => ({id: `${id}-${index}`, deleted: false,
      body: `消息 ${index + 1}\n**加粗全文**\n第二行\n第三行\n第四行\n结尾 ${index + 1}`,
      createdAt: now, updatedAt: now}))};
}

async function sidebar(records: Thread[], all = false, mobile = false, navigation = false, writable = true) {
  const window = new Window();
  const prototype = window.HTMLElement.prototype as unknown as ElementMethods;
  prototype.createEl = function(tag, options = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.value !== undefined) element.setAttribute('value', options.value);
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.append(element);
    return element;
  };
  prototype.createDiv = function(options) { return prototype.createEl.call(this, 'div', options); };
  prototype.createSpan = function(options) { return prototype.createEl.call(this, 'span', options); };
  prototype.addClass = function(...names) { this.classList.add(...names); };
  prototype.hasClass = function(name) { return this.classList.contains(name); };
  prototype.toggleClass = function(name, force) { this.classList.toggle(name, force); };
  prototype.setText = function(value) { this.textContent = value; };
  prototype.empty = function() { this.replaceChildren(); };
  prototype.scrollIntoView = function() {};
  const element = window.document.createElement('div');
  window.document.body.append(element);
  const root = element as unknown as HTMLElement;
  const app = {document: window.document} as unknown as App;
  const items = records.map(record => structuredClone(record));
  const drafts = new Map<string, string>();
  const errors: unknown[] = [];
  const modals: Modal[] = [];
  let view: InstanceType<typeof CommentsView>;
  const plugin = {
    settings: {showCommentNavigation: navigation},
    isMobile: mobile, openModals: new Set(), activePath: '笔记.md', canModify: writable, focused: '', focusedHighlight: '', drafts,
    registerInteractionDocument() {}, requireReadingMode() {},
    report(error: unknown) { errors.push(error); },
    run(work: () => Promise<void>) { void work().catch(error => errors.push(error)); },
    focusThread(id: string) { this.focused = id; },
    clearFocus() { this.focused = ''; },
    openModal(modal: Modal) { modals.push(modal); modal.onOpen(); },
    store: {
      version: 0,
      get(id: string) { const item = items.find(item => item.id === id); return item ? structuredClone(item) : undefined; },
      getHighlight() { return undefined; },
      viewAll() { return items; }, viewFile(path: string) { return items.filter(item => item.filePath === path); },
      viewHighlights() { return []; },
      async update(id: string, edit: (thread: Thread) => void) {
        const index = items.findIndex(item => item.id === id);
        if (index < 0) throw new Error('讨论已删除');
        const next = structuredClone(items[index]!);
        edit(next); next.revision++; items[index] = next; this.version++;
        view.render();
      },
      async deleteMessage(id: string, messageId: string) {
        const index = items.findIndex(item => item.id === id);
        const next = structuredClone(items[index]!);
        const message = next.messages.find(message => message.id === messageId)!;
        message.deleted = true; message.body = ''; next.revision++;
        const removed = next.messages.every(message => message.deleted);
        if (removed) items.splice(index, 1); else items[index] = next; this.version++;
        view.render();
        return removed;
      }
    }
  };
  view = new CommentsView({app, contentEl: root} as unknown as WorkspaceLeaf, plugin as unknown as HighnotePlugin);
  if (all) view.viewScope = 'all';
  await view.onOpen();
  const card = (id: string) => root.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
  const page = (id: string, direction: string) => {
    const button = card(id).querySelector<HTMLButtonElement>(`[data-hn-message-page="${direction}"]`)!;
    assert.ok(button && !button.disabled, `${id} ${direction} 应可点击`);
    button.click();
  };
  const input = (id: string) => card(id).querySelector<HTMLTextAreaElement>('.hn-inline-reply-input')!;
  const draft = (id: string, body: string) => {
    const textarea = input(id);
    textarea.focus(); textarea.value = body;
    textarea.dispatchEvent(new window.Event('input') as unknown as Event);
    return textarea;
  };
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return {window, root, app, view, items, plugin, drafts, errors, modals, card, page, input, draft, settle};
}

test('评论弹窗完整展示可选择的纯文本原文，与评论和预览分开，重开不重复', async t => {
  const state = await sidebar([]);
  t.after(() => state.window.happyDOM.abort());
  // 用户要求对照原文；长文本、纯文本、可复制与滚动是本轮设计约定。
  const quote = '  引用开头🙂\n<img src=x onerror="alert(1)"> & <script>alert(2)</script>\n**原文不是评论格式**\n'
    + '很长的中文原文保留完整内容🦑\n'.repeat(200) + '引用末尾  ';
  const modal = new MessageModal(state.app, '添加评论', '独立评论草稿', async () => {}, error => state.errors.push(error), undefined, '保存', quote);
  const style = state.window.document.createElement('style');
  style.textContent = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  state.window.document.head.append(style);
  state.window.document.body.append(modal.contentEl as never);
  const verify = () => {
    const reference = modal.contentEl.querySelector<HTMLElement>('.hn-compose-reference')!;
    const block = reference.querySelector<HTMLElement>('.hn-compose-quote')!;
    const field = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
    assert.equal(block.textContent, quote);
    assert.equal(block.children.length, 0, '原文中的HTML和Markdown均保持文本');
    assert.equal(reference.querySelector('textarea,input,[contenteditable="true"]'), null);
    assert.equal(block.tabIndex, 0);
    assert.ok(block.getAttribute('aria-label'));
    assert.equal(field.value, '独立评论草稿');
    assert.equal(modal.contentEl.querySelector('.hn-preview')?.textContent, '独立评论草稿');
    const children = [...modal.contentEl.children];
    assert.ok(children.indexOf(reference) < children.indexOf(modal.contentEl.querySelector('.hn-format-toolbar')!));
    assert.ok(children.indexOf(reference) < children.indexOf(field));
    assert.equal(modal.contentEl.querySelectorAll('.hn-compose-quote').length, 1);
    const computed = state.window.getComputedStyle(block as never);
    assert.equal(computed.whiteSpace, 'pre-wrap');
    assert.equal(computed.userSelect, 'text');
    // happy-dom does not expand the overflow shorthand into overflowY.
    assert.ok(['auto', 'scroll'].includes(computed.overflowY || computed.overflow));
    assert.ok(parseFloat(computed.maxHeight) > 0 && parseFloat(computed.maxHeight) < 500, '长引用有合理的有限高度');
    const range = state.window.document.createRange();
    range.selectNodeContents(block as never);
    const selection = state.window.document.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    assert.equal(selection.toString(), quote);
    selection.removeAllRanges();
  };
  modal.onOpen(); verify();
  modal.close(); assert.equal(modal.contentEl.childElementCount, 0);
  modal.onOpen(); verify(); modal.close();
});

test('评论弹窗不提供引用或提供空引用时兼容旧调用，正常保存评论', async t => {
  const state = await sidebar([]);
  t.after(() => state.window.happyDOM.abort());
  const saved: string[] = [];
  const modals = [
    new MessageModal(state.app, '旧调用', '旧草稿', async body => {saved.push(body);}, error => state.errors.push(error)),
    new MessageModal(state.app, '空引用', '空引用草稿', async body => {saved.push(body);}, error => state.errors.push(error), undefined, '保存', '')
  ];
  for (const modal of modals) {
    modal.onOpen();
    assert.equal(modal.contentEl.querySelector('.hn-compose-reference'), null);
    assert.equal(modal.contentEl.querySelectorAll('textarea').length, 1);
    modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.click();
    await state.settle();
    assert.equal(modal.contentEl.childElementCount, 0);
  }
  assert.deepEqual(saved, ['旧草稿', '空引用草稿']);
  assert.deepEqual(state.errors, []);
});

test('移动与短屏引用区逐级收紧高度并保留全文、滚动和评论草稿', async t => {
  // 本轮设计约定只要求有限高度及短屏更紧凑，不绑定实现中的精确像素值。
  const quote = '长原文🙂\n'.repeat(120) + '最后一行';
  const heights: number[] = [];
  for (const scenario of [{mobile: false, height: 956}, {mobile: true, height: 956}, {mobile: true, height: 220}]) {
    const state = await sidebar([]);
    t.after(() => state.window.happyDOM.abort());
    state.window.happyDOM.setViewport({width: 440, height: scenario.height});
    if (scenario.mobile) state.window.document.body.classList.add('is-mobile');
    const style = state.window.document.createElement('style');
    style.textContent = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    state.window.document.head.append(style);
    let draft = '';
    const modal = new MessageModal(state.app, '添加评论', '旋转前评论草稿', async () => {}, error => state.errors.push(error), body => {draft = body;}, '保存', quote);
    state.window.document.body.append(modal.contentEl as never); modal.onOpen();
    const block = modal.contentEl.querySelector<HTMLElement>('.hn-compose-quote')!;
    const computed = state.window.getComputedStyle(block as never);
    const height = parseFloat(computed.maxHeight);
    assert.ok(Number.isFinite(height) && height > 0 && height < scenario.height, '引用高度受限，为输入保留空间');
    heights.push(height);
    assert.ok(['auto', 'scroll'].includes(computed.overflowY || computed.overflow));
    assert.equal(computed.whiteSpace, 'pre-wrap'); assert.equal(computed.overflowWrap, 'anywhere');
    assert.equal(computed.userSelect, 'text'); assert.equal(block.textContent, quote);
    const field = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
    field.value = '旋转后草稿仍在\n第二行'; field.dispatchEvent(new state.window.Event('input') as unknown as Event);
    state.window.happyDOM.setViewport({width: 956, height: 440});
    assert.equal(field.value, '旋转后草稿仍在\n第二行'); assert.equal(draft, field.value);
    assert.equal(block.textContent, quote); assert.equal(modal.contentEl.querySelectorAll('.hn-compose-reference').length, 1);
    assert.equal(modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.disabled, false);
    modal.close(); assert.equal(draft, '旋转后草稿仍在\n第二行');
  }
  assert.ok(heights[1]! < heights[0]!, '移动端引用比桌面更紧凑');
  assert.ok(heights[2]! < heights[1]!, '短屏引用比移动竖屏更紧凑');
});

test('宿主打开含引用弹窗后转移焦点，下一轮事件循环恢复评论输入并保留原文键盘访问', async t => {
  const state = await sidebar([]);
  t.after(() => state.window.happyDOM.abort());
  const modal = new MessageModal(state.app, '添加评论', '打开即可输入', async () => {}, error => state.errors.push(error), undefined, '保存', '原文🙂\n第二行');
  state.window.document.body.append(modal.contentEl as never);
  modal.onOpen();
  const field = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  const quote = modal.contentEl.querySelector<HTMLElement>('.hn-compose-quote')!;
  assert.equal(state.window.document.activeElement, field);
  // 模拟Obsidian Modal.open在onOpen返回后聚焦首个tabbable，不能同步执行恢复回调。
  modal.contentEl.querySelector<HTMLElement>('[tabindex="0"],button,textarea')!.focus();
  assert.equal(state.window.document.activeElement, quote);
  await state.window.happyDOM.waitUntilComplete();
  assert.equal(state.window.document.activeElement, field);
  assert.equal(field.value, '打开即可输入'); assert.equal(field.disabled, false);
  assert.equal(quote.tabIndex, 0); quote.focus();
  assert.equal(state.window.document.activeElement, quote, '恢复输入焦点后仍允许键盘访问原文');
  await state.window.happyDOM.waitUntilComplete();
  assert.equal(state.window.document.activeElement, quote, '一次恢复不反复抢走原文焦点');
  modal.close();
});

test('含引用弹窗在恢复焦点前关闭会取消回调，重开仅聚焦新输入框', async t => {
  const state = await sidebar([]);
  t.after(() => state.window.happyDOM.abort());
  let draft = '';
  const modal = new MessageModal(state.app, '添加评论', '未发送草稿', async () => {}, error => state.errors.push(error), body => {draft = body;}, '保存', '原文');
  state.window.document.body.append(modal.contentEl as never); modal.onOpen();
  const firstField = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  const oldFocus = t.mock.method(firstField, 'focus');
  const elsewhere = state.window.document.createElement('button');
  state.window.document.body.append(elsewhere);
  modal.close(); modal.close(); elsewhere.focus();
  await state.window.happyDOM.waitUntilComplete();
  assert.equal(oldFocus.mock.callCount(), 0, '关闭后旧输入框定时回调不得执行');
  assert.equal(state.window.document.activeElement, elsewhere); assert.equal(draft, '未发送草稿');
  modal.onOpen();
  const nextField = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  assert.notEqual(nextField, firstField);
  modal.contentEl.querySelector<HTMLElement>('.hn-compose-quote')!.focus();
  await state.window.happyDOM.waitUntilComplete();
  assert.equal(state.window.document.activeElement, nextField);
  assert.equal(oldFocus.mock.callCount(), 0);
  assert.equal(modal.contentEl.querySelectorAll('.hn-compose-quote').length, 1); modal.close();
});

test('引用区不干扰格式、输入法和异步保存，失败保留评论草稿，重试只提交评论', async t => {
  const state = await sidebar([]);
  t.after(() => state.window.happyDOM.abort());
  const quote = '引用原句\n第二行 <b>保持字面量</b>';
  let currentDraft = '', fail = true, release!: () => void;
  const error = new Error('模拟保存失败');
  const saved: string[] = [];
  const modal = new MessageModal(state.app, '添加评论', '', async body => {
    saved.push(body); await new Promise<void>(resolve => {release = resolve;});
    if (fail) throw error;
  }, error => state.errors.push(error), body => {currentDraft = body;}, '保存', quote);
  modal.onOpen();
  const field = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  const submit = modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!;
  field.value = '评论内容'; field.setSelectionRange(0, field.value.length);
  modal.contentEl.querySelector<HTMLButtonElement>('.hn-format-toolbar button')!.click();
  assert.equal(field.value, '**评论内容**'); assert.equal(currentDraft, '**评论内容**');
  assert.equal(modal.contentEl.querySelector('.hn-preview strong')?.textContent, '评论内容');
  field.dispatchEvent(new state.window.Event('compositionstart') as unknown as Event);
  submit.click(); await state.settle(); assert.equal(saved.length, 0);
  field.dispatchEvent(new state.window.Event('compositionend') as unknown as Event);
  submit.click(); submit.click(); await state.settle();
  assert.deepEqual(saved, ['**评论内容**']); assert.equal(submit.disabled, true); assert.equal(field.disabled, true);
  assert.equal(modal.contentEl.querySelector('.hn-compose-quote')?.textContent, quote);
  release(); await state.settle();
  assert.equal(state.errors[0], error); assert.equal(currentDraft, '**评论内容**');
  assert.equal(field.value, '**评论内容**'); assert.equal(field.disabled, false); assert.equal(submit.disabled, false);
  assert.equal(modal.contentEl.querySelector('.hn-compose-quote')?.textContent, quote);
  fail = false; submit.click(); await state.settle(); release(); await state.settle();
  assert.deepEqual(saved, ['**评论内容**', '**评论内容**']); assert.equal(currentDraft, '');
  assert.equal(modal.contentEl.childElementCount, 0);
});

test('1000 messages render only 40 complete messages and all batches remain reachable', async t => {
  const state = await sidebar([discussion('long', 1000)]);
  t.after(() => state.window.happyDOM.abort());
  const expected = state.items[0]!.messages;
  const ids: string[] = [];
  let maximumNodes = 0;
  for (let page = 0; page < 25; page++) {
    const rows = [...state.card('long').querySelectorAll<HTMLElement>('.hn-message')];
    assert.equal(rows.length, 40);
    rows.forEach((row, offset) => {
      const message = expected[page * 40 + offset]!;
      assert.equal(row.dataset.messageId, message.id);
      const body = row.querySelector<HTMLElement>('.hn-message-body')!;
      assert.equal(body.querySelector('strong')?.textContent, '加粗全文');
      assert.equal(body.querySelectorAll('p').length, 6);
      assert.ok(body.textContent?.endsWith(`结尾 ${page * 40 + offset + 1}`));
      ids.push(row.dataset.messageId!);
    });
    maximumNodes = Math.max(maximumNodes, state.root.querySelectorAll('*').length);
    assert.ok(state.root.querySelectorAll('*').length < 1000);
    if (page < 24) state.page('long', 'next');
  }
  assert.deepEqual(ids, expected.map(message => message.id));
  assert.ok(maximumNodes < 1000);
  assert.equal(state.card('long').querySelector('[data-hn-message-pagination] span')?.textContent, '961–1000 / 1000');
  assert.equal(state.card('long').querySelector<HTMLButtonElement>('[data-hn-message-page="next"]')!.disabled, true);
  state.page('long', 'first');
  assert.equal(state.card('long').querySelector<HTMLElement>('.hn-message')?.dataset.messageId, 'long-0');
});

test('all-document summaries also page all 1000 bodies and expansion preserves that batch', async t => {
  const state = await sidebar([discussion('long', 1000)], true);
  t.after(() => state.window.happyDOM.abort());
  for (let page = 0; page < 25; page++) {
    const body = state.card('long').querySelector<HTMLElement>('.hn-summary-body')!;
    assert.equal(body.children.length, 40);
    assert.ok(body.textContent?.includes(`结尾 ${(page + 1) * 40}`));
    assert.ok(body.textContent?.includes('第四行'));
    assert.ok(state.root.querySelectorAll('*').length < 300);
    if (page < 24) state.page('long', 'next');
  }
  state.card('long').querySelector<HTMLButtonElement>('.hn-summary-body')!.click();
  assert.equal(state.card('long').querySelectorAll('.hn-message').length, 40);
  assert.equal(state.card('long').querySelector<HTMLElement>('.hn-message')?.dataset.messageId, 'long-960');
  state.card('long').querySelector<HTMLButtonElement>('.hn-overview-collapse')!.click();
  assert.equal(state.card('long').querySelector('[data-hn-message-pagination] span')?.textContent, '961–1000 / 1000');
});

test('independent discussion batches survive refresh, pane switches and input focus with drafts', async t => {
  const state = await sidebar([discussion('first', 1000), discussion('second', 1000, 10)]);
  t.after(() => state.window.happyDOM.abort());
  const textarea = state.draft('first', '草稿全文\n继续编辑');
  textarea.setSelectionRange(2, 5);
  state.view.render();
  assert.equal(state.root.ownerDocument.activeElement, state.input('first'));
  assert.equal(state.input('first').selectionStart, 2);
  assert.equal(state.input('first').selectionEnd, 5);
  state.page('first', 'last'); state.page('second', 'next');
  state.view.switchPane('highlights'); state.view.switchPane('comments');
  assert.equal(state.card('first').querySelector<HTMLElement>('.hn-message')?.dataset.messageId, 'first-960');
  assert.equal(state.card('second').querySelector<HTMLElement>('.hn-message')?.dataset.messageId, 'second-40');
  assert.equal(state.input('first').value, '草稿全文\n继续编辑');
  assert.equal(state.drafts.get('inline:first'), '草稿全文\n继续编辑');
  assert.equal(state.root.querySelectorAll('.hn-message').length, 80);
  assert.ok(state.root.querySelectorAll('*').length < 1900);
});

test('reveal locates a message, follows it through deletions and clamps a deleted partial tail', async t => {
  const state = await sidebar([discussion('long', 81)]);
  t.after(() => state.window.happyDOM.abort());
  state.draft('long', '未发出的草稿');
  state.view.reveal('long', 'long-80');
  assert.equal(state.card('long').querySelector<HTMLElement>('.hn-message[aria-current="true"]')?.dataset.messageId, 'long-80');
  await state.plugin.store.deleteMessage('long', 'long-0');
  assert.equal(state.card('long').querySelector('[data-hn-message-pagination] span')?.textContent, '41–80 / 80');
  assert.equal(state.card('long').querySelector<HTMLElement>('.hn-message[aria-current="true"]')?.dataset.messageId, 'long-80');
  await state.plugin.store.deleteMessage('long', 'long-80');
  assert.equal(state.card('long').querySelector('[data-hn-message-pagination] span')?.textContent, '41–79 / 79');
  assert.equal(state.card('long').querySelectorAll('.hn-message').length, 39);
  assert.equal(state.card('long').querySelector('[aria-current="true"].hn-message'), null);
  assert.equal(state.input('long').value, '未发出的草稿');
  assert.equal(state.errors.length, 0);
});

test('message controls retain focus on refresh and composing drafts defer batch rendering', async t => {
  const state = await sidebar([discussion('long', 1000)]);
  t.after(() => state.window.happyDOM.abort());
  const textarea = state.draft('long', '正在输入的草稿');
  textarea.dispatchEvent(new state.window.Event('compositionstart') as unknown as Event);
  state.page('long', 'next');
  assert.equal(state.card('long').querySelector<HTMLElement>('.hn-message')?.dataset.messageId, 'long-0');
  textarea.value = '正在输入的草稿完整';
  textarea.dispatchEvent(new state.window.Event('compositionend') as unknown as Event);
  assert.equal(state.card('long').querySelector<HTMLElement>('.hn-message')?.dataset.messageId, 'long-40');
  assert.equal(state.input('long').value, '正在输入的草稿完整');
  const more = state.card('long').querySelector<HTMLButtonElement>('.hn-message-more')!;
  more.focus(); state.view.render();
  assert.equal(state.root.ownerDocument.activeElement, state.card('long').querySelector('.hn-message-more'));
  assert.equal(state.card('long').querySelector<HTMLElement>('.hn-message[aria-current="true"]')?.dataset.messageId, 'long-40');
  state.page('long', 'next');
  const activePage = state.root.ownerDocument.activeElement;
  assert.equal((activePage as HTMLElement).dataset.hnMessagePage, 'next');
  state.view.render();
  assert.equal((state.root.ownerDocument.activeElement as HTMLElement).dataset.hnMessagePage, 'next');
  assert.equal(state.drafts.get('inline:long'), '正在输入的草稿完整');
});

test('new data and sending replies jump to the tail, with bounded messages and failed-send drafts', async t => {
  const state = await sidebar([discussion('long', 1000)], true);
  t.after(() => state.window.happyDOM.abort());
  await state.plugin.store.update('long', thread => {
    thread.messages.push({...thread.messages[0]!, id: 'external', body: '新增全文'});
  });
  assert.equal(state.card('long').querySelector('[data-hn-message-pagination] span')?.textContent, '1001–1001 / 1001');
  state.page('long', 'first');
  state.card('long').querySelector<HTMLButtonElement>('.hn-overview-reply')!.click();
  state.draft('long', '发送的全文\n第四行保留');
  state.card('long').querySelector<HTMLButtonElement>('.hn-inline-send')!.click();
  await state.settle();
  assert.equal(state.card('long').querySelector('[data-hn-message-pagination] span')?.textContent, '1001–1002 / 1002');
  assert.equal(state.card('long').querySelectorAll('.hn-message').length, 2);
  assert.ok(state.card('long').querySelector('.hn-message[aria-current="true"]')?.textContent?.includes('第四行保留'));
  assert.equal(state.drafts.has('inline:long'), false);
  state.draft('long', '发送失败要保留');
  state.plugin.store.update = async () => { throw new Error('模拟保存冲突'); };
  state.card('long').querySelector<HTMLButtonElement>('.hn-inline-send')!.click();
  await state.settle();
  assert.equal(state.input('long').value, '发送失败要保留');
  assert.equal(state.drafts.get('inline:long'), '发送失败要保留');
  assert.equal(state.errors.length, 1);
});

test('editing and deleting tail messages preserve reply drafts and shrink the tail batch', async t => {
  const state = await sidebar([discussion('long', 81)]);
  t.after(() => state.window.happyDOM.abort());
  state.draft('long', '回复草稿保留'); state.page('long', 'last');
  const choose = async (title: string) => {
    state.card('long').querySelector<HTMLButtonElement>('.hn-message-more')!.click();
    menus.current.items.find(item => item.title === title)!.callback();
    await state.settle();
    return state.modals.at(-1)!;
  };
  const edit = await choose('编辑');
  const field = edit.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  field.value = '编辑后的完整内容\n第四行';
  edit.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!.click();
  await state.settle();
  assert.ok(state.card('long').querySelector('.hn-message-body')?.textContent?.includes('编辑后的完整内容'));
  assert.equal(state.input('long').value, '回复草稿保留');
  const remove = await choose('删除');
  remove.contentEl.querySelector<HTMLButtonElement>('button.mod-warning')!.click();
  await state.settle();
  assert.equal(state.card('long').querySelector('[data-hn-message-pagination] span')?.textContent, '41–80 / 80');
  assert.equal(state.card('long').querySelectorAll('.hn-message').length, 40);
  assert.equal(state.input('long').value, '回复草稿保留');
  assert.equal(state.drafts.get('inline:long'), '回复草稿保留');
  assert.equal(state.errors.length, 0);
});

test('deleting the last message removes its batch state and draft with the empty discussion', async t => {
  const state = await sidebar([discussion('only', 1)]);
  t.after(() => state.window.happyDOM.abort());
  state.draft('only', '空讨论草稿');
  state.card('only').querySelector<HTMLButtonElement>('.hn-message-more')!.click();
  menus.current.items.find(item => item.title === '删除')!.callback();
  await state.settle();
  state.modals.at(-1)!.contentEl.querySelector<HTMLButtonElement>('button.mod-warning')!.click();
  await state.settle();
  assert.equal(state.root.querySelector('[data-thread-id="only"]'), null);
  assert.equal(state.drafts.has('inline:only'), false);
  assert.equal(state.errors.length, 0);
});

test('discussion batches replace cards and cross-batch navigation restores saved message pages and drafts', async t => {
  const records = Array.from({length: 41}, (_, index) => discussion(`thread-${index}`, index === 0 ? 81 : 1, index * 10));
  const state = await sidebar(records, false, false, true);
  t.after(() => state.window.happyDOM.abort());
  state.draft('thread-0', '跨讨论批次草稿');
  state.page('thread-0', 'last');
  assert.equal(state.root.querySelectorAll('[data-thread-id].hn-card').length, 40);
  assert.equal(state.root.querySelectorAll('.hn-message').length, 40);
  state.card('thread-39').querySelector<HTMLButtonElement>('[data-hn-navigation="next"]')!.click();
  assert.equal(state.root.querySelectorAll('[data-thread-id].hn-card').length, 1);
  assert.ok(state.card('thread-40'));
  state.card('thread-40').querySelector<HTMLButtonElement>('[data-hn-navigation="previous"]')!.click();
  assert.equal(state.root.querySelectorAll('[data-thread-id].hn-card').length, 40);
  assert.equal(state.card('thread-0').querySelector<HTMLElement>('.hn-message')?.dataset.messageId, 'thread-0-80');
  assert.equal(state.input('thread-0').value, '跨讨论批次草稿');
  state.root.querySelector<HTMLButtonElement>('[data-hn-thread-page="next"]')!.click();
  await state.plugin.store.deleteMessage('thread-40', 'thread-40-0');
  assert.equal(state.root.querySelectorAll('[data-thread-id].hn-card').length, 40);
  assert.equal(state.root.querySelector('[data-hn-thread-page]'), null);
  assert.equal(state.drafts.get('inline:thread-0'), '跨讨论批次草稿');
});


test('默认隐藏评论导航，开启恢复首末边界，关闭后解决操作和草稿保留', async t => {
  const state = await sidebar([discussion('first', 1), discussion('last', 1, 10)]);
  t.after(() => state.window.happyDOM.abort());
  const style = state.window.document.createElement('style');
  style.textContent = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  state.window.document.head.append(style);
  const header = (id: string) => state.card(id).querySelector<HTMLElement>('.hn-card-header')!;
  const controls = (id: string) => header(id).querySelectorAll('button');
  assert.equal(state.root.querySelectorAll('[data-hn-navigation]').length, 0);
  assert.equal(header('first').querySelector('.hn-thread-tools')?.childElementCount, 1);
  assert.ok(header('first').querySelector('.hn-resolve'));
  state.draft('first', '切换设置保留草稿');
  state.plugin.settings.showCommentNavigation = true; state.view.render();
  const expandedGap = parseFloat(state.window.getComputedStyle(header('first') as never).gap);
  assert.equal(state.root.querySelectorAll('[data-hn-navigation]').length, 4);
  assert.equal(state.card('first').querySelector<HTMLButtonElement>('[data-hn-navigation="previous"]')!.disabled, true);
  assert.equal(state.card('last').querySelector<HTMLButtonElement>('[data-hn-navigation="next"]')!.disabled, true);
  state.card('first').querySelector<HTMLButtonElement>('[data-hn-navigation="next"]')!.click();
  assert.equal(state.plugin.focused, 'last');
  state.plugin.settings.showCommentNavigation = false; state.view.render();
  assert.equal(state.root.querySelectorAll('[data-hn-navigation]').length, 0);
  assert.equal(header('first').querySelector('.hn-thread-tools')?.childElementCount, 1);
  assert.ok(parseFloat(state.window.getComputedStyle(header('first') as never).gap) < expandedGap, '移除导航后缩小操作间距');
  assert.equal(state.input('first').value, '切换设置保留草稿');
  assert.equal([...controls('first')].filter(button => button.classList.contains('hn-resolve')).length, 1);
  const status = state.root.querySelector<HTMLSelectElement>('.hn-status-filter')!;
  status.value = 'all'; status.dispatchEvent(new state.window.Event('change') as unknown as Event);
  state.card('first').querySelector<HTMLButtonElement>('.hn-resolve')!.click(); await state.settle();
  assert.equal(state.items[0]!.resolved, true);
  state.card('first').querySelector<HTMLButtonElement>('.hn-resolve')!.click(); await state.settle();
  assert.equal(state.items[0]!.resolved, false);
  state.plugin.canModify = false;
  state.card('first').querySelector<HTMLButtonElement>('.hn-resolve')!.click(); await state.settle();
  assert.equal(state.items[0]!.resolved, false, '阅读权限变化后，旧按钮也不得修改');
  assert.equal(state.errors.length, 1);
});

test('只读隐藏导航时移除空操作容器，全部文档展开仍可返回合并展示', async t => {
  const state = await sidebar([discussion('readonly', 1)], false, false, false, false);
  t.after(() => state.window.happyDOM.abort());
  assert.equal(state.card('readonly').querySelector('.hn-thread-tools'), null);
  assert.equal(state.card('readonly').querySelector('.hn-resolve'), null);
  state.plugin.settings.showCommentNavigation = true; state.view.render();
  assert.equal(state.card('readonly').querySelectorAll('[data-hn-navigation]').length, 2);
  assert.equal(state.card('readonly').querySelector('.hn-resolve'), null);
  state.plugin.settings.showCommentNavigation = false; state.view.render();
  assert.equal(state.card('readonly').querySelector('.hn-thread-tools'), null);
  state.view.viewScope = 'all'; state.view.render();
  assert.equal(state.card('readonly').querySelector('.hn-thread-tools'), null);
  state.card('readonly').querySelector<HTMLButtonElement>('.hn-summary-body')!.click();
  const tools = state.card('readonly').querySelector<HTMLElement>('.hn-thread-tools')!;
  assert.equal(tools.childElementCount, 1);
  assert.ok(tools.querySelector('.hn-overview-collapse'));
  assert.equal(tools.querySelector('[data-hn-navigation], .hn-resolve'), null);
  tools.querySelector<HTMLButtonElement>('.hn-overview-collapse')!.click();
  assert.ok(state.card('readonly').querySelector('.hn-summary-body'));
  assert.equal(state.card('readonly').querySelector('.hn-thread-tools'), null);
});

test('全部文档导航在展开卡片间切换，关闭导航保留解决与返回操作', async t => {
  const state = await sidebar([discussion('first', 1), discussion('last', 1, 10)], true, false, true);
  t.after(() => state.window.happyDOM.abort());
  state.card('first').querySelector<HTMLButtonElement>('.hn-summary-body')!.click();
  state.card('first').querySelector<HTMLButtonElement>('[data-hn-navigation="next"]')!.click();
  assert.equal(state.plugin.focused, 'last');
  assert.ok(state.card('last').querySelector('.hn-overview-collapse'));
  assert.equal(state.card('last').querySelector<HTMLButtonElement>('[data-hn-navigation="next"]')!.disabled, true);
  state.plugin.settings.showCommentNavigation = false; state.view.render();
  const tools = state.card('last').querySelector<HTMLElement>('.hn-thread-tools')!;
  assert.equal(tools.childElementCount, 2);
  assert.ok(tools.querySelector('.hn-resolve'));
  assert.ok(tools.querySelector('.hn-overview-collapse'));
  assert.equal(tools.querySelector('[data-hn-navigation]'), null);
});

test('移动端隐藏导航减少操作，保留解决按钮44像素触控和紧凑样式', async t => {
  const state = await sidebar([discussion('mobile', 1)], false, true);
  t.after(() => state.window.happyDOM.abort());
  const style = state.window.document.createElement('style');
  style.textContent = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  state.window.document.head.append(style);
  const button = state.card('mobile').querySelector<HTMLButtonElement>('.hn-resolve')!;
  const tools = button.parentElement!;
  const computed = state.window.getComputedStyle(button as never);
  assert.equal(computed.width, '44px'); assert.equal(computed.height, '44px');
  assert.equal(tools.childElementCount, 1);
  assert.equal(state.window.getComputedStyle(tools as never).minHeight, '44px');
  assert.equal(state.root.querySelector('[data-hn-navigation]'), null);
  // CSS declaration/cascade checks only; happy-dom has no real layout geometry.
  const rules = [...style.sheet!.cssRules].filter(rule => rule.type === state.window.CSSRule.STYLE_RULE) as unknown as CSSStyleRule[];
  const rule = (selector: string) => {
    const found = rules.find(item => item.selectorText === selector);
    assert.ok(found, `缺少布局覆盖规则 ${selector}`); return found;
  };
  const mobileHeader = rule('.hn-sidebar-mobile .hn-card-header-compact');
  const mobileQuote = rule('.hn-sidebar-mobile .hn-card-header-compact .hn-quote-block');
  assert.equal(mobileHeader.style.getPropertyValue('flex-wrap'), 'nowrap');
  assert.equal(mobileQuote.style.getPropertyValue('flex-basis'), 'auto');
  assert.ok(rules.indexOf(mobileHeader) > rules.indexOf(rule('.hn-sidebar-mobile .hn-card-header')));
  assert.ok(rules.indexOf(mobileQuote) > rules.indexOf(rule('.hn-sidebar-mobile .hn-card-header .hn-quote-block')));
  assert.equal(rule('.hn-thread-tools.hn-thread-tools-compact').style.getPropertyValue('padding'), '0px');
  assert.equal(rule('.hn-thread-tools.hn-thread-tools-compact').style.getPropertyValue('border'), '0px');
  assert.equal(rule('.hn-sidebar .hn-thread-tools-compact .hn-resolve').style.getPropertyValue('margin-left'), '0px');
});

test('mobile reply uses a modal, retains cancelled drafts and sends multiline text explicitly', async () => {
  const state = await sidebar([discussion('mobile', 1)], false, true);
  const open = async () => {
    state.card('mobile').querySelector<HTMLButtonElement>('.hn-mobile-reply')!.click();await state.settle();
    return state.modals.at(-1)!;
  };
  const first=await open(), textarea=first.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  textarea.value='第一行\n第二行';textarea.dispatchEvent(new state.window.Event('input') as unknown as Event);
  const enter=new state.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
  textarea.dispatchEvent(enter as unknown as Event);await state.settle();
  assert.equal(enter.defaultPrevented,false);assert.equal(state.items[0]?.messages.length,1);
  first.close();assert.equal(state.drafts.get('inline:mobile'),'第一行\n第二行');
  const next=await open();assert.equal(next.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value,'第一行\n第二行');
  next.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.click();await state.settle();
  assert.equal(state.items[0]?.messages.length,2);assert.equal(state.drafts.has('inline:mobile'),false);
  assert.equal(state.errors.length,0);await state.window.happyDOM.abort();
});

test('编辑回复展示所属讨论原文，取消与保存不混入引用且保留其他回复草稿', async t => {
  const thread = discussion('quote-edit', 2);
  thread.anchor.quote = '所属原文\n第二行🙂';
  thread.messages[1]!.body = '回复消息不是原文';
  const state = await sidebar([thread]);
  t.after(() => state.window.happyDOM.abort());
  state.draft(thread.id, '侧栏草稿');
  const open = async () => {
    state.card(thread.id).querySelectorAll<HTMLButtonElement>('.hn-message-more')[1]!.click();
    menus.current.items.find(item => item.title === '编辑')!.callback();
    await state.settle(); return state.modals.at(-1)!;
  };
  const cancelled = await open();
  assert.equal(cancelled.contentEl.querySelector('.hn-compose-quote')?.textContent, thread.anchor.quote);
  cancelled.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value = '取消的编辑';
  cancelled.close();
  assert.equal(state.items[0]!.messages[1]!.body, '回复消息不是原文');
  const editing = await open();
  assert.equal(editing.contentEl.querySelector('.hn-compose-quote')?.textContent, thread.anchor.quote);
  const field = editing.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  assert.equal(field.value, '回复消息不是原文');
  field.value = '修改后的回复\n保留第二行';
  editing.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.click(); await state.settle();
  assert.equal(state.items[0]!.messages[1]!.body, '修改后的回复\n保留第二行');
  assert.equal(state.items[0]!.anchor.quote, thread.anchor.quote);
  assert.equal(state.drafts.get('inline:quote-edit'), '侧栏草稿');
  assert.equal(state.input(thread.id).value, '侧栏草稿');
  assert.deepEqual(state.errors, []);
});

test('移动回复各自引用所属讨论原文，取消恢复草稿，保存失败后重试不混入原文', async t => {
  const first = discussion('quote-mobile-a', 2), second = discussion('quote-mobile-b', 1);
  first.anchor.quote = '第一处原文\n🙂'; second.anchor.quote = '第二处原文 <b>字面量</b>';
  const state = await sidebar([first, second], false, true);
  t.after(() => state.window.happyDOM.abort());
  const open = async (id: string) => {
    state.card(id).querySelector<HTMLButtonElement>('.hn-mobile-reply')!.click(); await state.settle();
    return state.modals.at(-1)!;
  };
  const cancelled = await open(first.id);
  assert.equal(cancelled.contentEl.querySelector('.hn-compose-quote')?.textContent, first.anchor.quote);
  const draft = cancelled.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  draft.value = '第一处回复草稿\n第二行'; draft.dispatchEvent(new state.window.Event('input') as unknown as Event);
  cancelled.close();
  const other = await open(second.id);
  assert.equal(other.contentEl.querySelector('.hn-compose-quote')?.textContent, second.anchor.quote);
  assert.equal(other.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value, ''); other.close();
  const reply = await open(first.id);
  assert.equal(reply.contentEl.querySelector('.hn-compose-quote')?.textContent, first.anchor.quote);
  assert.equal(reply.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value, '第一处回复草稿\n第二行');
  const originalUpdate = state.plugin.store.update.bind(state.plugin.store), error = new Error('模拟回复保存冲突');
  state.plugin.store.update = async () => {throw error;};
  reply.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.click(); await state.settle();
  assert.equal(state.errors[0], error); assert.equal(state.items[0]!.messages.length, 2);
  assert.equal(state.drafts.get('inline:quote-mobile-a'), '第一处回复草稿\n第二行');
  assert.equal(reply.contentEl.querySelector('.hn-compose-quote')?.textContent, first.anchor.quote);
  assert.equal(reply.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.disabled, false);
  state.plugin.store.update = originalUpdate;
  reply.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!.click(); await state.settle();
  assert.equal(state.items[0]!.messages.at(-1)!.body, '第一处回复草稿\n第二行');
  assert.equal(state.items[0]!.anchor.quote, first.anchor.quote); assert.equal(state.items[1]!.messages.length, 1);
  assert.equal(state.drafts.has('inline:quote-mobile-a'), false);
});


test('mobile menu survives layout-only refresh but closes on data or permission changes', async () => {
  const state=await sidebar([discussion('mobile-menu',1)],false,true);
  let button=state.card('mobile-menu').querySelector<HTMLButtonElement>('.hn-message-more')!;
  button.click();state.view.render();
  assert.equal(button.getAttribute('aria-expanded'),'true');assert.ok(button.isConnected);
  state.plugin.store.version++;state.view.render();assert.equal(button.getAttribute('aria-expanded'),'false');
  button=state.card('mobile-menu').querySelector<HTMLButtonElement>('.hn-message-more')!;button.click();
  state.plugin.canModify=false;state.view.render();assert.equal(button.getAttribute('aria-expanded'),'false');
  assert.equal(state.root.querySelector('.hn-mobile-reply'),null);await state.window.happyDOM.abort();
});

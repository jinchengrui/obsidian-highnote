import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {Window} from 'happy-dom';
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
  constructor(app) { this.app = app; this.contentEl = app.document.createElement('div'); }
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
const hooks = registerHooks({resolve(specifier, context, nextResolve) {
  return specifier === 'obsidian' ? {url: runtimeUrl, shortCircuit: true} : nextResolve(specifier, context);
}});
const {CommentsView} = await import('../src/ui');
const obsidian = await import('obsidian');
hooks.deregister();
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

async function sidebar(records: Thread[], all = false) {
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
    activePath: '笔记.md', canModify: true, focused: '', focusedHighlight: '', drafts,
    registerInteractionDocument() {}, requireReadingMode() {},
    report(error: unknown) { errors.push(error); },
    run(work: () => Promise<void>) { void work().catch(error => errors.push(error)); },
    focusThread(id: string) { this.focused = id; },
    clearFocus() { this.focused = ''; },
    openModal(modal: Modal) { modals.push(modal); modal.onOpen(); },
    store: {
      get(id: string) { const item = items.find(item => item.id === id); return item ? structuredClone(item) : undefined; },
      getHighlight() { return undefined; },
      viewAll() { return items; }, viewFile(path: string) { return items.filter(item => item.filePath === path); },
      viewHighlights() { return []; },
      async update(id: string, edit: (thread: Thread) => void) {
        const index = items.findIndex(item => item.id === id);
        if (index < 0) throw new Error('讨论已删除');
        const next = structuredClone(items[index]!);
        edit(next); next.revision++; items[index] = next;
        view.render();
      },
      async deleteMessage(id: string, messageId: string) {
        const index = items.findIndex(item => item.id === id);
        const next = structuredClone(items[index]!);
        const message = next.messages.find(message => message.id === messageId)!;
        message.deleted = true; message.body = ''; next.revision++;
        const removed = next.messages.every(message => message.deleted);
        if (removed) items.splice(index, 1); else items[index] = next;
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
  return {window, root, view, items, plugin, drafts, errors, modals, card, page, input, draft, settle};
}

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
  const state = await sidebar(records);
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

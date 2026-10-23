import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import type HighnotePlugin from '../src/main';
import type {AnnotationSettingsTab} from '../src/settings';
import type {CommentsView} from '../src/ui';
import type {Modal as ObsidianModal} from 'obsidian';

let builtBundle: ReturnType<typeof build> | undefined;
async function mobileEnvironment(t: TestContext, saved: unknown = {}) {
  const built = await (builtBundle ??= build({entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    supported: {'dynamic-import': false}, external: ['obsidian', 'electron', 'node:fs', '@codemirror/state', '@codemirror/view']}));
  const commands: string[] = [], views: string[] = [], icons: string[] = [], requested: string[] = [];
  const window = new Window();
  t.after(() => window.happyDOM.abort());
  const document = window.document;
  const prototype = window.HTMLElement.prototype as unknown as HTMLElement;
  prototype.createEl = function<K extends keyof HTMLElementTagNameMap>(this: HTMLElement, tag: K, options?: {cls?: string; text?: string; attr?: Record<string, string>}) {
    const element = this.ownerDocument.createElement(tag);
    if (options?.cls) element.className = options.cls;
    if (options?.text !== undefined) element.textContent = options.text;
    for (const [name, value] of Object.entries(options?.attr ?? {})) element.setAttribute(name, value);
    this.append(element); return element;
  } as HTMLElement['createEl'];
  prototype.createDiv = function(options) {return this.createEl('div', options);};
  prototype.addClass = function(...names) {this.classList.add(...names);};
  prototype.empty = function() {this.replaceChildren();};
  const modals: ObsidianModal[] = [];
  const data = new Map<string,string>();
  const saves: unknown[] = [];
  const queriedViews: string[] = [];
  const leaves = new Map<string, {view: unknown}[]>();
  let persist = async (_next: unknown) => {};
  let settingsTab: AnnotationSettingsTab;
  let commentFactory: (leaf: unknown) => CommentsView;
  let editorRegistered = false, readingRegistered = false;
  class Base {
    register() {} registerDomEvent() {} registerInterval() {}
  }
  class Modal extends Base {
    contentEl = document.createElement('div'); modalEl = this.contentEl;
    setTitle() {}
    onOpen() {} onClose() {}
    open() {document.body.append(this.contentEl); modals.push(this as unknown as ObsidianModal); this.onOpen();}
    close() {this.onClose(); this.contentEl.remove();}
  }
  class MarkdownView extends Base {
    file = {path:'笔记.md',extension:'md'};
    mode = 'preview';
    contentEl = document.createElement('div');
    getMode() {return this.mode;}
  }
  const note = new MarkdownView();
  let active: MarkdownView | null = note;
  let noteSource = '', noteAvailable = false, readNote = async () => noteSource;
  const adapter = {
    stat: async(path:string)=>data.has(path)?{type:'file',ctime:1,mtime:1,size:data.get(path)!.length}:{type:'folder'},
    exists: async(path:string)=>data.has(path)||!path.endsWith('.json')&&!path.endsWith('.tmp'),
    list: async()=>({files:[...data.keys()].filter(path=>path.endsWith('.json')),folders:[]}),
    read: async(path:string)=>{if(!data.has(path))throw new Error('missing');return data.get(path)!;},
    write: async(path:string,raw:string)=>{data.set(path,raw);},
    copy: async(from:string,to:string)=>{if(data.has(to))throw new Error('exists');data.set(to,data.get(from)!);},
    remove: async(path:string)=>{data.delete(path);},
    process: async(path:string,edit:(raw:string)=>string)=>{data.set(path,edit(data.get(path)!));}
  };
  class Plugin extends Base {
    app = {workspace: {containerEl: {ownerDocument: document}, on: () => ({}), onLayoutReady: () => {},
      getActiveViewOfType:(type:unknown)=>type===MarkdownView?active:null,getMostRecentLeaf:()=>({view:active}),
      getLeavesOfType:(type:string)=>{queriedViews.push(type);return leaves.get(type) ?? [{view:note}];}},
      vault: {adapter,configDir:'.obsidian',on: () => ({}),getFileByPath:(path: string)=>noteAvailable&&path===note.file.path?note.file:null,
        read: () => readNote()}};
    loadData() { return Promise.resolve(saved); }
    async saveData(next: unknown) { saves.push(structuredClone(next)); await persist(next); }
    addSettingTab(tab: AnnotationSettingsTab) { settingsTab = tab; }
    addChild<T>(child:T):T{return child;} removeChild() {} registerEvent() {}
    registerView(type: string, factory: (leaf: unknown) => CommentsView) { views.push(type); if(type === 'highnote-comments')commentFactory = factory; }
    addCommand(command: {id: string}) { commands.push(command.id); }
    addRibbonIcon(icon: string) { icons.push(icon); }
    registerEditorExtension() { editorRegistered = true; }
    registerMarkdownPostProcessor() { readingRegistered = true; }
  }
  const host = {Plugin, Component: Base, ItemView: Base, Modal, MarkdownRenderChild: Base, PluginSettingTab: Base,
    FileSystemAdapter: Base, MarkdownView, TFile: Base, TFolder: Base, WorkspaceLeaf: Base, Notice: Base, Platform: {isMobile: true, isDesktop: false}};
  const require = createRequire(import.meta.url), module = {exports: {} as {default: new () => HighnotePlugin}};
  vm.runInNewContext(built.outputFiles![0]!.text, {module, exports: module.exports, console,crypto,TextEncoder,structuredClone,
    window: {setInterval: () => 1,setTimeout:()=>1,clearTimeout:()=>{}},
    require: (name: string) => {
      requested.push(name);
      if (name === 'obsidian') return host;
      if (name === 'electron' || name === 'node:fs') throw new Error(`Unavailable on mobile: ${name}`);
      return require(name);
    }});
  const plugin = new module.exports.default();await plugin.onload();
  queriedViews.length = 0;
  return {plugin, window, note, data, commands, views, icons, requested, saves, queriedViews, leaves, modals,
    settingsTab: settingsTab!, commentFactory: commentFactory!,
    setPersistence(next: typeof persist) {persist = next;},
    setActive(next: typeof active) {active = next;},
    setNoteSource(next: string) {noteSource = next; noteAvailable = true;},
    setNoteRead(next: typeof readNote) {readNote = next;},
    registered() {return editorRegistered && readingRegistered;}};
}

test('mobile bundle loads annotation entry points without Node/Electron and only permits reading-mode edits', async t => {
  const {plugin, window, note, data, commands, views, icons, requested, setActive, registered} = await mobileEnvironment(t);
  assert.equal(plugin.canModify, true);assert.equal(plugin.dataFolder,'Highnote/annotations');
  const thread = await plugin.store.create('笔记.md','原句',0,2,'手机评论',()=>plugin.requireReadingMode());
  await plugin.store.reply(thread.id,'手机回复');
  await plugin.store.createHighlight('笔记.md','原句',0,2,()=>plugin.requireReadingMode());
  await plugin.store.load();assert.equal(plugin.store.viewHighlights().length,1);assert.equal(plugin.store.get(thread.id)?.messages.length,2);
  const before=[...data];await plugin.refreshMobileData(true);assert.deepEqual([...data],before,'missing source does not rewrite JSON');
  note.mode='source';assert.equal(plugin.canModify,false);
  await assert.rejects(plugin.store.create('笔记.md','原句',0,2,'禁止编辑模式新增',()=>plugin.requireReadingMode()),/阅读模式/u);
  setActive(null);assert.equal(plugin.canModify,false);
  await assert.rejects(plugin.migrateDataDirectory('.obsidian-highnote','Highnote/annotations'),/桌面端迁移/u);
  assert.deepEqual(views,['highnote-comments','highnote-review']);
  for(const id of ['open-comments','add-comment','add-highlight','open-review','refresh-review'])assert.ok(commands.includes(id));
  assert.deepEqual(icons,['messages-square','book-open']);assert.ok(registered());
  assert.ok(!requested.includes('electron')&&!requested.includes('node:fs'));
  await window.happyDOM.abort();
});

test('真实onload兼容旧设置与非法值，仅显式true启用评论导航', async t => {
  // 默认隐藏来自用户需求；严格布尔值兼容是本轮约定，独立覆盖缺字段、合法和非法值。
  for (const saved of [null, {}, {highlightColor: '#123abc'}, {showCommentNavigation: false},
    {showCommentNavigation: 'true'}, {showCommentNavigation: 1}, {showCommentNavigation: true}]) {
    const {plugin} = await mobileEnvironment(t, saved);
    assert.equal(plugin.settings.showCommentNavigation, saved !== null && 'showCommentNavigation' in saved && saved.showCommentNavigation === true);
    if (saved && 'highlightColor' in saved) assert.equal(plugin.settings.highlightColor, '#123abc');
  }
});

test('设置切换等待持久化完成后仅刷新评论视图，并可重载及关闭', async t => {
  const state = await mobileEnvironment(t, {highlightColor: '#123abc', exportFormat: 'html'});
  const {plugin} = state;
  const comments = state.commentFactory({});
  let renders = 0, foreignRenders = 0;
  comments.render = () => {renders++;};
  state.leaves.set('highnote-comments', [{view: comments}, {view: {render() {foreignRenders++;}}}]);
  let release!: () => void;
  state.setPersistence(() => new Promise<void>(resolve => {release = resolve;}));
  const changing = plugin.setCommentNavigation(true);
  assert.equal(plugin.settings.showCommentNavigation, false);
  assert.equal(renders, 0); assert.equal(state.queriedViews.length, 0);
  assert.equal((state.saves[0] as {showCommentNavigation: boolean}).showCommentNavigation, true);
  release(); await changing;
  assert.equal(plugin.settings.showCommentNavigation, true); assert.equal(renders, 1);
  assert.equal(foreignRenders, 0); assert.deepEqual(state.queriedViews, ['highnote-comments']);
  const loaded = await mobileEnvironment(t, state.saves[0]);
  assert.equal(loaded.plugin.settings.showCommentNavigation, true);
  assert.equal(loaded.plugin.settings.highlightColor, '#123abc');
  assert.equal(loaded.plugin.settings.exportFormat, 'html');
  state.setPersistence(async () => {});
  await plugin.setCommentNavigation(false);
  assert.equal(plugin.settings.showCommentNavigation, false); assert.equal(renders, 2);
  assert.equal((state.saves[1] as {showCommentNavigation: boolean}).showCommentNavigation, false);
  assert.equal((await mobileEnvironment(t, state.saves[1])).plugin.settings.showCommentNavigation, false);
});

test('设置页保存失败恢复开关和原设置并报告，成功后可再次切换', async t => {
  for (const original of [false, true]) {
    const state = await mobileEnvironment(t, {showCommentNavigation: original});
    const error = new Error('保存失败');
    const reported: unknown[] = [];
    state.plugin.report = value => {reported.push(value);};
    state.setPersistence(async () => {throw error;});
    let value: boolean | undefined, disabled = false;
    let change!: (value: boolean) => Promise<void>;
    const toggle = {
      setValue(next: boolean) {value = next; return this;},
      setDisabled(next: boolean) {disabled = next; return this;},
      onChange(callback: typeof change) {change = callback; return this;}
    };
    const definition = state.settingsTab.getSettingDefinitions().find(item => 'name' in item && item.name === '显示评论导航按钮');
    assert.ok(definition && 'render' in definition && definition.render, '导航设置应向用户提供开关');
    type Toggle = typeof toggle;
    definition.render({addToggle(build: (component: Toggle) => void) {build(toggle);}} as never, {} as never);
    assert.equal(value, original);
    value = !original;
    const saving = change(!original);
    assert.equal(disabled, true);
    await saving;
    assert.equal(value, original); assert.equal(disabled, false);
    assert.equal(state.plugin.settings.showCommentNavigation, original);
    assert.equal(state.queriedViews.length, 0); assert.equal(reported[0], error); assert.equal(reported.length, 1);
    state.setPersistence(async () => {});
    value = !original; await change(!original);
    assert.equal(state.plugin.settings.showCommentNavigation, !original);
    assert.equal(value, !original); assert.equal(disabled, false);
  }
});

test('目录切换未完成时禁止写入评论导航设置', async t => {
  const {plugin, saves, queriedViews} = await mobileEnvironment(t);
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  const idleReached = new Promise<void>(resolve => {entered = resolve;});
  const originalIdle = plugin.store.idle.bind(plugin.store);
  plugin.store.idle = async () => {entered(); await pending; await originalIdle();};
  const switching = plugin.setDataDirectory('其他/annotations');
  await idleReached;
  await assert.rejects(plugin.setCommentNavigation(true), /目录正在变更/u);
  assert.equal(plugin.settings.showCommentNavigation, false);
  assert.equal(saves.length, 0); assert.equal(queriedViews.length, 0);
  release();
  await switching;
});

test('真实compose按选区范围引用原文，切换选区与取消重开各自恢复评论草稿', async t => {
  const state = await mobileEnvironment(t);
  const source = '前缀🙂第一处原文\n保留换行；中间；第二处 <b>原文</b>🦑；后缀';
  state.setNoteSource(source);
  const firstQuote = '第一处原文\n保留换行', secondQuote = '第二处 <b>原文</b>🦑';
  const selection = (quote: string) => {
    const from = source.indexOf(quote);
    return {filePath: state.note.file.path, source, from, to: from + quote.length};
  };
  const firstSelection = selection(firstQuote), secondSelection = selection(secondQuote);
  state.plugin.compose(firstSelection);
  const first = state.modals.at(-1)!;
  assert.equal(first.contentEl.querySelector('.hn-compose-quote')?.textContent, firstQuote);
  const firstField = first.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  assert.equal(firstField.value, ''); firstField.value = '第一处评论草稿';
  firstField.dispatchEvent(new state.window.Event('input') as unknown as Event);
  state.plugin.compose(secondSelection);
  const second = state.modals.at(-1)!;
  assert.equal(second.contentEl.querySelector('.hn-compose-quote')?.textContent, secondQuote);
  assert.equal(second.contentEl.querySelector('.hn-compose-quote')!.childElementCount, 0);
  assert.equal(second.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value, '');
  assert.equal(first.contentEl.querySelector('.hn-compose-quote')?.textContent, firstQuote, '新选区不改写已打开弹窗');
  first.close(); second.close();
  state.plugin.compose(firstSelection);
  const reopened = state.modals.at(-1)!;
  assert.equal(reopened.contentEl.querySelector('.hn-compose-quote')?.textContent, firstQuote);
  assert.equal(reopened.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value, '第一处评论草稿');
  assert.equal(reopened.contentEl.querySelectorAll('.hn-compose-reference').length, 1);
  assert.equal(state.plugin.drafts.has(`new:${secondSelection.filePath}:${secondSelection.from}:${secondSelection.to}`), false);
  reopened.close(); assert.equal(state.plugin.openModals.size, 0);
});

test('真实compose等待保存期间保持选区原文，保存失败保留草稿，重试只存评论与正确锚点', async t => {
  const state = await mobileEnvironment(t);
  const source = '不引用前缀🙂【原文\n第二行🦑】不引用后缀', quote = '原文\n第二行🦑';
  state.setNoteSource(source);
  const from = source.indexOf(quote), to = from + quote.length;
  const reported: unknown[] = [];
  state.plugin.report = error => {reported.push(error);};
  state.plugin.showThread = async () => {};
  const failure = new Error('模拟原文读取失败');
  let rejectRead!: (error: Error) => void;
  state.setNoteRead(() => new Promise<string>((_resolve, reject) => {rejectRead = reject;}));
  state.plugin.compose({filePath: state.note.file.path, source, from, to});
  const modal = state.modals.at(-1)!, field = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!;
  const submit = modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!;
  field.value = '只有评论\n评论第二行'; field.dispatchEvent(new state.window.Event('input') as unknown as Event);
  submit.click(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(field.disabled, true); assert.equal(submit.disabled, true);
  assert.equal(modal.contentEl.querySelector('.hn-compose-quote')?.textContent, quote);
  assert.equal(state.plugin.store.viewAll().length, 0);
  rejectRead(failure); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reported[0], failure); assert.equal(field.value, '只有评论\n评论第二行');
  const key = `new:${state.note.file.path}:${from}:${to}`;
  assert.equal(state.plugin.drafts.get(key), '只有评论\n评论第二行');
  assert.equal(modal.contentEl.querySelector('.hn-compose-quote')?.textContent, quote);
  assert.equal(field.disabled, false); assert.equal(submit.disabled, false);
  state.setNoteRead(async () => source);
  const originalClose = modal.onClose.bind(modal);
  const closed = new Promise<void>(resolve => {modal.onClose = () => {originalClose(); resolve();};});
  submit.click(); await closed;
  const threads = state.plugin.store.viewAll(); assert.equal(threads.length, 1);
  assert.equal(threads[0]!.anchor.quote, quote); assert.equal(threads[0]!.anchor.from, from); assert.equal(threads[0]!.anchor.to, to);
  assert.equal(threads[0]!.messages[0]!.body, '只有评论\n评论第二行');
  assert.equal(state.plugin.drafts.has(key), false); assert.equal(state.plugin.openModals.size, 0);
});

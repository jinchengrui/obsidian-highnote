import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import type HighnotePlugin from '../src/main';

test('mobile bundle loads annotation entry points without Node/Electron and only permits reading-mode edits', async () => {
  const built = await build({entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    supported: {'dynamic-import': false}, external: ['obsidian', 'electron', 'node:fs', '@codemirror/state', '@codemirror/view']});
  const commands: string[] = [], views: string[] = [], icons: string[] = [], requested: string[] = [];
  const window = new Window();
  const document = window.document;
  const data = new Map<string,string>();
  let editorRegistered = false, readingRegistered = false;
  class Base {
    register() {} registerDomEvent() {} registerInterval() {}
  }
  class MarkdownView extends Base {
    file = {path:'笔记.md',extension:'md'};
    mode = 'preview';
    contentEl = document.createElement('div');
    getMode() {return this.mode;}
  }
  const note = new MarkdownView();
  let active: MarkdownView | null = note;
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
      getActiveViewOfType:(type:unknown)=>type===MarkdownView?active:null,getMostRecentLeaf:()=>({view:active}),getLeavesOfType:()=>[{view:note}]},
      vault: {adapter,configDir:'.obsidian',on: () => ({}),getFileByPath:()=>null}};
    loadData() { return Promise.resolve({}); }
    addSettingTab() {} addChild<T>(child:T):T{return child;} removeChild() {} registerEvent() {}
    registerView(type: string) { views.push(type); }
    addCommand(command: {id: string}) { commands.push(command.id); }
    addRibbonIcon(icon: string) { icons.push(icon); }
    registerEditorExtension() { editorRegistered = true; }
    registerMarkdownPostProcessor() { readingRegistered = true; }
  }
  const host = {Plugin, Component: Base, ItemView: Base, Modal: Base, MarkdownRenderChild: Base, PluginSettingTab: Base,
    FileSystemAdapter: Base, MarkdownView, TFile: Base, TFolder: Base, WorkspaceLeaf: Base, Platform: {isMobile: true, isDesktop: false}};
  const require = createRequire(import.meta.url), module = {exports: {} as {default: new () => HighnotePlugin}};
  vm.runInNewContext(built.outputFiles[0]!.text, {module, exports: module.exports, console,crypto,TextEncoder,structuredClone,
    window: {setInterval: () => 1,setTimeout:()=>1,clearTimeout:()=>{}},
    require: (name: string) => {
      requested.push(name);
      if (name === 'obsidian') return host;
      if (name === 'electron' || name === 'node:fs') throw new Error(`Unavailable on mobile: ${name}`);
      return require(name);
    }});
  const plugin = new module.exports.default();await plugin.onload();
  assert.equal(plugin.canModify, true);assert.equal(plugin.dataFolder,'Highnote/annotations');
  const thread = await plugin.store.create('笔记.md','原句',0,2,'手机评论',()=>plugin.requireReadingMode());
  await plugin.store.reply(thread.id,'手机回复');
  await plugin.store.createHighlight('笔记.md','原句',0,2,()=>plugin.requireReadingMode());
  await plugin.store.load();assert.equal(plugin.store.viewHighlights().length,1);assert.equal(plugin.store.get(thread.id)?.messages.length,2);
  const before=[...data];await plugin.refreshMobileData(true);assert.deepEqual([...data],before,'missing source does not rewrite JSON');
  note.mode='source';assert.equal(plugin.canModify,false);
  await assert.rejects(plugin.store.create('笔记.md','原句',0,2,'禁止编辑模式新增',()=>plugin.requireReadingMode()),/阅读模式/u);
  active=null;assert.equal(plugin.canModify,false);
  await assert.rejects(plugin.migrateDataDirectory('.obsidian-highnote','Highnote/annotations'),/桌面端迁移/u);
  assert.deepEqual(views,['highnote-comments','highnote-review']);
  for(const id of ['open-comments','add-comment','add-highlight','open-review','refresh-review'])assert.ok(commands.includes(id));
  assert.deepEqual(icons,['messages-square','book-open']);assert.ok(editorRegistered&&readingRegistered);
  assert.ok(!requested.includes('electron')&&!requested.includes('node:fs'));
  await window.happyDOM.abort();
});

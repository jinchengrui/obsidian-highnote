import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {build} from 'esbuild';

// Evaluate the real plugin bundle in a host that rejects desktop-only APIs.
// Desktop emulation alone would still provide these modules and hide a crash.
test('mobile plugin loads without Node/Electron APIs and registers review-only entry points', async () => {
  const built = await build({entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    supported: {'dynamic-import': false},
    external: ['obsidian', 'electron', 'node:fs', '@codemirror/state', '@codemirror/view']});
  const commands: string[] = [], views: string[] = [], icons: string[] = [], requested: string[] = [];
  class Base {}
  class Plugin extends Base {
    app = {workspace: {containerEl: {ownerDocument: {hidden: false, defaultView: {}}}, on: () => ({}), onLayoutReady: () => {}}, vault: {adapter: {}, on: () => ({})}};
    loadData() { return Promise.resolve({}); }
    addSettingTab() {}
    registerEvent() {}
    registerDomEvent() {}
    registerInterval() {}
    register() {}
    registerView(type: string) { views.push(type); }
    addCommand(command: {id: string}) { commands.push(command.id); }
    addRibbonIcon(icon: string) { icons.push(icon); }
    registerEditorExtension() { throw new Error('mobile editor mutation extension registered'); }
    registerMarkdownPostProcessor() { throw new Error('mobile selection/annotation renderer registered'); }
  }
  const host = {Plugin, Component: Base, ItemView: Base, Modal: Base, MarkdownRenderChild: Base, PluginSettingTab: Base,
    FileSystemAdapter: Base, MarkdownView: Base, TFile: Base, TFolder: Base, WorkspaceLeaf: Base, Platform: {isMobile: true, isDesktop: false}};
  const require = createRequire(import.meta.url), module = {exports: {} as {default: new () => Plugin & {onload(): Promise<void>; canModify: boolean; dataFolder: string; migrateDataDirectory(source: string, target: string): Promise<unknown>}}};
  vm.runInNewContext(built.outputFiles[0]!.text, {module, exports: module.exports, console,
    window: {setInterval: () => 1},
    require: (name: string) => {
      requested.push(name);
      if (name === 'obsidian') return host;
      if (name === 'electron' || name === 'node:fs') throw new Error(`Unavailable on mobile: ${name}`);
      return require(name);
    }});
  const plugin = new module.exports.default();
  await plugin.onload();
  assert.equal(plugin.canModify, false);
  assert.equal(plugin.dataFolder, 'Highnote/annotations');
  await assert.rejects(plugin.migrateDataDirectory('.obsidian-highnote', 'Highnote/annotations'), /桌面端迁移/u);
  assert.deepEqual(views, ['highnote-review']);
  assert.deepEqual(commands, ['open-review', 'refresh-review']);
  assert.deepEqual(icons, ['book-open']);
  assert.ok(!requested.includes('electron') && !requested.includes('node:fs'));
});

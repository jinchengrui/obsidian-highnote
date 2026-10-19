import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli, vault, screenshots] = process.argv.slice(2);
if (!cli || !vault) throw new Error('需要 Obsidian CLI 和测试库名称');
const evaluate = code => {
  const raw = execFileSync(cli, [`vault=${vault}`, 'eval', `code=(async()=>JSON.stringify(await (${code})))()`], {encoding: 'utf8', timeout: 20000});
  const line = raw.split('\n').find(l => l.startsWith('=> '));
  if (!line) throw new Error(raw);
  return JSON.parse(line.slice(3));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 60; i++) { if (evaluate(code)) return; await pause(100); }
  throw new Error(`等待超时：${code}`);
}
const plugin = `app.plugins.plugins['highnote']`;
const settings = `app.setting.pluginTabs.find(t=>t.id==='highnote').containerEl`;
const modal = `[...${plugin}.openModals].find(m=>m.contentEl.classList.contains('hn-custom-color-modal'))`;
const root = `${modal}.contentEl`;
const hex = `${root}.querySelector('[aria-label="自定义颜色值"]')`;
const color = () => evaluate(`${hex}.value`);
const set = (selector, value) => evaluate(`(()=>{const input=${root}.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
const open = async () => {
  evaluate(`(()=>{${settings}.querySelector('.hn-color-custom').click();return true})()`);
  await until(`!!${modal}`);
};
const cancel = () => evaluate(`(()=>{[...${root}.querySelectorAll('button')].find(b=>b.textContent==='取消').click();return true})()`);
const screenshot = async name => {
  if (!screenshots) return;
  evaluate(`(()=>{const win=require('electron').remote.BrowserWindow.getAllWindows().find(w=>w.getTitle().startsWith('Settings'))??require('electron').remote.getCurrentWindow();win.webContents.sendInputEvent({type:'mouseMove',x:10,y:10});return true})()`);
  await pause(350);
  const data = evaluate(`(async()=>{const win=require('electron').remote.BrowserWindow.getAllWindows().find(w=>w.getTitle().startsWith('Settings'))??require('electron').remote.getCurrentWindow();return (await win.capturePage()).toPNG().toString('base64')})()`);
  mkdirSync(screenshots, {recursive: true}); writeFileSync(path.join(screenshots, name), Buffer.from(data, 'base64'));
};
evaluate(`(()=>{app.setting.open();app.setting.openTabById('highnote');return true})()`);
await until(`!!${settings}.querySelector('.hn-color-custom')`);
const original = evaluate(`${plugin}.settings.highlightColor`);
const theme = evaluate(`${settings}.doc.body.classList.contains('theme-dark')`);
await open();
assert.equal(color(), original);
const metrics = evaluate(`(()=>{const m=${modal},r=m.modalEl.getBoundingClientRect(),p=m.contentEl.querySelector('.hn-color-plane').getBoundingClientRect(),s=${settings}.querySelector('.hn-color-swatch').getBoundingClientRect();return {width:r.width,height:r.height,panel:p.height,swatch:s.height,overflow:m.contentEl.scrollWidth>m.contentEl.clientWidth+1}})()`);
assert.equal(metrics.width,320); assert.ok(metrics.height<370); assert.equal(metrics.panel,152); assert.equal(metrics.swatch,26); assert.equal(metrics.overflow,false);
set('[aria-label="自定义颜色值"]', '#ff6600');
assert.deepEqual(evaluate(`[...${root}.querySelectorAll('input[type="number"]')].map(i=>i.value)`), ['255','102','0']);
assert.equal(evaluate(`${plugin}.settings.highlightColor`), original);
set('[aria-label="G 颜色值"]', '128'); assert.equal(color(), '#ff8000');
set('[aria-label="G 颜色值"]', '256'); assert.equal(evaluate(`${root}.querySelector('.mod-cta').disabled`), true);
set('[aria-label="G 颜色值"]', '1.5'); assert.equal(evaluate(`${root}.querySelector('.mod-cta').disabled`), true);
set('[aria-label="G 颜色值"]', ''); assert.equal(evaluate(`${root}.querySelector('.mod-cta').disabled`), true);
set('[aria-label="G 颜色值"]', '102'); assert.equal(color(), '#ff6600');
set('[aria-label="自定义颜色值"]', 'invalid'); assert.equal(evaluate(`${root}.querySelector('.mod-cta').disabled`), true);
set('[aria-label="色相"]', '120'); assert.equal(color(), '#00ff00');
// Native Electron mouse input exercises pointer capture and dragging beyond the panel.
const native = (type, x, y) => evaluate(`(()=>{const win=require('electron').remote.BrowserWindow.getAllWindows().find(w=>w.getTitle().startsWith('Settings'))??require('electron').remote.getCurrentWindow();win.focus();win.webContents.sendInputEvent({type:${JSON.stringify(type)},x:${Math.round(x)},y:${Math.round(y)},button:'left',modifiers:${JSON.stringify(type === 'mouseMove' ? ['leftButtonDown'] : [])},clickCount:1});return true})()`);
const rect = evaluate(`(()=>{const r=${root}.querySelector('.hn-color-plane').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
native('mouseDown',rect.x+rect.width*.5,rect.y+rect.height*.5);
await pause(70);
native('mouseMove',rect.x+rect.width*.75,rect.y+rect.height*.25);
await pause(70);
const dragged = evaluate(`${hex}.value`); assert.match(dragged, /^#[0-9a-f]{6}$/); assert.notEqual(dragged,'#00ff00');
native('mouseMove',rect.x+rect.width*.75,rect.y+rect.height+14); await pause(70);
assert.equal(color(),'#000000'); native('mouseUp',rect.x+rect.width*.75,rect.y+rect.height+14);
// Gray/black should retain hue so returning to a vivid color follows the chosen hue.
evaluate(`(()=>{const p=${root}.querySelector('.hn-color-plane');p.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true,bubbles:true}));return true})()`);
assert.notEqual(color(),'#000000');
set('[aria-label="自定义颜色值"]', '#808080');
evaluate(`(()=>{const p=${root}.querySelector('.hn-color-plane');p.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));return true})()`);
assert.equal(color(),'#738073');
set('[aria-label="自定义颜色值"]','#ff6600');
evaluate(`(()=>{const doc=${root}.doc;doc.body.removeClass('theme-dark');doc.body.addClass('theme-light');return true})()`);
await screenshot('紧凑可视化选色器.png');
evaluate(`(()=>{const doc=${root}.doc;doc.body.removeClass('theme-light');doc.body.addClass('theme-dark');return true})()`);
await screenshot('可视化选色器深色.png');
// A 280px host still contains all picker inputs and buttons.
evaluate(`(()=>{${modal}.modalEl.style.width='248px';return true})()`);
assert.equal(evaluate(`(()=>{const r=${root};return r.scrollWidth>r.clientWidth+1})()`),false);
await screenshot('可视化选色器窄宽度.png');
cancel(); assert.equal(evaluate(`${plugin}.settings.highlightColor`), original);
evaluate(`(()=>{const body=${settings}.doc.body;body.toggleClass('theme-dark',${theme});body.toggleClass('theme-light',${!theme});return true})()`);
await open(); set('[aria-label="自定义颜色值"]', '#123abc');
// Delay only the test modal's save callback to exercise the pending state.
evaluate(`(()=>{const m=${modal},save=m.save;m.testCount=0;m.save=async value=>{m.testCount++;await new Promise(resolve=>m.testRelease=resolve);await save(value)};${root}.querySelector('.mod-cta').click();${root}.querySelector('.mod-cta').click();return true})()`);
assert.equal(evaluate(`${modal}.testCount`),1);
assert.ok(evaluate(`[...${root}.querySelectorAll('input,button')].every(i=>i.disabled)`));
evaluate(`(()=>{${modal}.testRelease();return true})()`);
await until(`!${modal} && ${plugin}.settings.highlightColor==='#123abc'`);
assert.equal(evaluate(`(async()=>JSON.parse(await app.vault.adapter.read('.obsidian/plugins/highnote/data.json')).highlightColor)()`),'#123abc');
assert.ok(evaluate(`${settings}.querySelector('.hn-color-custom').textContent.includes('#123abc')`));
evaluate(`(()=>{app.setting.close();return true})()`);
evaluate(`(async()=>{await app.plugins.disablePlugin('highnote');await app.plugins.enablePlugin('highnote');return true})()`);
assert.equal(evaluate(`${plugin}.settings.highlightColor`),'#123abc');
evaluate(`(()=>{app.setting.open();app.setting.openTabById('highnote');return true})()`);
await until(`!!${settings}.querySelector('.hn-color-custom')`);
evaluate(`(()=>{[...${settings}.querySelectorAll('.hn-color-actions button')].find(b=>b.textContent==='恢复默认').click();return true})()`);
await until(`${plugin}.settings.highlightColor==='#ffe083'`);
await screenshot('紧凑标记颜色设置.png');
evaluate(`(async()=>{await ${plugin}.setHighlightColor(${JSON.stringify(original)});app.setting.close();return true})()`);
console.log('PASS: compact dimensions, RGB/HEX/HSV sync, invalid input, native captured dragging, gray hue retention, keyboard selection, cancel, one pending save, persisted reload, reset, light/dark/narrow layouts.');

import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli,vault,screenshots] = process.argv.slice(2);
if(!cli||!vault) throw new Error('用法：node scripts/verify-navigation-client.mjs /path/to/obsidian-cli test-vault-name [screenshots-directory]');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:20000}).trim();
const evaluate=code=>{const raw=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=raw.split('\n').find(l=>l.startsWith('=> '));if(!line)throw new Error(raw);return JSON.parse(line.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<60;i++){if(evaluate(code))return;await pause(100);}throw new Error(`等待超时：${code}`);}
const stamp=`定位验收${Date.now()}`;
const aPath=`${stamp}/甲.md`,bPath=`${stamp}/乙.md`;
const ids=evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];await app.vault.createFolder('${stamp}');const f=await app.vault.create('${aPath}','# 当前文档'+String.fromCharCode(10,10)+'留在这里的起始正文。');const source='# 跨文档定位'+String.fromCharCode(10,10)+Array.from({length:120},(_,i)=>'段落 '+i+'，用于验证长文档的阅读定位。').join(String.fromCharCode(10,10))+String.fromCharCode(10,10)+'目标段落中有重复摘录，重复摘录出现在第二处。'+String.fromCharCode(10,10)+'已解决讨论仍可定位到这里。';const target=await app.vault.create('${bPath}',source);const repeated=source.lastIndexOf('重复摘录');const h=await p.store.createHighlight(target.path,source,repeated,repeated+4);const r=source.indexOf('已解决讨论');const c=await p.store.create(target.path,source,r,r+9,'已解决的评论正文');await p.store.update(c.id,t=>{t.resolved=true});const d=await p.store.createHighlight(target.path,source,source.indexOf('目标段落'),source.indexOf('目标段落')+4);await p.store.updateHighlights(target.path,items=>{items.find(i=>i.id===d.id).anchor.state='detached'});const l=app.workspace.getLeaf('tab');await l.openFile(f);await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(l);await p.openSidebar();const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.switchPane('highlights');v.viewScope='all';v.paneState.highlights.status='all';v.paneState.highlights.query='${stamp}';v.render();return {h:h.id,c:c.id,d:d.id};})()`);
await until(`!!document.querySelector('[data-highlight-id="${ids.h}"]')`);
assert.equal(evaluate(`document.querySelectorAll('.hn-controls,.hn-export').length`),0);
assert.equal(evaluate(`!!document.querySelector('[data-highlight-id="${ids.h}"] .hn-highlight-status')`),false);
evaluate(`(()=>{document.getSelection().removeAllRanges();document.querySelector('[data-highlight-id="${ids.h}"]').click();return true})()`);
await until(`app.workspace.getMostRecentLeaf().view.file?.path==='${bPath}' && app.workspace.getMostRecentLeaf().view.getMode()==='preview' && !!document.querySelector('[data-hn-highlight="${ids.h}"]')`);
const located=evaluate(`(()=>{const l=app.workspace.getMostRecentLeaf();const h=l.view.contentEl.querySelector('[data-hn-highlight="${ids.h}"]');const r=h.getBoundingClientRect();const p=l.view.contentEl.querySelector('.markdown-preview-view').getBoundingClientRect();return {text:h.textContent,visible:r.top>=p.top&&r.bottom<=p.bottom,scroll:l.view.previewMode.getScroll(),paragraph:h.closest('p').textContent,preceding:(()=>{const range=document.createRange();range.setStart(h.closest('p'),0);range.setEndBefore(h);return range.toString()})()}})()`);
assert.equal(located.text,'重复摘录');assert.equal(located.visible,true);assert.ok(located.scroll>100);assert.ok(located.preceding.includes('重复摘录，'));
// A completed discussion has no persistent underline, but source scrolling must still locate it.
evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];await p.locate('${ids.c}');return true})()`);
assert.equal(evaluate(`app.workspace.getMostRecentLeaf().view.getMode()`),'preview');
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${ids.c}').anchor.state`),'attached');
assert.ok(evaluate(`app.workspace.getMostRecentLeaf().view.previewMode.getScroll()`)>100);
assert.equal(evaluate(`document.querySelectorAll('[data-hn-thread="${ids.c}"]').length`),0);
// A detached record preserves the current file and never silently rebinds the old excerpt.
evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];const l=app.workspace.getMostRecentLeaf();await l.openFile(app.vault.getFileByPath('${aPath}'));await p.locateHighlight('${ids.d}');return true})()`);
assert.equal(evaluate(`app.workspace.getMostRecentLeaf().view.file.path`),aPath);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.getHighlight('${ids.d}').anchor.state`),'detached');
// Drag-selecting a card should allow copying without opening another document.
evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];const l=app.workspace.getMostRecentLeaf();await l.openFile(app.vault.getFileByPath('${aPath}'));p.activePath='${aPath}';const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.switchPane('highlights');v.render();const card=document.querySelector('[data-highlight-id="${ids.h}"]');const r=document.createRange();r.selectNodeContents(card.querySelector('.hn-highlight-quote'));document.getSelection().removeAllRanges();document.getSelection().addRange(r);card.click();return true})()`);
await pause(100);assert.equal(evaluate(`app.workspace.getMostRecentLeaf().view.file.path`),aPath);
evaluate(`(()=>{document.getSelection().removeAllRanges();return true})()`);
// The menu remains available in source mode; export entries are disabled and reload is available.
evaluate(`(async()=>{const l=app.workspace.getMostRecentLeaf();await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'source'},active:true});return true})()`);
await until(`!app.plugins.plugins['highnote'].canModify && !!document.querySelector('.hn-sidebar.is-readonly')`);
evaluate(`(()=>{document.querySelector('.hn-sidebar-more').click();return true})()`);
const menu=evaluate(`[...document.querySelectorAll('.menu-item')].map(e=>({text:e.textContent.trim(),disabled:e.classList.contains('is-disabled')}))`);
assert.ok(menu.filter(i=>i.text.includes('导出')).every(i=>i.disabled));assert.deepEqual(menu.find(i=>i.text==='重新加载数据'),{text:'重新加载数据',disabled:false});
evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
// Settings expose two rows of opaque presets, validated custom values and one reset action.
evaluate(`(()=>{app.setting.open();app.setting.openTabById('highnote');return true})()`);await pause(150);
const settings=`app.setting.pluginTabs.find(t=>t.id==='highnote').containerEl`;
assert.equal(evaluate(`${settings}.querySelectorAll('.hn-color-swatch').length`),14);
assert.equal(evaluate(`${settings}.querySelectorAll('input[type="color"]').length`),0);
evaluate(`(()=>{${settings}.querySelector('[data-color="#c4efc4"]').click();return true})()`);
await until(`app.plugins.plugins['highnote'].settings.highlightColor==='#c4efc4'`);
await until(`${settings}.querySelector('[data-color="#c4efc4"]').getAttribute('aria-pressed')==='true'`);
evaluate(`(()=>{${settings}.querySelector('.hn-color-custom').click();return true})()`);
await until(`!![...app.plugins.plugins['highnote'].openModals].find(m=>m.contentEl.querySelector('[aria-label="自定义颜色值"]'))?.contentEl.querySelector('[aria-label="自定义颜色值"]')`);
evaluate(`(()=>{const f=[...app.plugins.plugins['highnote'].openModals].find(m=>m.contentEl.querySelector('[aria-label="自定义颜色值"]'))?.contentEl.querySelector('[aria-label="自定义颜色值"]');f.value='invalid';f.dispatchEvent(new Event('input'));return true})()`);
assert.equal(evaluate(`[...app.plugins.plugins['highnote'].openModals].find(m=>m.contentEl.classList.contains('hn-custom-color-modal')).contentEl.querySelector('.mod-cta').disabled`),true);
evaluate(`(()=>{const f=[...app.plugins.plugins['highnote'].openModals].find(m=>m.contentEl.querySelector('[aria-label="自定义颜色值"]'))?.contentEl.querySelector('[aria-label="自定义颜色值"]');f.value='#123abc';f.dispatchEvent(new Event('input'));[...app.plugins.plugins['highnote'].openModals].find(m=>m.contentEl.classList.contains('hn-custom-color-modal')).contentEl.querySelector('.mod-cta').click();return true})()`);
await until(`app.plugins.plugins['highnote'].settings.highlightColor==='#123abc' && ![...app.plugins.plugins['highnote'].openModals].some(m=>m.contentEl.classList.contains('hn-custom-color-modal'))`);
await until(`${settings}.querySelector('.hn-color-custom').textContent.includes('#123abc')`);
evaluate(`(()=>{[...${settings}.querySelectorAll('.hn-color-actions button')].find(e=>e.textContent==='恢复默认').click();return true})()`);
await until(`app.plugins.plugins['highnote'].settings.highlightColor==='#ffe083'`);
if(screenshots){mkdirSync(screenshots,{recursive:true});const bytes=evaluate(`(async()=>{const win=require('electron').remote.BrowserWindow.getAllWindows().find(w=>w.getTitle().startsWith('Settings'))??require('electron').remote.getCurrentWindow();return (await win.capturePage()).toPNG().toString('base64')})()`);writeFileSync(path.join(screenshots,'标记预设选色板.png'),Buffer.from(bytes,'base64'));}
evaluate(`(()=>{app.setting.close();return true})()`);
// Restore reading mode and verify the compact header at a genuinely narrow sidebar width.
evaluate(`(async()=>{const l=app.workspace.getMostRecentLeaf();await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(l);return true})()`);
await until(`app.plugins.plugins['highnote'].canModify`);
const compact=evaluate(`(()=>{const root=document.querySelector('.hn-sidebar');root.style.width='280px';const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.paneState.highlights.query='';v.paneState.highlights.status='all';v.render();const h=root.querySelector('.hn-header').getBoundingClientRect();const t=root.querySelector('.hn-tabs').getBoundingClientRect();const s=root.querySelector('.hn-search').getBoundingClientRect();return {width:root.getBoundingClientRect().width,overflow:root.scrollWidth>root.clientWidth+2,headerToSearch:s.bottom-h.top,rows:h.bottom<=t.top&&t.bottom<=s.top,countHidden:root.querySelector('.hn-count').hidden}})()`);
assert.equal(compact.width,280);assert.equal(compact.overflow,false);assert.equal(compact.rows,true);assert.equal(compact.countHidden,true);assert.ok(compact.headerToSearch<110);
if(screenshots){const bytes=evaluate(`(async()=>{const win=require('electron').remote.BrowserWindow.getAllWindows().find(w=>!w.getTitle().startsWith('Settings'));return (await win.capturePage()).toPNG().toString('base64')})()`);writeFileSync(path.join(screenshots,'紧凑正文标注侧栏.png'),Buffer.from(bytes,'base64'));}
evaluate(`(()=>{document.querySelector('.hn-sidebar').style.width='';return true})()`);
console.log('PASS: cross-file card navigation, distant and repeated excerpts, resolved and detached records, copy without navigation, readonly menu, preset/custom/reset colors, 280px compact header.');

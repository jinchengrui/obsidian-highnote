import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [cli,vault,output='/tmp/highnote-mobile-annotations'] = process.argv.slice(2);
if(!cli||!vault)throw new Error('Usage: node scripts/verify-mobile-annotations-client.mjs obsidian-cli test-vault [output]');
mkdirSync(output,{recursive:true});
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:25000}).trim();
const ev=code=>{const out=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=out.split('\n').find(s=>s.startsWith('=> '));if(!line){if(out==='(no output)')return;throw new Error(out);}return JSON.parse(line.slice(3));};
const q=JSON.stringify,pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<60;i++){if(ev(code))return;await pause(100);}throw new Error(code);}
const root=`Highnote移动批注验收-${Date.now()}`,directory=root+'/annotations',note=root+'/阅读笔记.md',results={};
assert.equal(ev('app.plugins.plugins.highnote.isMobile'),true);
ev(`(()=>{const p=app.plugins.plugins.highnote;window.hnTouchCheck={layout:app.workspace.getLayout(),settings:structuredClone(p.settings),initial:p.dataFolder};return true})()`);
async function dimensions(width,height){call('dev:cdp','method=Emulation.setDeviceMetricsOverride',`params=${q({width,height,deviceScaleFactor:1,mobile:true})}`);await pause(250);}
async function reading(){ev(`(async()=>{const s=window.hnTouchCheck;app.workspace.rightSplit.collapse();await app.workspace.revealLeaf(s.leaf);await s.leaf.setViewState({type:'markdown',state:{...s.leaf.view.getState(),mode:'preview'},active:true});return true})()`);await until(`app.plugins.plugins.highnote.canModify && !!window.hnTouchCheck.leaf.view.contentEl.querySelector('.markdown-preview-view p')`);}
async function select(text='第一段用于手机添加评论。'){
 ev(`(()=>{const s=window.hnTouchCheck,root=s.leaf.view.contentEl;const p=[...root.querySelectorAll('.markdown-preview-view p')].find(p=>p.textContent===${q(text)});if(!p)throw new Error('找不到原文');p.scrollIntoView({block:'center'});const range=document.createRange();range.selectNodeContents(p);const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));return true})()`);
 await until(`!!document.querySelector('.hn-selection-touch')`);
}
try{
 ev(`(async()=>{const p=app.plugins.plugins.highnote;app.setting.close();for(const m of p.openModals)m.close();p.drafts.clear();await p.setDataDirectory(${q(directory)});await app.vault.createFolder(${q(root)});const file=await app.vault.create(${q(note)},'# 手机批注\\n\\n第一段用于手机添加评论。\\n\\n第二段用于手机标记。\\n\\n'+ '阅读正文。\\n\\n'.repeat(12));const leaf=app.workspace.getLeaf('tab');window.hnTouchCheck.leaf=leaf;await leaf.openFile(file);return true})()`);
 await dimensions(440,956);await reading();await select();
 const toolbar=ev(`(()=>{const r=document.querySelector('.hn-selection-touch').getBoundingClientRect();return {width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`);
 assert.equal(toolbar.width,208);assert.equal(toolbar.height,52);assert.ok(toolbar.right<=440&&toolbar.bottom<=956);results.phoneToolbar=toolbar;
 // Touch-start may collapse the native selection; the captured selection still submits exactly once.
 ev(`(()=>{const b=document.querySelector('.hn-selection-comment');b.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',bubbles:true,cancelable:true}));document.getSelection().removeAllRanges();b.dispatchEvent(new TouchEvent('touchend',{bubbles:true,cancelable:true,touches:[],changedTouches:[]}));return true})()`);
 await until(`!!document.querySelector('.hn-modal textarea')`);
 ev(`(()=>{const t=document.querySelector('.hn-modal textarea');t.value='手机评论全文。\\n**加粗**\\n- 条目';t.dispatchEvent(new Event('input'));document.querySelector('.hn-modal .mod-cta').click();return true})()`);
 await until(`app.plugins.plugins.highnote.store.viewFile(${q(note)}).length===1 && !document.querySelector('.hn-modal textarea')`);
 await until(`!!document.querySelector('.hn-sidebar-mobile .hn-mobile-reply')`);
 ev(`(()=>{window.hnTouchCheck.thread=app.plugins.plugins.highnote.store.viewFile(${q(note)})[0].id;return true})()`);
 const drawer=ev(`(()=>{const p=app.plugins.plugins.highnote,r=document.querySelector('.hn-sidebar-mobile');return {modify:p.canModify,overflow:r.scrollWidth-r.clientWidth,button:r.querySelector('.hn-message-more')?.getBoundingClientRect().height,active:app.workspace.activeLeaf?.view.getViewType()}})()`);
 assert.ok(drawer.modify);assert.ok(drawer.overflow<=1);assert.equal(drawer.button,44);results.drawer=drawer;
 ev(`(()=>{document.querySelector('.hn-mobile-reply').click();return true})()`);await until(`!!document.querySelector('.hn-modal textarea')`);
 ev(`(()=>{const t=document.querySelector('.hn-modal textarea');t.focus();t.value='手机第一行\\n手机第二行';t.dispatchEvent(new Event('input'));const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});t.dispatchEvent(event);window.hnTouchCheck.enterPrevented=event.defaultPrevented;return true})()`);
 assert.equal(ev('window.hnTouchCheck.enterPrevented'),false);
 assert.equal(ev('app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread).messages.length'),1);
 ev(`(()=>{document.querySelector('.hn-modal .mod-cta').click();return true})()`);
 await until(`app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread).messages.length===2 && !document.querySelector('.hn-modal textarea')`);results.reply=true;
 ev(`(()=>{document.querySelectorAll('.notice-container').forEach(e=>e.remove());return true})()`);
 call('dev:screenshot',`path=${output}/phone-comments.png`);
 // Editing, resolving/reopening, deleting one reply and preserving the parent discussion.
 ev(`(()=>{document.querySelector('.hn-message-more').click();return true})()`);
 await until(`[...document.querySelectorAll('.menu-item')].some(e=>e.textContent.includes('编辑'))`);
 ev(`(()=>{[...document.querySelectorAll('.menu-item')].find(e=>e.textContent.includes('编辑')).click();return true})()`);
 await until(`!!document.querySelector('.hn-modal textarea')`);
 await dimensions(440,420);
 const keyboard=ev(`(()=>{const m=document.querySelector('.hn-message-modal'),button=m.querySelector('.mod-cta');button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:m.clientWidth,scroll:m.scrollWidth}})()`);
 assert.ok(keyboard.top>=0&&keyboard.bottom<=420&&keyboard.scroll<=keyboard.width+1);results.keyboard=keyboard;
 ev(`(()=>{const t=document.querySelector('.hn-modal textarea');t.value='修改后的手机评论';t.dispatchEvent(new Event('input'));document.querySelector('.hn-modal .mod-cta').click();return true})()`);
 await until(`app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread).messages[0].body==='修改后的手机评论'`);
 await dimensions(440,956);
 ev(`(()=>{document.querySelector('.hn-sidebar-mobile .hn-resolve').click();return true})()`);
 await until(`app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread).resolved`);
 ev(`(()=>{const f=document.querySelector('.hn-sidebar-mobile .hn-status-filter');f.value='all';f.dispatchEvent(new Event('change'));return true})()`);
 await until(`!!document.querySelector('.hn-sidebar-mobile .hn-resolve')`);
 ev(`(()=>{document.querySelector('.hn-sidebar-mobile .hn-resolve').click();return true})()`);
 await until(`!app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread).resolved`);
 ev(`(()=>{[...document.querySelectorAll('.hn-message-more')].at(-1).click();return true})()`);
 await until(`[...document.querySelectorAll('.menu-item')].some(e=>e.textContent.includes('删除'))`);
 ev(`(()=>{[...document.querySelectorAll('.menu-item')].find(e=>e.textContent.includes('删除')).click();return true})()`);
 await until(`!![...app.plugins.plugins.highnote.openModals].at(-1)?.contentEl.querySelector('.mod-warning')`);await pause(250);
 ev(`(()=>{[...app.plugins.plugins.highnote.openModals].at(-1).contentEl.querySelector('.mod-warning').click();return true})()`);
 await until(`app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread).messages.filter(m=>!m.deleted).length===1`);
 results.editResolveDelete=true;
 await reading();await select('第二段用于手机标记。');
 ev(`(()=>{document.querySelector('.hn-selection-highlight').click();return true})()`);
 await until(`app.plugins.plugins.highnote.store.viewHighlights(${q(note)}).length===1`);
 await until(`!!window.hnTouchCheck.leaf.view.contentEl.querySelector('.hn-highlight')`);
 assert.equal(ev(`app.workspace.rightSplit.collapsed`),true);results.highlightKeepsReading=true;
 for(const [label,width,height] of [['ipad-portrait',744,1133],['ipad-landscape',1133,744],['ipad-split',360,744]]){
  await dimensions(width,height);await reading();await select();
  const r=ev(`(()=>{const r=document.querySelector('.hn-selection-touch').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
  assert.ok(r.left>=0&&r.right<=width&&r.top>=0&&r.bottom<=height,label);results[label]=r;
  call('dev:screenshot',`path=${output}/${label}.png`);
  ev(`(()=>{document.getSelection().removeAllRanges();return true})()`);
 }
 await dimensions(440,956);await reading();
 ev(`(async()=>{const s=window.hnTouchCheck;await s.leaf.setViewState({type:'markdown',state:{...s.leaf.view.getState(),mode:'source'},active:true});await app.plugins.plugins.highnote.openSidebar();return true})()`);
 await until(`!app.plugins.plugins.highnote.canModify && !document.querySelector('.hn-sidebar-mobile .hn-mobile-reply')`);
 assert.equal(ev(`document.querySelectorAll('.hn-sidebar-mobile .hn-message-more,.hn-sidebar-mobile .hn-resolve').length`),0);results.editModeReadOnly=true;
 await reading();await ev(`app.plugins.plugins.highnote.showThread(window.hnTouchCheck.thread)`);
 await until(`!!document.querySelector('.hn-sidebar-mobile .hn-message-more')`);
 const raw=ev(`(async()=>{const files=(await app.vault.adapter.list(${q(directory)})).files;window.hnTouchCheck.json=files.find(p=>p.endsWith('.json'));return app.vault.adapter.read(window.hnTouchCheck.json)})()`);
 assert.ok(raw.includes('修改后的手机评论'));assert.ok(!raw.includes('手机第二行'));
 call('plugin:reload','id=highnote');await until(`!!app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread)`);
 assert.equal(ev(`app.vault.adapter.read(window.hnTouchCheck.json)`),raw);results.restart=true;
 // Removing the final message clears its underline while a separate highlight survives.
 await reading();await ev(`app.plugins.plugins.highnote.showThread(window.hnTouchCheck.thread)`);
 ev(`(()=>{document.querySelector('.hn-message-more').click();return true})()`);
 await until(`[...document.querySelectorAll('.menu-item')].some(e=>e.textContent.includes('删除'))`);
 ev(`(()=>{[...document.querySelectorAll('.menu-item')].find(e=>e.textContent.includes('删除')).click();return true})()`);
 await until(`!![...app.plugins.plugins.highnote.openModals].at(-1)?.contentEl.querySelector('.mod-warning')`);await pause(250);
 ev(`(()=>{[...app.plugins.plugins.highnote.openModals].at(-1).contentEl.querySelector('.mod-warning').click();return true})()`);
 await until(`!app.plugins.plugins.highnote.store.get(window.hnTouchCheck.thread)`);
 await reading();await until(`!window.hnTouchCheck.leaf.view.contentEl.querySelector('.hn-mark')`);
 assert.equal(ev(`app.plugins.plugins.highnote.store.viewHighlights(${q(note)}).length`),1);
 ev(`(()=>{document.getSelection().removeAllRanges();window.hnTouchCheck.leaf.view.contentEl.querySelector('.hn-highlight').click();return true})()`);
 await until(`!!document.querySelector('.hn-highlight-remove')`);
 ev(`(()=>{document.querySelector('.hn-highlight-remove').click();return true})()`);
 await until(`!![...app.plugins.plugins.highnote.openModals].at(-1)?.contentEl.querySelector('.mod-warning')`);await pause(250);
 ev(`(()=>{[...app.plugins.plugins.highnote.openModals].at(-1).contentEl.querySelector('.mod-warning').click();return true})()`);
 await until(`app.plugins.plugins.highnote.store.viewHighlights(${q(note)}).length===0`);results.finalDeletion=true;
 console.log(JSON.stringify(results,null,2));writeFileSync(output+'/client-results.json',JSON.stringify(results,null,2));
}catch(error){console.error(JSON.stringify(results));console.error(ev(`(()=>{const p=app.plugins.plugins.highnote;return {modify:p.canModify,active:app.workspace.activeLeaf?.view.getViewType(),recent:app.workspace.getMostRecentLeaf()?.view.getViewType(),source:p.annotationSource?.file?.path,modals:[...p.openModals].map(m=>m.contentEl.textContent),notices:[...document.querySelectorAll('.notice')].map(e=>e.textContent)}})()`));throw error;}finally{
 ev(`(()=>{for(const m of app.plugins.plugins.highnote.openModals)m.close();return true})()`);
 await pause(300);
 ev(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnTouchCheck;document.getSelection().removeAllRanges();for(const m of p.openModals)m.close();p.drafts.clear();await p.setDataDirectory(s.initial);p.settings=s.settings;await p.saveData(s.settings);s.leaf?.detach();const folder=app.vault.getAbstractFileByPath(${q(root)});if(folder)await app.vault.delete(folder,true);else if(await app.vault.adapter.exists(${q(root)}))await app.vault.adapter.rmdir(${q(root)},true);await app.workspace.changeLayout(s.layout);delete window.hnTouchCheck;return true})()`);
 call('dev:cdp','method=Emulation.clearDeviceMetricsOverride');
}

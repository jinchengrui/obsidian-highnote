import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [cli,vault,output='/tmp/highnote-phone-landscape']=process.argv.slice(2);
if(!cli||!vault)throw new Error('Usage: node scripts/verify-phone-landscape-client.mjs obsidian-cli test-vault [output]');
mkdirSync(output,{recursive:true});
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:20000}).trim();
const ev=code=>{const out=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=out.split('\n').find(s=>s.startsWith('=> '));if(!line){if(out==='(no output)')return;throw new Error(out);}return JSON.parse(line.slice(3));};
const q=JSON.stringify,pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<60;i++){if(ev(code))return;await pause(100);}throw new Error(code);}
const root=`Highnote横屏验收-${Date.now()}`,directory=root+'/annotations',note=root+'/横屏笔记.md',results={};
assert.equal(ev('app.plugins.plugins.highnote.isMobile'),true);
ev(`(()=>{const p=app.plugins.plugins.highnote;window.hnLandscapeCheck={layout:app.workspace.getLayout(),settings:structuredClone(p.settings),initial:p.dataFolder};return true})()`);
async function size(width,height){call('dev:cdp','method=Emulation.setDeviceMetricsOverride',`params=${q({width,height,deviceScaleFactor:1,mobile:true,screenOrientation:{type:width>height?'landscapePrimary':'portraitPrimary',angle:width>height?90:0}})}`);await pause(250);}
async function reading(){ev(`(async()=>{const s=window.hnLandscapeCheck;app.workspace.rightSplit.collapse();await app.workspace.revealLeaf(s.leaf);await s.leaf.setViewState({type:'markdown',state:{...s.leaf.view.getState(),mode:'preview'},active:true});return true})()`);await until(`app.plugins.plugins.highnote.canModify && !!window.hnLandscapeCheck.leaf.view.contentEl.querySelector('.markdown-preview-view p')`);}
async function select(text){ev(`(()=>{const root=window.hnLandscapeCheck.leaf.view.contentEl;const p=[...root.querySelectorAll('.markdown-preview-view p')].find(p=>p.textContent===${q(text)});p.scrollIntoView({block:'center'});const r=document.createRange();r.selectNodeContents(p);document.getSelection().removeAllRanges();document.getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));return true})()`);await until(`!!document.querySelector('.hn-selection-touch')`);}
function box(selector){return ev(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}})()`);}
function visible(rect,width,height){assert.ok(rect&&rect.width>0&&rect.height>0);assert.ok(rect.left>=-1&&rect.right<=width+1&&rect.top>=-1&&rect.bottom<=height+1,JSON.stringify(rect));}
function screenshot(name){call('dev:screenshot',`path=${output}/${name}.png`);}
function tap(selector){const r=box(selector);call('dev:cdp','method=Input.dispatchMouseEvent',`params=${q({type:'mousePressed',x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,button:'left',clickCount:1})}`);call('dev:cdp','method=Input.dispatchMouseEvent',`params=${q({type:'mouseReleased',x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,button:'left',clickCount:1})}`);}
try{
 ev(`(async()=>{const p=app.plugins.plugins.highnote;app.setting.close();await p.setDataDirectory(${q(directory)});await app.vault.createFolder(${q(root)});const file=await app.vault.create(${q(note)},'# 横屏验证\\n\\n手机横屏添加评论。\\n\\n手机横屏添加标记。\\n\\n'+'后续阅读段落。\\n\\n'.repeat(20));const leaf=app.workspace.getLeaf('tab');window.hnLandscapeCheck.leaf=leaf;await leaf.openFile(file);return true})()`);
 await size(956,440);await reading();await select('手机横屏添加评论。');
 const toolbar=box('.hn-selection-touch');visible(toolbar,956,440);assert.equal(toolbar.width,208);results.toolbar=toolbar;
 ev(`(()=>{document.querySelectorAll('.notice-container').forEach(e=>e.remove());return true})()`);screenshot('横屏选区');tap('.hn-selection-comment');await until(`!!document.querySelector('.hn-modal textarea')`);
 ev(`(()=>{const t=document.querySelector('.hn-modal textarea');t.value='横屏评论，旋转时保留草稿。';t.dispatchEvent(new Event('input'));return true})()`);
 await size(440,956);assert.equal(ev(`document.querySelector('.hn-modal textarea').value`),'横屏评论，旋转时保留草稿。');await size(956,440);
 assert.equal(ev(`document.querySelector('.hn-modal textarea').value`),'横屏评论，旋转时保留草稿。');results.composeRotation=true;
 await size(956,220);ev(`(()=>{document.querySelector('.hn-modal .mod-cta').scrollIntoView({block:'nearest'});return true})()`);await pause(150);
 const save=box('.hn-modal .mod-cta'),modal=box('.hn-message-modal');visible(save,956,220);assert.ok(modal.scrollWidth<=modal.clientWidth+1);results.keyboardSave=save;screenshot('横屏键盘可视区域');tap('.hn-modal .mod-cta');
 await until(`app.plugins.plugins.highnote.store.viewFile(${q(note)}).length===1 && !document.querySelector('.hn-modal textarea')`);await size(956,440);
 ev(`(()=>{window.hnLandscapeCheck.thread=app.plugins.plugins.highnote.store.viewFile(${q(note)})[0].id;return true})()`);
 await until(`!!document.querySelector('.hn-sidebar-mobile .hn-mobile-reply')`);
 const drawer=box('.hn-sidebar-mobile');assert.ok(drawer.scrollWidth<=drawer.clientWidth+1);results.drawer=drawer;
 const list=box('.hn-thread-list');assert.ok(list.height>=100);results.listHeight=list.height;
 tap('.hn-landscape-filters');assert.ok(box('.hn-search-row').height>0);tap('.hn-landscape-filters');assert.equal(box('.hn-search-row').height,0);results.filterToggle=true;
 ev(`(()=>{document.querySelector('.hn-mobile-reply').scrollIntoView({block:'nearest'});return true})()`);await pause(150);
 tap('.hn-mobile-reply');await until(`!!document.querySelector('.hn-modal textarea')`);
 ev(`(()=>{const t=document.querySelector('.hn-modal textarea');t.focus();t.value='横屏回复第一行\\n横屏回复第二行';t.dispatchEvent(new Event('input'));return true})()`);
 await size(440,956);assert.equal(ev(`document.querySelector('.hn-modal textarea').value`),'横屏回复第一行\n横屏回复第二行');
 await size(956,220);ev(`(()=>{document.querySelector('.hn-modal .mod-cta').scrollIntoView({block:'nearest'});return true})()`);await pause(150);
 const send=box('.hn-modal .mod-cta');visible(send,956,220);results.replyKeyboard=send;screenshot('横屏回复发送');tap('.hn-modal .mod-cta');await until(`app.plugins.plugins.highnote.store.get(window.hnLandscapeCheck.thread).messages.length===2`);results.replyRotation=true;
 await size(956,440);screenshot('横屏评论');await reading();await select('手机横屏添加标记。');tap('.hn-selection-highlight');
 await until(`!!window.hnLandscapeCheck.leaf.view.contentEl.querySelector('.hn-highlight')`);assert.equal(ev('app.workspace.rightSplit.collapsed'),true);results.highlight=true;
 for(const [width,height]of [[812,375],[956,440]]){await size(width,height);await reading();await select('手机横屏添加评论。');visible(box('.hn-selection-touch'),width,height);ev(`(()=>{document.getSelection().removeAllRanges();return true})()`);}
 await ev('app.plugins.plugins.highnote.showThread(window.hnLandscapeCheck.thread)');await until(`!!document.querySelector('.hn-sidebar-mobile .hn-message-more')`);await pause(500);
 ev(`(()=>{document.querySelector('.hn-message-more').scrollIntoView({block:'center'});return true})()`);await pause(150);results.menuHit=ev(`(()=>{const b=document.querySelector('.hn-message-more'),r=b.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:r.toJSON(),hit:hit?.outerHTML,buttonHit:hit===b||b.contains(hit)}})()`);assert.ok(results.menuHit.buttonHit);tap('.hn-message-more');await until(`!!document.querySelector('.menu')`);await pause(300);const menu=box('.menu');visible(menu,956,440);results.menu=menu;screenshot('横屏菜单');ev(`(()=>{document.body.click();return true})()`);
 await reading();ev(`(async()=>{const s=window.hnLandscapeCheck;await s.leaf.setViewState({type:'markdown',state:{...s.leaf.view.getState(),mode:'source'},active:true});await app.plugins.plugins.highnote.openSidebar();return true})()`);await until(`!app.plugins.plugins.highnote.canModify && !document.querySelector('.hn-mobile-reply')`);results.editReadOnly=true;
 console.log(JSON.stringify(results,null,2));writeFileSync(output+'/results.json',JSON.stringify(results,null,2));
}catch(error){console.error(JSON.stringify(results));screenshot('失败现场');throw error;}finally{
 ev(`(()=>{for(const m of app.plugins.plugins.highnote.openModals)m.close();return true})()`);await pause(300);
 ev(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnLandscapeCheck;document.getSelection().removeAllRanges();p.drafts.clear();await p.setDataDirectory(s.initial);p.settings=s.settings;await p.saveData(s.settings);s.leaf.detach();const folder=app.vault.getAbstractFileByPath(${q(root)});if(folder)await app.vault.delete(folder,true);await app.workspace.changeLayout(s.layout);delete window.hnLandscapeCheck;return true})()`);call('dev:cdp','method=Emulation.clearDeviceMetricsOverride');
}

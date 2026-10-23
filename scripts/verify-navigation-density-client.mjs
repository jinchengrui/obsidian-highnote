import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli,vault,artifacts]=process.argv.slice(2);
if(!cli||!vault)throw new Error('Usage: node scripts/verify-navigation-density-client.mjs obsidian-cli test-vault [artifacts]');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:30000}).trim();
const e=code=>{const raw=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=raw.split('\n').find(l=>l.startsWith('=> '));if(!line)throw new Error(raw);return JSON.parse(line.slice(3));};
const cdp=(method,params={})=>JSON.parse(call('dev:cdp',`method=${method}`,`params=${JSON.stringify(params)}`));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<70;i++){if(e(code))return;await pause(100);}throw new Error(`Timed out: ${code}`);}
const folder=`导航聚焦验收${Date.now()}`;
const originalNavigation=e(`app.plugins.plugins.highnote.settings.showCommentNavigation===true`);
e(`(async()=>{await app.plugins.plugins.highnote.setCommentNavigation(true);return true})()`);
const ids=e(`(async()=>{const p=app.plugins.plugins['highnote'];for(const m of p.openModals)m.close();await p.openSidebar();await app.vault.createFolder('${folder}');const source='# 评论导航'+String.fromCharCode(10,10)+'第一条原文。'+String.fromCharCode(10,10)+'第二条原文。'+String.fromCharCode(10,10)+'第三条原文。'+String.fromCharCode(10,10)+'第四条原文。'+String.fromCharCode(10,10)+Array.from({length:60},(_,i)=>'阅读段落 '+i+' 保持正文位置。').join(String.fromCharCode(10,10));const file=await app.vault.create('${folder}/笔记.md',source);const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);await new Promise(r=>setTimeout(r,180));const ids=[];for(const [quote,body] of [['第一条','第一条评论'],['第二条','第二条评论'],['第三条','第三条评论'],['第四条','已解决评论']]){const at=source.indexOf(quote);ids.push((await p.store.create(file.path,source,at,at+6,body)).id)}await p.store.reply(ids[0],'回复保留全文');await p.store.update(ids[3],t=>{t.resolved=true});await p.showThread(ids[0]);const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='current';v.paneState.comments={status:'all',query:'',unlocatable:false};v.render();window.hnNavDensity={leaf};return ids})()`);
const card=id=>`[data-thread-id="${id}"]`;
await until(`document.querySelectorAll('.hn-card').length===4`);
const readScroll=e(`(()=>{const r=window.hnNavDensity.leaf.view.contentEl.querySelector('.markdown-preview-view');r.scrollTop=240;return r.scrollTop})()`);
function focus(id,direction){assert.deepEqual(e(`({id:document.activeElement.closest('[data-thread-id]')?.dataset.threadId,direction:document.activeElement.dataset.hnNavigation})`),{id,direction});assert.equal(e(`app.plugins.plugins['highnote'].focused`),id);}
e(`(()=>{document.querySelector('${card(ids[0])} [data-hn-navigation="next"]').click();return true})()`);
focus(ids[1],'next');
await pause(250);focus(ids[1],'next');
assert.equal(e(`document.activeElement.classList.contains('hn-quote')`),false);
// Enter is delivered through Chromium input, invoking the actual native button action.
function enter(){cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
enter();await until(`app.plugins.plugins['highnote'].focused==='${ids[2]}'`);focus(ids[2],'next');
enter();await until(`app.plugins.plugins['highnote'].focused==='${ids[3]}'`);focus(ids[3],'previous');
assert.equal(e(`document.querySelector('${card(ids[3])} [data-hn-navigation="next"]').disabled`),true);
enter();await until(`app.plugins.plugins['highnote'].focused==='${ids[2]}'`);focus(ids[2],'previous');
e(`(()=>{document.querySelector('${card(ids[1])} [data-hn-navigation="previous"]').click();return true})()`);focus(ids[0],'next');
assert.equal(e(`window.hnNavDensity.leaf.view.contentEl.querySelector('.markdown-preview-view').scrollTop`),readScroll);
// Scheduled content refresh preserves the new target button and reveals tools without mouse movement.
e(`(()=>{app.workspace.getLeavesOfType('highnote-comments')[0].view.render();return true})()`);focus(ids[0],'next');await pause(150);
await until(`getComputedStyle(document.querySelector('${card(ids[0])} .hn-thread-tools')).opacity==='1'`);
assert.equal(e(`getComputedStyle(document.querySelector('${card(ids[0])} .hn-thread-tools')).opacity`),'1');
const metrics=e(`(()=>{const c=document.querySelector('${card(ids[0])}');return {padding:getComputedStyle(c).paddingTop,header:getComputedStyle(c.querySelector('.hn-card-header')).marginBottom,message:getComputedStyle(c.querySelector('.hn-message')).marginBottom,footer:getComputedStyle(c.querySelector('.hn-card-footer')).marginTop,reply:c.querySelector('textarea').getBoundingClientRect().height,font:getComputedStyle(c.querySelector('.hn-message-body')).fontSize}})()`);
assert.deepEqual(metrics,{padding:'8px',header:'6px',message:'6px',footer:'3px',reply:22,font:'14px'});
function colors(){return e(`(()=>{const c=document.querySelector('${card(ids[3])}'),normal=document.querySelector('${card(ids[1])}');return {resolved:getComputedStyle(c).backgroundColor,normal:getComputedStyle(normal).backgroundColor,text:getComputedStyle(c.querySelector('.hn-message-body')).color,normalText:getComputedStyle(normal.querySelector('.hn-message-body')).color,opacity:getComputedStyle(c).opacity}})()`);}
let color=colors();assert.notEqual(color.resolved,color.normal);assert.equal(color.text,color.normalText);assert.equal(color.opacity,'1');
assert.equal(e(`document.querySelector('${card(ids[3])} .hn-resolve').title`),'已解决，点击重新打开');
e(`(()=>{app.plugins.plugins['highnote'].focusThread('${ids[3]}');document.querySelector('${card(ids[0])} [data-hn-navigation="next"]').blur();return true})()`);
const selectedResolved=e(`getComputedStyle(document.querySelector('${card(ids[3])}')).backgroundColor`);
e(`(()=>{app.plugins.plugins['highnote'].focusThread('${ids[1]}');return true})()`);
assert.equal(e(`getComputedStyle(document.querySelector('${card(ids[1])}')).backgroundColor`),selectedResolved);
// Summary cards use the same navigation focus and preserve compact merged content.
e(`(()=>{const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='all';v.query='${folder}';v.expandedOverview='';v.render();document.querySelector('${card(ids[0])} [data-hn-navigation="next"]').click();return true})()`);
focus(ids[1],'next');assert.equal(e(`document.querySelector('${card(ids[1])}').classList.contains('hn-summary')`),true);
assert.notEqual(colors().resolved,colors().normal);
e(`(()=>{document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');app.plugins.plugins['highnote'].clearFocus();document.activeElement?.blur();return true})()`);
color=colors();assert.notEqual(color.resolved,color.normal);assert.equal(color.text,color.normalText);
// Single-result lists disable both directions and keep focus out of the quote.
e(`(()=>{const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='current';v.query='已解决评论';v.render();return true})()`);
assert.equal(e(`document.querySelectorAll('.hn-card').length`),1);
assert.equal(e(`document.querySelectorAll('[data-hn-navigation]:disabled').length`),2);
if(artifacts){mkdirSync(artifacts,{recursive:true});for(const [theme,width,summary,name] of [['theme-light',360,false,'紧凑评论与已解决灰底.png'],['theme-dark',360,false,'已解决灰底深色.png'],['theme-light',280,true,'紧凑评论窄栏.png']]){
e(`(()=>{document.body.classList.remove('theme-light','theme-dark');document.body.classList.add('${theme}');const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='${summary?'all':'current'}';v.query='${summary?folder:''}';v.expandedOverview='';document.querySelector('.hn-sidebar').style.width='${width}px';v.render();document.activeElement?.blur();app.plugins.plugins['highnote'].clearFocus();document.querySelector('${card(ids[0])} [data-hn-navigation="next"]').click();return true})()`);await pause(180);
assert.equal(e(`(()=>{const r=document.querySelector('.hn-sidebar');return r.scrollWidth>r.clientWidth+2})()`),false);
const clip=e(`(()=>{const r=document.querySelector('.hn-sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);const result=cdp('Page.captureScreenshot',{format:'png',clip});writeFileSync(path.join(artifacts,name),Buffer.from(result.data,'base64'));
}}
e(`(()=>{document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');document.querySelector('.hn-sidebar').style.width='';const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='current';v.query='';v.status='active';v.render();delete window.hnNavDensity;return true})()`);
e(`(async()=>{await app.plugins.plugins.highnote.setCommentNavigation(${originalNavigation});return true})()`);
console.log('PASS: navigation focuses corresponding enabled target button; native Enter continues; first/last fallback; refresh focus persists; source scroll unchanged; exact compact gaps/22px reply; light/dark resolved gray and normal text; selected blue priority; summaries/single result/narrow layout.');

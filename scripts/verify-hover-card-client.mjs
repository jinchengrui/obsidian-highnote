import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli,vault,artifacts]=process.argv.slice(2);
if(!cli||!vault)throw new Error('Usage: node scripts/verify-hover-card-client.mjs obsidian-cli test-vault [artifacts]');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:30000}).trim();
const e=code=>{const raw=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=raw.split('\n').find(l=>l.startsWith('=> '));if(!line)throw new Error(raw);return JSON.parse(line.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<80;i++){if(e(code))return;await pause(100);}throw new Error(`Timed out: ${code}`);}
const folder=`悬停评论验收${Date.now()}`;
const ids=e(`(async()=>{const p=app.plugins.plugins['highnote'];for(const m of p.openModals)m.close();await p.openSidebar();await app.vault.createFolder('${folder}');const source='# 评论阅读'+String.fromCharCode(10,10)+'原文置于顶部，工具悬停显示，评论仍然完整保留。'+String.fromCharCode(10,10)+'第二条原文可以继续讨论。';const file=await app.vault.create('${folder}/笔记.md',source);const l=app.workspace.getLeaf('tab');await l.openFile(file);await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(l);await new Promise(r=>setTimeout(r,180));const a=await p.store.create(file.path,source,source.indexOf('原文置于'),source.indexOf('第二条')-2,'**第一条评论**');await p.store.reply(a.id,'回复完整保留');const b=await p.store.create(file.path,source,source.indexOf('第二条'),source.length,'第二条评论');const r=await p.store.create(file.path,source,source.indexOf('原文置于'),source.indexOf('原文置于')+5,'已解决评论');await p.store.update(r.id,t=>{t.resolved=true});await p.showThread(a.id);const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='current';v.paneState.comments={status:'active',query:'',unlocatable:false};v.render();return {a:a.id,b:b.id,r:r.id}})()`);
const card=id=>`[data-thread-id="${id}"]`;
await until(`document.querySelectorAll('.hn-card').length===2`);
assert.equal(e(`document.querySelector('[aria-label="评论状态"]').value`),'active');
assert.equal(e(`document.querySelectorAll('.hn-comment-status').length`),0);
function metrics(id,summary=false){return e(`(()=>{const c=document.querySelector('${card(id)}');const t=c.querySelector('.hn-thread-tools'),q=c.querySelector('.hn-quote'),r=c.querySelector('${summary?'.hn-overview-reply':'.hn-inline-reply'}');return {height:c.getBoundingClientRect().height,quote:q.getBoundingClientRect().width,tools:getComputedStyle(t).opacity,reply:getComputedStyle(r).opacity,expanded:!c.classList.contains('hn-summary'),overflow:c.scrollWidth>c.clientWidth+2}})()`);}
async function hover(id,on){const pt=on?e(`(()=>{const c=document.querySelector('${card(id)}');c.scrollIntoView({block:'start'});const r=c.getBoundingClientRect();return {x:r.x+8,y:r.y+8}})()`):{x:70,y:850};call('dev:cdp','method=Input.dispatchMouseEvent',`params=${JSON.stringify({type:'mouseMoved',...pt})}`);await pause(130);}
e(`(()=>{document.activeElement?.blur();return true})()`);await hover(ids.a,false);
const idle=metrics(ids.a);assert.equal(idle.tools,'0');assert.equal(idle.reply,'0');await hover(ids.a,true);
assert.deepEqual(metrics(ids.a),{...idle,tools:'1',reply:'1'});
assert.ok(e(`(()=>{const c=document.querySelector('${card(ids.a)}');return !!(c.querySelector('.hn-quote-block').compareDocumentPosition(c.querySelector('.hn-messages'))&Node.DOCUMENT_POSITION_FOLLOWING)})()`));
assert.equal(e(`document.querySelector('${card(ids.a)} [aria-label="上一条讨论"]').disabled`),true);
assert.equal(e(`document.querySelector('${card(ids.b)} [aria-label="下一条讨论"]').disabled`),true);
// All documents remain merged on hover, including full tools and reply prompt.
e(`(()=>{const s=document.querySelector('[aria-label="文档范围"]');s.value='all';s.dispatchEvent(new Event('change'));const q=document.querySelector('.hn-search');q.value='${folder}';q.dispatchEvent(new Event('input'));document.activeElement?.blur();return true})()`);
await until(`!!document.querySelector('${card(ids.a)}.hn-summary')`);
await hover(ids.a,false);const summary=metrics(ids.a,true);assert.equal(summary.tools,'0');assert.equal(summary.reply,'0');await hover(ids.a,true);
assert.deepEqual(metrics(ids.a,true),{...summary,tools:'1',reply:'1'});assert.equal(metrics(ids.a,true).expanded,false);
assert.ok(e(`document.querySelector('${card(ids.a)} .hn-summary-body').textContent.includes('回复完整保留')`));
// Moving through summaries must not expand conversations or open another document.
e(`(()=>{document.querySelector('${card(ids.a)} [aria-label="下一条讨论"]').click();return true})()`);
assert.ok(e(`document.querySelector('${card(ids.b)}').classList.contains('hn-summary')`));
e(`(()=>{document.querySelector('${card(ids.a)} .hn-overview-reply').click();return true})()`);
assert.equal(e(`document.activeElement?.matches('${card(ids.a)} textarea')`),true);
e(`(()=>{const t=document.activeElement;t.value='草稿不丢失';t.dispatchEvent(new Event('input'));document.querySelector('${card(ids.a)} .hn-overview-collapse').click();return true})()`);
e(`(()=>{document.querySelector('${card(ids.a)} .hn-overview-reply').click();return true})()`);
assert.equal(e(`document.querySelector('${card(ids.a)} textarea').value`),'草稿不丢失');
e(`(()=>{document.querySelector('${card(ids.a)} .hn-inline-cancel').click();document.querySelector('${card(ids.a)} .hn-overview-collapse').click();const f=document.querySelector('[aria-label="评论状态"]');f.value='resolved';f.dispatchEvent(new Event('change'));return true})()`);
assert.deepEqual(e(`[...document.querySelectorAll('.hn-card')].map(c=>c.dataset.threadId)`),[ids.r]);
e(`(()=>{const f=document.querySelector('[aria-label="评论状态"]');f.value='all';f.dispatchEvent(new Event('change'));return true})()`);
assert.equal(e(`document.querySelectorAll('.hn-card').length`),3);
assert.equal(e(`document.querySelectorAll('.hn-comment-status').length`),0);
// Marking a summary resolved uses the default filter and retains its reply draft.
e(`(()=>{const f=document.querySelector('[aria-label="评论状态"]');f.value='active';f.dispatchEvent(new Event('change'));document.querySelector('${card(ids.b)} .hn-resolve').click();return true})()`);
await until(`app.plugins.plugins['highnote'].store.get('${ids.b}').resolved && !document.querySelector('${card(ids.b)}')`);
e(`(()=>{const f=document.querySelector('[aria-label="评论状态"]');f.value='resolved';f.dispatchEvent(new Event('change'));document.querySelector('${card(ids.b)} .hn-resolve').click();return true})()`);
await until(`!app.plugins.plugins['highnote'].store.get('${ids.b}').resolved`);
e(`(()=>{document.querySelector('.hn-clear-filters').click();document.querySelector('.hn-search').value='';const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='current';v.query='';v.render();return true})()`);
assert.equal(e(`document.querySelector('[aria-label="评论状态"]').value`),'active');
if(artifacts){mkdirSync(artifacts,{recursive:true});for(const [width,theme,overview,name] of [[360,'theme-light',false,'原文在上的评论卡片.png'],[360,'theme-light',true,'全部文档悬停评论.png'],[360,'theme-dark',true,'悬停评论深色.png'],[280,'theme-light',false,'悬停评论窄栏.png']]){
e(`(()=>{const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='${overview?'all':'current'}';v.query='${overview?folder:''}';v.expandedOverview='';document.querySelector('.hn-sidebar').style.width='${width}px';document.body.classList.remove('theme-light','theme-dark');document.body.classList.add('${theme}');v.render();document.activeElement?.blur();return true})()`);await hover(ids.a,true);await pause(120);assert.equal(metrics(ids.a,overview).overflow,false);
const layout=e(`(()=>{const c=document.querySelector('${card(ids.a)}');return {quote:c.querySelector('.hn-quote-block').getBoundingClientRect().top,tools:c.querySelector('.hn-thread-tools').getBoundingClientRect().top}})()`);if(width===280)assert.ok(layout.tools>layout.quote);else assert.ok(Math.abs(layout.tools-layout.quote)<3);
const clip=e(`(()=>{const r=document.querySelector('.hn-sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);const result=JSON.parse(call('dev:cdp','method=Page.captureScreenshot',`params=${JSON.stringify({format:'png',clip})}`));writeFileSync(path.join(artifacts,name),Buffer.from(result.data,'base64'));
}}
e(`(async()=>{document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');document.querySelector('.hn-sidebar').style.width='';const l=app.workspace.getMostRecentLeaf();await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'source'},active:true});await app.workspace.revealLeaf(l);const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='all';v.query='${folder}';v.render();return true})()`);
await until(`!app.plugins.plugins['highnote'].canModify`);
assert.equal(e(`document.querySelectorAll('.hn-overview-reply,.hn-inline-reply-input,.hn-resolve,.hn-message-more').length`),0);
e(`(async()=>{const l=app.workspace.getMostRecentLeaf();await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});return true})()`);
call('plugin:reload','id=highnote');await until(`!!app.plugins.plugins['highnote'].store.get('${ids.a}')`);
assert.equal(e(`app.workspace.getLeavesOfType('highnote-comments')[0].view.paneState.comments.status`),'active');
console.log('PASS: original quote above comments, shared header/narrow wrap, real hover exposes actions and reply without expansion or layout shift,current/all,first/last navigation,default unresolved,no processing labels,summary reply/caret/draft/resolve,readonly and reload.');

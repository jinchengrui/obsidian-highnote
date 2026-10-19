import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [cli,vault,screenshot] = process.argv.slice(2);
if(!cli||!vault)throw new Error('Usage: node scripts/verify-deleted-message-client.mjs obsidian-cli test-vault [screenshot]');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:30000}).trim();
const e=code=>{const raw=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=raw.split('\n').find(l=>l.startsWith('=> '));if(!line)throw new Error(raw);return JSON.parse(line.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<60;i++){if(e(code))return;await pause(100);}throw new Error(`Timed out: ${code}`);}
const name=`删除消息验收${Date.now()}`;
const id=e(`(async()=>{const p=app.plugins.plugins['highnote'];for(const m of p.openModals)m.close();const source='# 评论删除后的展示'+String.fromCharCode(10,10)+'在不确定市场中，行动不只是等待结果。';const file=await app.vault.create('${name}.md',source);const l=app.workspace.getLeaf('tab');await l.openFile(file);await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(l);await new Promise(r=>setTimeout(r,150));const t=await p.store.create(file.path,source,source.indexOf('在不确定'),source.length,'主评论要删除');await p.store.reply(t.id,'第一条回复保留');await p.store.reply(t.id,'中间回复要删除');await p.store.reply(t.id,'末条回复保留');await p.store.update(t.id,t=>{t.messages[0].createdAt='2020-01-01T01:00:00Z';t.messages[0].updatedAt=t.messages[0].createdAt;t.messages[1].updatedAt=new Date(Date.now()+1000).toISOString()});await p.showThread(t.id);const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='current';v.paneState.comments={status:'all',query:'',unlocatable:false};v.render();return t.id})()`);
await until(`document.querySelectorAll('[data-thread-id="${id}"] .hn-message').length===4`);
const card=`[data-thread-id="${id}"]`;
function remove(index){e(`(()=>{document.querySelectorAll('${card} .hn-message-more')[${index}].click();[...document.querySelectorAll('.menu-item')].find(el=>el.textContent.trim()==='删除').click();document.querySelector('.modal .mod-warning').click();return true})()`);}
remove(0);
await until(`document.querySelectorAll('${card} .hn-message').length===3`);
assert.equal(e(`document.querySelector('${card}').textContent.includes('该消息已删除')`),false);
assert.equal(e(`document.querySelector('${card}').textContent.includes('2020年')`),false);
assert.equal(e(`document.querySelectorAll('${card} .hn-comment-status').length`),0);
assert.ok(e(`document.querySelector('${card} .hn-message-meta').textContent.includes('（编辑过）')`));
remove(1);await until(`document.querySelectorAll('${card} .hn-message').length===2`);
assert.deepEqual(e(`[...document.querySelectorAll('${card} .hn-message .hn-message-body')].map(el=>el.textContent)`),['第一条回复保留','末条回复保留']);
call('plugin:reload','id=highnote');await until(`!!app.plugins.plugins['highnote'].store.get('${id}')`);
e(`(async()=>{await app.plugins.plugins['highnote'].showThread('${id}');return true})()`);await until(`document.querySelectorAll('${card} .hn-message').length===2`);
assert.equal(e(`document.querySelector('${card}').textContent.includes('该消息已删除')`),false);
// Existing deleted entries remain in data but disappear from the summary and expanded card.
e(`(()=>{const s=document.querySelector('[aria-label="文档范围"]');s.value='all';s.dispatchEvent(new Event('change'));const q=document.querySelector('.hn-search');q.value='第一条回复保留';q.dispatchEvent(new Event('input'));return true})()`);
assert.ok(e(`document.querySelector('${card} .hn-summary-body').textContent.includes('末条回复保留')`));
e(`(()=>{document.querySelector('${card} .hn-summary-body').click();return true})()`);
assert.equal(e(`document.querySelectorAll('${card} .hn-message').length`),2);
// Previews, counts, Markdown and HTML exclude deleted content and timestamps.
e(`(()=>{app.plugins.plugins['highnote'].openExport('current','comments');return true})()`);
assert.ok(e(`document.querySelector('.hn-review-export-description').textContent.includes('2 条记录')`));
assert.ok(e(`document.querySelector('.hn-flomo-preview-content').textContent.includes('第一条回复保留')`));
e(`(()=>{for(const m of app.plugins.plugins['highnote'].openModals)m.close();return true})()`);
const exports=e(`(async()=>{const p=app.plugins.plugins['highnote'];const open=p.openExportInBrowser;p.openExportInBrowser=async()=>{};try{const md=await p.exportComments('current','md');p.activePath='${name}.md';const html=await p.exportComments('current','html');return {md:await app.vault.read(md),html:await app.vault.read(html)}}finally{p.openExportInBrowser=open}})()`);
for(const text of [exports.md,exports.html]){assert.ok(text.includes('第一条回复保留')&&text.includes('末条回复保留'));assert.ok(!text.includes('该消息已删除')&&!text.includes('2020年')&&!text.includes('中间回复要删除'));}
e(`(async()=>{const p=app.plugins.plugins['highnote'];const l=app.workspace.getLeaf('tab');await l.openFile(app.vault.getFileByPath('${name}.md'));await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'source'},active:true});await app.workspace.revealLeaf(l);await p.showThread('${id}');return true})()`);
await until(`!app.plugins.plugins['highnote'].canModify && document.querySelectorAll('${card} .hn-message').length===2`);
assert.equal(e(`document.querySelector('${card}').textContent.includes('该消息已删除')`),false);
e(`(async()=>{const l=app.workspace.getMostRecentLeaf();await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.viewScope='current';v.query='';v.render();document.getSelection().removeAllRanges();return true})()`);
await pause(200);
if(screenshot){const clip=e(`(()=>{const r=document.querySelector('.hn-sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);const result=JSON.parse(call('dev:cdp','method=Page.captureScreenshot',`params=${JSON.stringify({format:'png',clip})}`));writeFileSync(screenshot,Buffer.from(result.data,'base64'));}
console.log('PASS: actual deletion of main and middle reply; no placeholder/date; no processing-status text; edited time preserved; reload,current/all/source,preview/reply count,Markdown/HTML exports retain only undeleted messages.');

import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-export-client.mjs /path/to/obsidian-cli test-vault-name');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8'}).trim();
const evaluate = code => {
  const output = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  if (!output.startsWith('=> ')) throw new Error(output);
  return JSON.parse(output.slice(3));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 60; i++) { if (evaluate(code)) return; await pause(100); }
  throw new Error(`Timed out: ${code}`);
}
const folder = `Export-check-${Date.now()}`;
const sourcePath = `${folder}/笔记.md`;
const ids = evaluate(`(async()=>{
  const p=app.plugins.plugins['highnote'];
  await app.vault.createFolder(${JSON.stringify(folder)});
  await app.vault.createFolder(${JSON.stringify(folder+'/子目录')});
  const source='旧的前文目标句子旧的后文';
  const a=await app.vault.create(${JSON.stringify(sourcePath)},source);
  const leaf=app.workspace.getLeaf('tab');await leaf.openFile(a);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);
  await new Promise(r=>setTimeout(r,200));
  const first=await p.store.create(a.path,source,4,8,'**评论重点**'+String.fromCharCode(10)+'- 一'+String.fromCharCode(10)+'- 二');
  await p.store.reply(first.id,'待删除内容');await p.store.reply(first.id,'最后回复');
  await p.store.update(first.id,t=>{t.messages[1].body='';t.messages[1].deleted=true;t.messages[0].updatedAt='2026-10-14T10:00:00Z'});
  const second=await p.store.create(a.path,source,8,12,'第二条评论');
  const b=await app.vault.create(${JSON.stringify(folder+'/子目录/笔记.md')},source);
  const third=await p.store.create(b.path,source,4,8,'同名文档评论');
  await p.store.update(third.id,t=>{t.anchor.state='detached';t.resolved=true});
  await p.showThread(first.id);
  const scope=document.querySelector('[aria-label="文档范围"]');scope.value='current';scope.dispatchEvent(new Event('change'));
  const filter=document.querySelector('[aria-label="评论状态"]');filter.value='all';filter.dispatchEvent(new Event('change'));
  return [first.id,second.id,third.id];
})()`);
const [first, second] = ids;
await until(`document.querySelectorAll('.hn-card').length===2`);
assert.equal(evaluate(`document.querySelector('[data-thread-id="${first}"] [aria-label="上一条讨论"]').disabled`),true);
assert.equal(evaluate(`document.querySelector('[data-thread-id="${second}"] [aria-label="下一条讨论"]').disabled`),true);
assert.equal(evaluate(`document.querySelector('[data-thread-id="${second}"] [aria-label="下一条讨论"]').hasAttribute('title')`),false);
evaluate(`(()=>{const b=document.querySelector('[data-thread-id="${second}"] [aria-label="下一条讨论"]');b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));b.click();return true})()`);
assert.equal(evaluate(`app.plugins.plugins['highnote'].focused`),first);
evaluate(`(()=>{const search=document.querySelector('.hn-search');search.value='第二条评论';search.dispatchEvent(new Event('input'));return true})()`);
assert.equal(evaluate(`document.querySelectorAll('.hn-card').length`),1);
assert.equal(evaluate(`document.querySelectorAll('.hn-card button:disabled[aria-label$="条讨论"]').length`),2);
evaluate(`(()=>{const search=document.querySelector('.hn-search');search.value='';search.dispatchEvent(new Event('input'));const b=document.querySelector('[data-thread-id="${first}"] .hn-resolve');b.click();b.click();return true})()`);
await until(`app.plugins.plugins['highnote'].store.get('${first}').resolved===true`);
await pause(100);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${first}').resolved`),true);

// Editing only the context keeps a unique quote at the same offset. Repeated overview clicks are read actions.
evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];const file=app.vault.getFileByPath(${JSON.stringify(sourcePath)});const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await new Promise(r=>setTimeout(r,200));await app.vault.modify(file,'新的前文目标句子新的后文');await p.reconcileFile(file);const scope=document.querySelector('[aria-label="文档范围"]');scope.value='all';scope.dispatchEvent(new Event('change'));const sidebar=app.workspace.getLeavesOfType('highnote-comments')[0].view;sidebar.page=Math.max(1,Math.ceil((sidebar.visibleThreads.indexOf('${first}')+1)/40));sidebar.render();document.querySelector('[data-thread-id="${first}"] .hn-quote').click();return true})()`);
await pause(150);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${first}').anchor.state`),'attached');
evaluate(`(()=>{document.querySelector('[data-thread-id="${first}"] .hn-summary-body').click();return true})()`);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${first}').anchor.state`),'attached');

// Make a delayed reconciliation observe a newer edit before its write is allowed to run.
const race = evaluate(`(async()=>{
  const p=app.plugins.plugins['highnote'];const file=app.vault.getFileByPath(${JSON.stringify(sourcePath)});
  const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file);
  await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'source'},active:true});await app.workspace.revealLeaf(leaf);
  await new Promise(r=>setTimeout(r,200));
  const editor=leaf.view.editor;
  editor.focus();
  editor.replaceRange('修改', {line:0,ch:0}, {line:0,ch:2});await p.flushAnchors();
  let release;let entered;const gate=new Promise(r=>{release=r});const ready=new Promise(r=>{entered=r});
  const original=p.store.updateFile.bind(p.store);let intercepted=false;
  p.store.updateFile=async(path, edit)=>{if(!intercepted&&path===file.path){intercepted=true;entered();await gate;}return original(path,edit)};
  // Force the disk/editor context to differ from the saved anchor without changing the quote's position.
  await p.store.update('${first}',t=>{t.anchor.before='旧的前文'});
  const recon=p.reconcileFile(file);await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Reconciliation gate not reached')),3000))]);
  editor.replaceRange('新增', {line:0,ch:0});
  release();await recon;await p.flushAnchors();p.store.updateFile=original;
  const t=p.store.get('${first}');return {state:t.anchor.state,from:t.anchor.from,actual:editor.getValue().indexOf('目标句子')};
})()`);
assert.equal(race.state,'attached');assert.equal(race.from,race.actual);

const exported = evaluate(`(async()=>{
  const p=app.plugins.plugins['highnote'];p.activePath=${JSON.stringify(sourcePath)};
  const noteLeaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===${JSON.stringify(sourcePath)});await noteLeaf.setViewState({type:'markdown',state:{...noteLeaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(noteLeaf);
  await p.showThread('${first}');
  const field=document.querySelector('[data-thread-id="${first}"] textarea');field.value='这个草稿不能导出';field.dispatchEvent(new Event('input'));
  const search=document.querySelector('.hn-search');search.value='没有匹配的内容';search.dispatchEvent(new Event('input'));
  const before=p.store.all().length;
  const a=await p.exportComments('current');p.activePath=${JSON.stringify(sourcePath)};
  const b=await p.exportComments('current');
  const all=await p.exportComments('all');
  const text=await app.vault.read(a);const allText=await app.vault.read(all);
  return {a:a.path,b:b.path,all:all.path,text,allText,before,after:p.store.all().length};
})()`);
assert.ok(/笔记-评论导出(?:\(\d+\))?\.md$/u.test(exported.a));
assert.notEqual(exported.a,exported.b);assert.equal(exported.a.includes('/'),false);
assert.equal(exported.text.includes('第二条评论'),true);
assert.equal(exported.text.includes('这个草稿不能导出'),false);
assert.equal(exported.text.includes('同名文档评论'),false);
assert.equal(exported.text.includes('该消息已删除'),false);
assert.equal(exported.text.includes('最后回复'),true);
assert.equal(exported.text.includes('（编辑过）'),true);
assert.equal(exported.allText.includes('同名文档评论'),true);
assert.equal(exported.allText.includes('原文位置失效'),true);
assert.equal(exported.before,exported.after);

// No comments: no empty export file; double export while saving: a single snapshot.
const once = evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];p.activePath='没有评论.md';const empty=await p.exportComments('current');p.activePath=${JSON.stringify(sourcePath)};const result=await Promise.all([p.exportComments('current'),p.exportComments('current')]);return {empty:empty?.path,created:result.filter(Boolean).length}})()`);
assert.equal(once.empty,undefined);assert.equal(once.created,1);
evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];await p.store.remove('${second}');await p.showThread('${first}');const scope=document.querySelector('[aria-label="文档范围"]');scope.value='current';scope.dispatchEvent(new Event('change'));return true})()`);
await until(`document.querySelectorAll('.hn-card').length===1`);
assert.equal(evaluate(`document.querySelectorAll('.hn-card button:disabled[aria-label$="条讨论"]').length`),2);
evaluate(`(()=>{document.querySelector('.hn-sidebar-more').click();return true})()`);
assert.deepEqual(evaluate(`[...document.querySelectorAll('.menu-item')].map(e=>e.textContent.trim())`),['导出评论','重新加载数据']);
evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
console.log(`PASS: first/last/single filtered navigation, disabled click inert, idempotent resolution, context edits and overview location, delayed reconciliation vs editor edits, current/all Markdown exports, saved replies/status/time/format, no draft/overwrite/empty export, same basenames, double-export guard. Export: ${exported.a}`);

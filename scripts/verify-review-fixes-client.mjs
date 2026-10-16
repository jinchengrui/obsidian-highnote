import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';

const [cli, vault, resultPath] = process.argv.slice(2);
if (!cli || !vault) throw new Error('需要 Obsidian CLI 与可丢弃测试库名称');
const evaluate = code => {
  const raw = execFileSync(cli, [`vault=${vault}`, 'eval', `code=(async()=>JSON.stringify(await (${code})))()`],
    {encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024});
  const line = raw.split('\n').find(value => value.startsWith('=> '));
  if (!line) throw new Error(raw);
  return JSON.parse(line.slice(3));
};
const key = `审查修复验收${Date.now()}`, results = {};
const setup = evaluate(`(async()=>{
  const plugin=app.plugins.plugins.highnote;
  for(const modal of [...plugin.openModals])modal.close();
  const folder=${JSON.stringify(key)};
  await app.vault.createFolder(folder);
  const source='# 验收'+String.fromCharCode(10,10)+'用于核对评论、标记与回顾的原文。';
  const file=await app.vault.create(folder+'/原文.md',source);
  const thread=await plugin.store.create(file.path,source,source.indexOf('用于'),source.length,'初始评论');
  await plugin.openReview();
  const view=app.workspace.getLeavesOfType('highnote-review')[0].view;
  view.kind='comments';view.viewScope='current';view.sourcePath=file.path;
  view.query='';view.search.value='';view.selectedDay='';view.includeReplies=true;
  plugin.syncReview();view.refresh(true);
  return {id:thread.id,path:file.path,folder};
})()`);

results.rename = evaluate(`(async()=>{
  const plugin=app.plugins.plugins.highnote,view=app.workspace.getLeavesOfType('highnote-review')[0].view;
  view.feed.querySelector('.hn-review-details-link').click();
  plugin.openReviewExport('comments','',true,view.exportButton,'current',${JSON.stringify(setup.path)});
  const modal=[...plugin.openModals].find(m=>m.contentEl.classList.contains('hn-review-export'));
  const file=app.vault.getFileByPath(${JSON.stringify(setup.path)});
  await app.fileManager.renameFile(file,${JSON.stringify(setup.folder + '/改名.md')});
  await plugin.store.idle();await new Promise(resolve=>setTimeout(resolve,450));
  await app.fileManager.renameFile(app.vault.getFolderByPath(${JSON.stringify(setup.folder)}),${JSON.stringify(setup.folder + '-移动')});
  await plugin.store.idle();await new Promise(resolve=>setTimeout(resolve,450));
  plugin.syncReview();view.refresh(true);
  const result={groups:view.groups.length,path:view.sourcePath,exportPath:modal.sourcePath,
    exportDisabled:modal.submit.disabled,detailsPath:[...plugin.openModals].find(m=>m.contentEl.classList.contains('hn-review-details')).group.filePath};
  for(const open of [...plugin.openModals])open.close();return result;
})()`);
const movedPath = setup.folder + '-移动/改名.md';
assert.equal(results.rename.groups, 1);
assert.equal(results.rename.path, movedPath);
assert.equal(results.rename.exportPath, movedPath);
assert.equal(results.rename.detailsPath, movedPath);
assert.equal(results.rename.exportDisabled, false);

results.csv = evaluate(`(async()=>{
  const plugin=app.plugins.plugins.highnote;
  plugin.openReviewExport('comments','',true,undefined,'current',${JSON.stringify(movedPath)});
  const modal=[...plugin.openModals].find(m=>m.contentEl.classList.contains('hn-review-export'));
  const input=label=>modal.contentEl.querySelector('[aria-label="'+label+'"]');
  const format=modal.contentEl.querySelector('input[value="flomo_csv"]');
  format.checked=true;format.dispatchEvent(new Event('change'));
  const custom=input('使用自定义模板');custom.checked=true;custom.dispatchEvent(new Event('change'));
  const template=input('正文模板');template.value='{评论}';template.dispatchEvent(new Event('input'));
  const replies=input('包含回复');replies.checked=false;replies.dispatchEvent(new Event('change'));
  await new Promise(resolve=>setTimeout(resolve,250));
  const result={disabled:modal.submit.disabled,pending:modal.pending,rows:modal.rows.length,error:modal.error.textContent};
  template.dispatchEvent(new Event('compositionstart'));template.value='{评论} 编辑';
  template.dispatchEvent(new Event('input'));result.composingDisabled=modal.submit.disabled;
  template.dispatchEvent(new Event('compositionend'));await new Promise(resolve=>setTimeout(resolve,250));
  result.afterCompositionDisabled=modal.submit.disabled;
  template.dispatchEvent(new Event('input'));modal.close();result.closedPending=modal.pending;return result;
})()`);
assert.equal(results.csv.disabled, false);
assert.equal(results.csv.pending, null);
assert.equal(results.csv.rows, 1);
assert.equal(results.csv.error, '');
assert.equal(results.csv.composingDisabled, true);
assert.equal(results.csv.afterCompositionDisabled, false);
assert.equal(results.csv.closedPending, null);

results.sidebar = evaluate(`(async()=>{
  const plugin=app.plugins.plugins.highnote,id=${JSON.stringify(setup.id)};
  await plugin.store.update(id,thread=>thread.messages.push(...Array.from({length:999},(_,index)=>({id:crypto.randomUUID(),
    body:'第'+(index+2)+'条完整消息'+String.fromCharCode(10)+'**加粗**与正文全文',deleted:false,
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}))));
  const leaf=app.workspace.getLeaf('tab');await leaf.openFile(app.vault.getFileByPath(${JSON.stringify(movedPath)}));
  await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});
  await app.workspace.revealLeaf(leaf);await plugin.showThread(id);
  const view=app.workspace.getLeavesOfType('highnote-comments')[0].view;
  view.viewScope='current';view.query='';view.status='all';
  const started=performance.now();view.render();
  let card=view.contentEl.querySelector('[data-thread-id="'+id+'"]');
  const result={renderMs:performance.now()-started,messages:card.querySelectorAll('.hn-message').length,
    nodes:view.contentEl.querySelectorAll('*').length};
  card.querySelector('[data-hn-message-page="last"]').click();
  card=view.contentEl.querySelector('[data-thread-id="'+id+'"]');
  result.lastBatchCount=card.querySelectorAll('.hn-message').length;
  result.lastPresent=card.textContent.includes('第1000条完整消息');
  result.lastDisabled=card.querySelector('[data-hn-message-page="last"]').disabled;
  view.viewScope='all';view.expandedOverview='';view.query=${JSON.stringify(setup.folder)};view.page=1;view.render();
  card=view.contentEl.querySelector('[data-thread-id="'+id+'"]');
  result.summaryParagraphs=card.querySelectorAll('.hn-summary-body p').length;
  result.summaryHasPaging=!!card.querySelector('[data-hn-message-pagination]');return result;
})()`);
assert.equal(results.sidebar.messages, 40);
assert.ok(results.sidebar.nodes < 2000);
assert.equal(results.sidebar.lastBatchCount, 40);
assert.equal(results.sidebar.lastPresent, true);
assert.equal(results.sidebar.lastDisabled, true);
assert.ok(results.sidebar.summaryParagraphs <= 100);
assert.equal(results.sidebar.summaryHasPaging, true);

results.atomicDelete = evaluate(`(async()=>{
  const plugin=app.plugins.plugins.highnote,path=${JSON.stringify(setup.folder + '-移动/并发.md')};
  await app.vault.create(path,'并发原文');
  const thread=await plugin.store.create(path,'并发原文',0,4,'唯一评论');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(path));
  const name='note-'+[...new Uint8Array(digest).slice(0,16)].map(value=>value.toString(16).padStart(2,'0')).join('');
  const dataPath='.obsidian-highnote/annotations/'+name+'.json',file=dataPath;
  const original=app.vault.adapter.process;let injected=false,blocked=false;
  app.vault.adapter.process=async function(target,callback,...rest){
    if(target===file&&!injected){injected=true;await original.call(this,target,raw=>{
      const note=JSON.parse(raw);note.revision++;
      note.threads[0].messages.push({id:crypto.randomUUID(),body:'并发新增应保留',deleted:false,
        createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});return JSON.stringify(note,null,2);
    });}return original.call(this,target,callback,...rest);
  };
  try{await plugin.store.deleteMessage(thread.id,thread.messages[0].id,true);}catch{blocked=true;}
  finally{app.vault.adapter.process=original;}
  const preserved=(await app.vault.adapter.read(file)).includes('并发新增应保留');
  await plugin.refreshData();
  let current=plugin.store.get(thread.id);
  for(const message of current.messages.filter(item=>!item.deleted)){
    current=plugin.store.get(thread.id);await plugin.store.deleteMessage(thread.id,message.id,current.messages.filter(item=>!item.deleted).length===1);
  }
  const empty=JSON.parse(await app.vault.adapter.read(file));
  await plugin.refreshData();
  const recreated=await plugin.store.create(path,'并发原文',0,4,'清空后重新评论');
  return {injected,blocked,preserved,fileRetained:await app.vault.adapter.exists(dataPath),emptyThreads:empty.threads.length,
    emptyHighlights:empty.highlights.length,oldDiscussionRemoved:!plugin.store.get(thread.id),recreated:!!plugin.store.get(recreated.id)};
})()`);
for (const key of ['injected', 'blocked', 'preserved', 'fileRetained', 'oldDiscussionRemoved', 'recreated']) assert.equal(results.atomicDelete[key], true);
assert.equal(results.atomicDelete.emptyThreads, 0);
assert.equal(results.atomicDelete.emptyHighlights, 0);
if (resultPath) writeFileSync(resultPath, JSON.stringify(results, null, 2));
console.log('通过：改名与父目录移动、回顾及弹窗来源、CSV 快速切换与输入法、长讨论两种侧栏分页、删除并发保护及空文件复用。');
console.log(JSON.stringify(results));

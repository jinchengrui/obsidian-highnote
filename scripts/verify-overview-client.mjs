import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-overview-client.mjs /path/to/obsidian-cli test-vault-name');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding: 'utf8'}).trim();
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
evaluate(`(async()=>{await app.plugins.plugins['highnote'].openSidebar();return true})()`);
const folder = `Overview-check-${Date.now()}`;
const path = `${folder}/笔记.md`;
const ids = evaluate(`(async()=>{
  const p=app.plugins.plugins['highnote'];
  await p.openSidebar();
  const search=document.querySelector('.hn-search');search.value='';search.dispatchEvent(new Event('input'));
  await app.vault.createFolder(${JSON.stringify(folder)});
  await app.vault.createFolder(${JSON.stringify(folder+'/子目录')});
  const source='第一段原文。第二段原文。';
  const file=await app.vault.create(${JSON.stringify(path)},source);
  await app.vault.create(${JSON.stringify(folder+'/子目录/笔记.md')},source);
  const noteLeaf=app.workspace.getLeaf('tab');await noteLeaf.openFile(file);await noteLeaf.setViewState({type:'markdown',state:{...noteLeaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(noteLeaf);
  const a=await p.store.create(file.path,source,0,6,'**第一条完整评论**');
  await p.store.reply(a.id,${JSON.stringify(folder+'搜索后续回复')});
  await p.store.reply(a.id,'必须删除的正文');
  await p.store.reply(a.id,'最后一条回复 <script>仅显示文本</script>');
  await p.store.update(a.id,t=>{t.messages[2].deleted=true;t.messages[2].body=''});
  const b=await p.store.create(file.path,source,6,12,'完整长评论'+ '内容'.repeat(160)+'结尾未截断');
  const c=await p.store.create(${JSON.stringify(folder+'/子目录/笔记.md')},source,0,6,'同名笔记评论');
  await p.showThread(a.id);
  const view=app.workspace.getLeavesOfType('highnote-comments')[0].view;
  view.viewScope='current';view.render();
  return [a.id,b.id,c.id];
})()`);
const [first, second] = ids;
await until(`document.querySelectorAll('.hn-card').length===2`);
assert.equal(evaluate(`document.querySelectorAll('[data-thread-id="${first}"] .hn-message').length`), 3);
assert.equal(evaluate(`document.querySelectorAll('.hn-author,.hn-avatar').length`), 0);
assert.ok(evaluate(`document.querySelector('[data-thread-id="${second}"]').textContent.includes('结尾未截断')`));
const detailedHeight = evaluate(`document.querySelector('[data-thread-id="${first}"]').getBoundingClientRect().height`);
function scope(value) {
  evaluate(`(()=>{const field=document.querySelector('[aria-label="文档范围"]');field.value='${value}';field.dispatchEvent(new Event('change'));return true})()`);
}
scope('all');
evaluate(`(()=>{const view=app.workspace.getLeavesOfType('highnote-comments')[0].view;view.page=Math.max(1,Math.ceil(view.visibleThreads.indexOf('${first}')/40)+1);view.render();return true})()`);
await until(`!!document.querySelector('[data-thread-id="${first}"].hn-summary')`);
assert.equal(evaluate(`document.querySelectorAll('.hn-summary .hn-avatar,.hn-summary textarea').length`), 0);
const summary = evaluate(`document.querySelector('[data-thread-id="${first}"] .hn-summary-body').textContent`);
assert.equal(summary, `第一条完整评论 · ${folder}搜索后续回复 · 最后一条回复 <script>仅显示文本</script>`);
assert.equal(evaluate(`document.querySelectorAll('.hn-summary-body script').length`), 0);
assert.ok(evaluate(`document.querySelector('[data-thread-id="${second}"] .hn-summary-body').textContent.endsWith('结尾未截断')`));
const groups=evaluate(`[...document.querySelectorAll('.hn-file-group')].filter(e=>e.querySelector('.hn-file-path').textContent.startsWith(${JSON.stringify(folder)})).map(e=>({name:e.querySelector('.hn-file-name').textContent,path:e.querySelector('.hn-file-path').textContent}))`);
assert.ok(groups.find(g=>g.path===path).name.endsWith(folder+'/笔记.md'));assert.ok(groups.find(g=>g.path===folder+'/子目录/笔记.md').name.endsWith('子目录/笔记.md'));
assert.deepEqual(groups.map(g=>g.path).sort(), [path,folder+'/子目录/笔记.md'].sort());
const summaryHeight = evaluate(`document.querySelector('[data-thread-id="${first}"]').getBoundingClientRect().height`);
assert.ok(summaryHeight < detailedHeight, `Summary ${summaryHeight}, detailed ${detailedHeight}`);
evaluate(`(()=>{const search=document.querySelector('.hn-search');search.value=${JSON.stringify(folder+'搜索后续回复')};search.dispatchEvent(new Event('input'));return true})()`);
assert.equal(evaluate(`document.querySelectorAll('.hn-summary').length`), 1);
evaluate(`(()=>{document.querySelector('.hn-summary-body').click();return true})()`);
await until(`document.querySelectorAll('[data-thread-id="${first}"] .hn-message').length===3`);
evaluate(`(()=>{const field=document.querySelector('[data-thread-id="${first}"] textarea');field.focus();field.value='切换视图保留草稿';field.dispatchEvent(new Event('input'));return true})()`);
evaluate(`(()=>{document.querySelector('.hn-overview-collapse').click();return true})()`);
assert.equal(evaluate(`document.querySelectorAll('.hn-summary').length`), 1);
evaluate(`(()=>{document.querySelector('.hn-summary-body').click();return true})()`);
assert.equal(evaluate(`document.querySelector('[data-thread-id="${first}"] textarea').value`),'切换视图保留草稿');
scope('current');
assert.equal(evaluate(`document.querySelector('[data-thread-id="${first}"] textarea').value`),'切换视图保留草稿');
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${first}').messages.length`),4);
console.log(`PASS: complete current conversations without author or avatar, merged undeleted replies, inert markup, full long comments, duplicate filenames with relative paths, reply search, open/collapse and draft retention; height ${detailedHeight}px → ${summaryHeight}px.`);

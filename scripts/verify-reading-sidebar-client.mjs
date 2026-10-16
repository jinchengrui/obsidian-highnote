import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const [cli, vault, screenshots] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-reading-sidebar-client.mjs obsidian-cli test-vault [screenshots]');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8', timeout:20000}).trim();
const evaluate = code => {
  const output = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  const line = output.split('\n').find(l => l.startsWith('=> '));
  if (!line) throw new Error(output);
  return JSON.parse(line.slice(3));
};
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(code) {
  for (let i=0; i<60; i++) { if (evaluate(code)) return; await pause(100); }
  throw new Error(`Timed out: ${code}`);
}
const folder = `阅读侧栏验收${Date.now()}`;
const aPath = `${folder}/甲/笔记.md`, bPath = `${folder}/乙/笔记.md`;
const ids = evaluate(`(async()=>{
  const p=app.plugins.plugins['highnote']; await p.openSidebar();
  await app.vault.createFolder('${folder}');await app.vault.createFolder('${folder}/甲');await app.vault.createFolder('${folder}/乙');
  const source='# 阅读批注'+String.fromCharCode(10,10)+'第一段原文。'+String.fromCharCode(10,10)+'长引用'+ '这是需要完整查看的原文内容。'.repeat(15)+String.fromCharCode(10,10)+'末尾原文。';
  const file=await app.vault.create('${aPath}',source);await app.vault.create('${bPath}',source);
  const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);
  const later=await p.store.create(file.path,source,source.indexOf('长引用'),source.indexOf('末尾')-2,'长评论'+ '评论正文不会被截断。'.repeat(12)+'评论结尾');
  await p.store.reply(later.id,'回复全文'+ '回复不会被截断。'.repeat(8)+'回复结尾');
  const first=await p.store.create(file.path,source,source.indexOf('第一段'),source.indexOf('第一段')+6,'**第一条评论**');
  await p.store.update(first.id,t=>{t.resolved=true});
  const detached=await p.store.create(file.path,source,source.indexOf('末尾'),source.indexOf('末尾')+5,'失效但内容保留');
  await p.store.update(detached.id,t=>{t.anchor.state='detached';t.resolved=true});
  const other=await p.store.create('${bPath}',source,source.indexOf('第一段'),source.indexOf('第一段')+6,'其他文件评论');
  await p.store.update(other.id,t=>{t.anchor.state='detached'});
  const h=await p.store.createHighlight('${bPath}',source,source.indexOf('第一段'),source.indexOf('第一段')+6);
  await p.store.updateHighlights('${bPath}',items=>{items.find(i=>i.id===h.id).anchor.state='detached'});
  await p.showThread(later.id);
  const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;
  v.viewScope='current';v.paneState.comments={status:'all',query:'',unlocatable:false};v.render();
  window.hnSidebarCheck={leaf,source};return {first:first.id,later:later.id,detached:detached.id,other:other.id,h:h.id};
})()`);
const card = id => `[data-thread-id="${id}"]`;
await until(`document.querySelectorAll('.hn-card').length===3`);
assert.deepEqual(evaluate(`[...document.querySelectorAll('.hn-card')].map(e=>e.dataset.threadId)`),[ids.first,ids.later,ids.detached]);
assert.equal(evaluate(`document.querySelector('[aria-label="评论状态"]').value`),'all');
assert.ok(evaluate(`document.querySelector('${card(ids.later)}').textContent.includes('评论结尾') && document.querySelector('${card(ids.later)}').textContent.includes('回复结尾')`));
assert.ok(evaluate(`(()=>{const c=document.querySelector('${card(ids.later)}');return c.querySelector('.hn-quote-block').compareDocumentPosition(c.querySelector('.hn-messages')) & Node.DOCUMENT_POSITION_FOLLOWING})()`));
assert.equal(evaluate(`document.querySelector('${card(ids.later)} .hn-message-body').style.webkitLineClamp`),'');
await until(`!document.querySelector('${card(ids.later)} .hn-quote-expand').hidden`);
const quoteHeight = evaluate(`document.querySelector('${card(ids.later)} .hn-quote').getBoundingClientRect().height`);
assert.ok(quoteHeight < 44);
evaluate(`(()=>{document.querySelector('${card(ids.later)} .hn-quote-expand').click();return true})()`);
assert.ok(evaluate(`document.querySelector('${card(ids.later)} .hn-quote').getBoundingClientRect().height`)>quoteHeight);
assert.equal(evaluate(`app.workspace.getMostRecentLeaf().view.file.path`),aPath);
evaluate(`(()=>{document.querySelector('${card(ids.later)} .hn-quote-expand').click();return true})()`);
assert.equal(evaluate(`document.querySelector('${card(ids.later)} .hn-quote').getBoundingClientRect().height`),quoteHeight);
// Hover must not alter layout; actual pointer events use the client debugger.
evaluate(`(()=>{document.querySelector('${card(ids.later)}').scrollIntoView({block:'center'});return true})()`);
const height = evaluate(`document.querySelector('${card(ids.later)}').getBoundingClientRect().height`);
const point = evaluate(`(()=>{const r=document.querySelector('${card(ids.later)}').getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()`);
call('dev:cdp','method=Input.dispatchMouseEvent',`params=${JSON.stringify({type:'mouseMoved',...point})}`);
assert.equal(evaluate(`document.querySelector('${card(ids.later)}').getBoundingClientRect().height`),height);
const focusStyle=evaluate(`(()=>{const c=document.querySelector('${card(ids.later)}');return {bar:getComputedStyle(c,'::before').backgroundColor,width:getComputedStyle(c,'::before').width,font:getComputedStyle(c.querySelector('.hn-message-body')).fontSize}})()`);
assert.deepEqual(focusStyle,{bar:'rgb(51, 112, 255)',width:'3px',font:'14px'});
// Combining resolved + unlocatable must preserve an accurate denominator and tab totals.
evaluate(`(()=>{const f=document.querySelector('[aria-label="评论状态"]');f.value='resolved';f.dispatchEvent(new Event('change'));const l=document.querySelector('[aria-label="仅看无法定位"]');l.checked=true;l.dispatchEvent(new Event('change'));return true})()`);
assert.deepEqual(evaluate(`[...document.querySelectorAll('.hn-card')].map(e=>e.dataset.threadId)`),[ids.detached]);
assert.equal(evaluate(`document.querySelector('.hn-count').textContent`),'1 / 3 条评论');
assert.equal(evaluate(`document.querySelector('[data-hn-tab="comments"] .hn-tab-count').textContent`),'3');
evaluate(`(()=>{document.querySelector('.hn-clear-filters').click();const f=document.querySelector('[aria-label="评论状态"]');f.value='all';f.dispatchEvent(new Event('change'));const s=document.querySelector('[aria-label="文档范围"]');s.value='all';s.dispatchEvent(new Event('change'));const q=document.querySelector('.hn-search');q.value='${folder}';q.dispatchEvent(new Event('input'));return true})()`);
const groups=evaluate(`[...document.querySelectorAll('.hn-file-group')].map(e=>({label:e.querySelector('.hn-file-name').textContent,hidden:e.querySelector('.hn-file-path').hidden,path:e.querySelector('.hn-file-path').textContent}))`);
assert.equal(groups.length,2);assert.ok(groups.every(g=>g.hidden));
assert.ok(groups.find(g=>g.path===aPath).label.endsWith('甲/笔记.md'));assert.ok(groups.find(g=>g.path===bPath).label.endsWith('乙/笔记.md'));
evaluate(`(()=>{document.querySelector('.hn-file-name').click();return true})()`);
assert.equal(evaluate(`document.querySelector('.hn-file-path').hidden`),false);
const summary=evaluate(`document.querySelector('${card(ids.later)} .hn-summary-body').textContent`);
assert.ok(summary.includes('评论结尾') && summary.includes('回复结尾'));
evaluate(`(()=>{document.querySelector('${card(ids.other)} .hn-summary-body').click();return true})()`);
assert.equal(evaluate(`app.workspace.getMostRecentLeaf().view.file.path`),aPath);
evaluate(`(async()=>{await app.plugins.plugins['highnote'].locate('${ids.other}');return true})()`);
assert.equal(evaluate(`app.workspace.getMostRecentLeaf().view.file.path`),aPath);
evaluate(`(()=>{const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.switchPane('highlights');v.paneState.highlights.query='${folder}';v.render();document.querySelector('[data-highlight-id="${ids.h}"]').click();return true})()`);
await pause(100);
assert.equal(evaluate(`app.workspace.getMostRecentLeaf().view.file.path`),aPath);
assert.equal(evaluate(`document.querySelector('[aria-label="评论状态"]').hidden`),true);
assert.ok(evaluate(`!!document.querySelector('[data-highlight-id="${ids.h}"] time')`));
evaluate(`(async()=>{const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;v.switchPane('comments');v.viewScope='current';v.paneState.comments={status:'all',query:'',unlocatable:false};v.render();await app.plugins.plugins['highnote'].showThread('${ids.later}');document.getSelection().removeAllRanges();return true})()`);
// Clicking comment text selects without changing document position.
const before=evaluate(`(()=>{const e=window.hnSidebarCheck.leaf.view.contentEl.querySelector('.markdown-preview-view');e.scrollTop=100;return e.scrollTop})()`);
evaluate(`(()=>{document.querySelector('${card(ids.first)} .hn-message-body').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));document.querySelector('${card(ids.first)} .hn-message-body').click();return true})()`);
assert.equal(evaluate(`window.hnSidebarCheck.leaf.view.contentEl.querySelector('.markdown-preview-view').scrollTop`),before);
assert.equal(evaluate(`app.plugins.plugins['highnote'].focused`),ids.first);
evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
assert.equal(evaluate(`app.plugins.plugins['highnote'].focused`),'');
if (screenshots) {
  mkdirSync(screenshots,{recursive:true});
  for (const [theme,name,width] of [['theme-light','阅读批注侧栏浅色.png','360px'],['theme-dark','阅读批注侧栏深色.png','360px'],['theme-light','阅读批注侧栏窄栏.png','320px']]) {
    evaluate(`(()=>{document.body.classList.remove('theme-light','theme-dark');document.body.classList.add('${theme}');const root=document.querySelector('.hn-sidebar');root.style.width='${width}';const p=app.plugins.plugins['highnote'];p.focusThread('${ids.first}');root.querySelector('.hn-thread-list').scrollTop=0;return true})()`);
    await pause(150);
    assert.equal(evaluate(`(()=>{const r=document.querySelector('.hn-sidebar');return r.scrollWidth>r.clientWidth+2})()`),false);
    const bytes=evaluate(`(async()=>{return (await require('electron').remote.getCurrentWindow().capturePage()).toPNG().toString('base64')})()`);
    writeFileSync(path.join(screenshots,name),Buffer.from(bytes,'base64'));
  }
  evaluate(`(()=>{document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');document.querySelector('.hn-sidebar').style.width='';return true})()`);
}
evaluate(`(async()=>{const l=window.hnSidebarCheck.leaf;await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'source'},active:true});await app.workspace.revealLeaf(l);return true})()`);
await until(`!app.plugins.plugins['highnote'].canModify && !!document.querySelector('.hn-sidebar.is-readonly')`);
assert.equal(evaluate(`document.querySelectorAll('.hn-inline-reply-input,.hn-thread-more,.hn-message-more,.hn-resolve,.hn-highlight-remove,.hn-selection-toolbar').length`),0);
assert.equal(evaluate(`document.querySelectorAll('.hn-card').length`),3);
evaluate(`(async()=>{const l=window.hnSidebarCheck.leaf;await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});delete window.hnSidebarCheck;return true})()`);
console.log('PASS: full comments/replies; original order; combined filters/counts; collapsed quotes and paths; duplicate names; no navigation on expansion, text click or detached records; stable hover; blue focus; light/dark/320px; readonly guards.');

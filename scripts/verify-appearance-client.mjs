import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-appearance-client.mjs /path/to/obsidian-cli test-vault-name');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8'}).trim();
const evaluate = code => {
  const output = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  if (!output.startsWith('=> ')) throw new Error(output);
  return JSON.parse(output.slice(3));
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for(let i=0;i<60;i++) {if(evaluate(code))return;await wait(100);}
  throw new Error(`Timed out: ${code}`);
}
evaluate(`(async()=>{await app.plugins.plugins['highnote'].openSidebar();return true})()`);
const name = `Appearance-check-${Date.now()}`;
evaluate(`(()=>{const scope=document.querySelector('[aria-label="文档范围"]');scope.value='current';scope.dispatchEvent(new Event('change'));const search=document.querySelector('.hn-search');search.value='';search.dispatchEvent(new Event('input'));return true})()`);
call('create', `name=${name}`, 'content=# 紧凑评论测试\n\n第一段原文。\n\n第二段原文。', 'open');
evaluate(`(async()=>{for(const el of document.querySelectorAll('[data-hn-appearance-check]'))delete el.dataset.hnAppearanceCheck;const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(name)});await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);leaf.view.contentEl.dataset.hnAppearanceCheck='true';return true})()`);
await until(`app.plugins.plugins['highnote'].canModify && !!document.querySelector('[data-hn-appearance-check] .markdown-preview-view p')`);
const ids = evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];const file=app.vault.getFileByPath(${JSON.stringify(name+'.md')});const s=await app.vault.read(file);const a=await p.store.create(file.path,s,s.indexOf('第一段'),s.indexOf('第一段')+6,['评价1','','评论2','','评论3'].join(String.fromCharCode(10)));const b=await p.store.create(file.path,s,s.indexOf('第二段'),s.indexOf('第二段')+6,'第二条讨论');await p.showThread(a.id);return [a.id,b.id]})()`);
await until(`document.querySelectorAll('.hn-card').length===2 && !!document.querySelector('[data-hn-appearance-check] .markdown-preview-view .hn-mark')`);
const [first, second] = ids;
const metrics = evaluate(`(()=>{const card=document.querySelector('[data-thread-id="${first}"]');const body=card.querySelector('.hn-message-body');const style=getComputedStyle(body);return {font:style.fontSize,line:style.lineHeight,gap:card.querySelector('.hn-paragraph-gap').getBoundingClientRect().height,color:getComputedStyle(card,'::before').backgroundColor,barWidth:getComputedStyle(card,'::before').width}})()`);
assert.deepEqual(metrics,{font:'14px',line:'22.4px',gap:3,color:'rgb(51, 112, 255)',barWidth:'3px'});
assert.equal(evaluate(`document.querySelectorAll('.hn-author,.hn-avatar').length`),0);
evaluate(`(()=>{document.querySelector('[data-thread-id="${second}"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return true})()`);
assert.deepEqual(evaluate(`[...document.querySelectorAll('.hn-card-active')].map(card=>card.dataset.threadId)`),[second]);
evaluate(`(()=>{const field=document.querySelector('[data-thread-id="${first}"] .hn-inline-reply-input');field.focus();field.value='聚焦后仍可继续输入';field.dispatchEvent(new Event('input'));return true})()`);
assert.deepEqual(evaluate(`[...document.querySelectorAll('.hn-card-active')].map(card=>card.dataset.threadId)`),[first]);
assert.equal(evaluate(`document.querySelector('[data-thread-id="${first}"] .hn-inline-reply-input').value`),'聚焦后仍可继续输入');
evaluate(`(()=>{document.querySelector('[data-thread-id="${first}"] [aria-label="下一条讨论"]').click();return true})()`);
assert.deepEqual(evaluate(`[...document.querySelectorAll('.hn-card-active')].map(card=>card.dataset.threadId)`),[second]);
evaluate(`(async()=>{await app.plugins.plugins['highnote'].showThread('${first}');return true})()`);
assert.deepEqual(evaluate(`[...document.querySelectorAll('.hn-card-active')].map(card=>card.dataset.threadId)`),[first]);
assert.equal(evaluate(`document.querySelector('[data-thread-id="${first}"] .hn-inline-reply-input').value`),'聚焦后仍可继续输入');
evaluate(`(()=>{require('electron').remote.getCurrentWindow().focus();const p=[...document.querySelectorAll('[data-hn-appearance-check] .markdown-preview-view p')].find(p=>p.textContent==='第一段原文。');const r=document.createRange();r.selectNodeContents(p);const s=document.getSelection();s.removeAllRanges();s.addRange(r);p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));return true})()`);
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
const toolbar = evaluate(`(()=>{const root=document.querySelector('.hn-selection-toolbar');return {width:root.getBoundingClientRect().width,height:root.getBoundingClientRect().height,buttons:root.querySelectorAll('button').length,comment:!!root.querySelector('.hn-selection-comment'),highlight:!!root.querySelector('.hn-selection-highlight'),icons:[...root.querySelectorAll('svg')].map(svg=>({width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height}))}})()`);
assert.deepEqual(toolbar,{width:60,height:30,buttons:2,comment:true,highlight:true,icons:[{width:18,height:18},{width:18,height:18}]});
console.log('PASS: reading compact measurements without author or avatar, 18px icons, dual-button 60x30 toolbar, 3px blank paragraphs, blue active edge, pointer/keyboard/reply focus, navigation, one active card, draft retained.');

import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-inline-client.mjs /path/to/obsidian-cli test-vault-name');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8'}).trim();
const evaluate = code => {
  const output = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  if (!output.startsWith('=> ')) throw new Error(output);
  return JSON.parse(output.slice(3));
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i=0;i<60;i++) { if(evaluate(code)) return; await wait(100); }
  throw new Error(`Timed out: ${code}`);
}
const name = `Inline-check-${Date.now()}`;
call('create', `name=${name}`, 'content=# 输入测试\n\n评论原文。\n\n第二段原文。', 'open');
const id = evaluate(`(async()=>{const p=app.plugins.plugins['highnote'];const file=app.vault.getFileByPath(${JSON.stringify(name+'.md')});const s=await app.vault.read(file);const t=await p.store.create(file.path,s,s.indexOf('评论'),s.indexOf('评论')+4,'原始评论');const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);await p.showThread(t.id);return t.id})()`);
await until(`!!document.querySelector('[data-thread-id="${id}"] .hn-inline-reply-input')`);
const selector = `[data-thread-id="${id}"] .hn-inline-reply-input`;
evaluate(`(()=>{const t=document.querySelector('${selector}');t.focus();t.value='未提交的回复';t.dispatchEvent(new Event('input'));t.setSelectionRange(2,4);return true})()`);
evaluate(`(async()=>{await app.plugins.plugins['highnote'].store.update('${id}',t=>{t.resolved=true});return true})()`);
await wait(200);
assert.deepEqual(evaluate(`(()=>{const t=document.querySelector('${selector}');return {value:t.value,from:t.selectionStart,to:t.selectionEnd,focused:document.activeElement===t}})()`),
  {value:'未提交的回复',from:2,to:4,focused:true});
evaluate(`(()=>{const t=document.querySelector('${selector}');t.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));return true})()`);
await wait(100);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${id}').messages.length`),1);
evaluate(`(()=>{const t=document.querySelector('${selector}');t.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));return true})()`);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${id}').messages.length`),1);
evaluate(`(()=>{const t=document.querySelector('${selector}');t.value=['**完成**','1. 第一项','2. 第二项'].join(String.fromCharCode(10));t.dispatchEvent(new Event('input'));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`);
await until(`document.querySelectorAll('[data-thread-id="${id}"] .hn-message').length===2`);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${id}').messages.length`),2);
assert.equal(evaluate(`document.querySelectorAll('[data-thread-id="${id}"] .hn-message-body ol li').length`),2);
assert.equal(evaluate(`document.querySelector('${selector}').value`),'');
const times = evaluate(`[...document.querySelectorAll('[data-thread-id="${id}"] time')].map(t=>({text:t.textContent,title:t.title}))`);
assert.ok(times.every(t=>/\d+月\d+日 \d{2}:\d{2}/u.test(t.text)&&t.title.includes('年')));
evaluate(`(()=>{document.querySelector('[data-thread-id="${id}"] .hn-message-more').click();return true})()`);
await until(`!![...document.querySelectorAll('.menu-item')].find(e=>e.textContent.trim()==='编辑')`);
evaluate(`(()=>{[...document.querySelectorAll('.menu-item')].find(e=>e.textContent.trim()==='编辑').click();const t=document.querySelector('.hn-modal textarea');t.value='修改后的评论';t.dispatchEvent(new Event('input'));document.querySelector('.hn-modal .mod-cta').click();return true})()`);
await until(`document.querySelector('[data-thread-id="${id}"]').textContent.includes('（编辑过）')`);
const edited = evaluate(`(()=>{const card=document.querySelector('[data-thread-id="${id}"]');return {shown:card.querySelector('time').getAttribute('datetime'),stored:app.plugins.plugins['highnote'].store.get('${id}').messages[0].updatedAt}})()`);
assert.equal(edited.shown, edited.stored);
evaluate(`(()=>{const t=document.querySelector('${selector}');t.focus();t.value='取消草稿';t.dispatchEvent(new Event('input'));document.querySelector('[data-thread-id="${id}"] .hn-inline-cancel').click();return true})()`);
assert.equal(evaluate(`document.querySelector('${selector}').value`),'');
assert.equal(evaluate(`document.querySelectorAll('.hn-message-actions,.hn-card-actions,.hn-reply-reference').length`),0);
assert.equal(evaluate(`document.querySelectorAll('.hn-thread-more').length`),0);
console.log('PASS: inline reply, drafts/caret, IME, formatting, dates, edited indicator, cancel and individual message menus without whole-discussion deletion.');

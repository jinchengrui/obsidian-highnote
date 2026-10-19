import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
// Run only against a disposable vault. This creates and deletes its own test note.
const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-client.mjs /path/to/obsidian-cli test-vault-name');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8'}).trim();
const evaluate = code => {
  const output = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  if (!output.startsWith('=> ')) throw new Error(output);
  return JSON.parse(output.slice(3));
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i=0;i<60;i++) {if (evaluate(code)) return; await wait(100);}
  throw new Error(`Timed out: ${code}`);
}
const prefix = `Highnote-check-${Date.now()}`;
evaluate(`(()=>{const scope=document.querySelector('[aria-label="文档范围"]');if(scope){scope.value='current';scope.dispatchEvent(new Event('change'));const search=document.querySelector('.hn-search');search.value='';search.dispatchEvent(new Event('input'));}return true})()`);
call('create', `name=${prefix}`, 'content=# 测试笔记\n\n这段原文用于客户端回归检查。', 'open');
await wait(300);
evaluate(`(()=>{require('electron').remote.getCurrentWindow().focus();return true})()`);
await wait(150);
evaluate(`(async()=>{const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(prefix)});await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);return true})()`);
await until(`!![...document.querySelectorAll('.markdown-preview-view p')].find(e=>e.textContent==='这段原文用于客户端回归检查。')`);
evaluate(`(()=>{const p=[...document.querySelectorAll('.markdown-preview-view p')].find(e=>e.textContent==='这段原文用于客户端回归检查。');const r=document.createRange();r.selectNodeContents(p);document.getSelection().removeAllRanges();document.getSelection().addRange(r);p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));return true})()`);
await until(`!!document.querySelector('.hn-selection-comment')`);
evaluate(`(()=>{document.querySelector('.hn-selection-comment').click();return true})()`);
await until(`!!document.querySelector('.hn-modal textarea')`);
evaluate(`(()=>{const t=document.querySelector('.hn-modal textarea');t.value='**回归评论**\\n- 检查保存';t.dispatchEvent(new Event('input'));document.querySelector('.hn-modal .mod-cta').click();return true})()`);
await until(`app.plugins.plugins['highnote'].store.all().some(t=>t.filePath===${JSON.stringify(prefix+'.md')})`);
const id=evaluate(`app.plugins.plugins['highnote'].store.all().find(t=>t.filePath===${JSON.stringify(prefix+'.md')}).id`);
await until(`document.querySelectorAll('[data-thread-id="${id}"] .hn-message').length===1`);
for (const [index, body] of [[0,'回复一'],[1,'二次回复']]) {
  const selector = `[data-thread-id="${id}"] .hn-inline-reply-input`;
  evaluate(`(()=>{const t=document.querySelector('${selector}');t.value=${JSON.stringify(body)};t.dispatchEvent(new Event('input'));document.querySelector('[data-thread-id="${id}"] .hn-inline-send').click();return true})()`);
  await until(`document.querySelectorAll('[data-thread-id="${id}"] .hn-message').length===${index+2}`);
}
evaluate(`(()=>{document.querySelectorAll('[data-thread-id="${id}"] .hn-message-more')[1].click();return true})()`);
await until(`!![...document.querySelectorAll('.menu-item')].find(e=>e.textContent.trim()==='删除')`);
evaluate(`(()=>{[...document.querySelectorAll('.menu-item')].find(e=>e.textContent.trim()==='删除').click();document.querySelector('.modal .mod-warning').click();return true})()`);
await until(`document.querySelectorAll('[data-thread-id="${id}"] .hn-message').length===2`);
assert.equal(evaluate(`document.querySelector('[data-thread-id="${id}"]').textContent.includes('该消息已删除')`),false);
assert.equal(evaluate(`document.querySelectorAll('[data-thread-id="${id}"] .hn-reply-reference').length`),0);
const saved=evaluate(`app.plugins.plugins['highnote'].store.get('${id}')`);
assert.equal('replyTo' in saved.messages[2],false);
assert.equal(saved.messages[1].body,'');
call('plugin:reload','id=highnote');
await until(`app.plugins.plugins['highnote'].store.get('${id}')?.messages.length===3`);
call('rename',`path=${prefix}.md`,`name=${prefix}-renamed`);
await until(`app.plugins.plugins['highnote'].store.get('${id}')?.filePath===${JSON.stringify(prefix+'-renamed.md')}`);
call('delete',`path=${prefix}-renamed.md`);
await until(`app.plugins.plugins['highnote'].store.get('${id}')?.fileMissing===true`);
assert.equal(evaluate(`app.plugins.plugins['highnote'].store.get('${id}').anchor.state`),'detached');
console.log('PASS: create, formatting input, flat replies, deleted message hidden, reload, rename, source deletion.');

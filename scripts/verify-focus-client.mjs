import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli, vault, screenshots] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-focus-client.mjs /path/to/obsidian-cli test-vault-name [screenshots-directory]');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8'}).trim();
const evaluate = code => {
  const output=call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  if (!output.startsWith('=> ')) throw new Error(output);
  return JSON.parse(output.slice(3));
};
const cdp=(method,params={})=>JSON.parse(call('dev:cdp',`method=${method}`,`params=${JSON.stringify(params)}`));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(code) {
  for(let i=0;i<60;i++){if(evaluate(code))return;await pause(100);}
  throw new Error(`Timed out: ${code}`);
}
const name=`Focus-check-${Date.now()}`;
const ids=evaluate(`(async()=>{
  for(const el of document.querySelectorAll('[data-hn-focus-check]'))delete el.dataset.hnFocusCheck;
  const p=app.plugins.plugins['highnote'];
  const source='# 评论聚焦测试'+String.fromCharCode(10,10)+'第一段原文用于评论。'+String.fromCharCode(10,10)+'第二段原文用于评论。'+String.fromCharCode(10,10)+'普通正文可以继续编辑。'+String.fromCharCode(10,10)+Array.from({length:80},(_,i)=>'正文段落 '+i).join(String.fromCharCode(10,10));
  const file=await app.vault.create(${JSON.stringify(name+'.md')},source);
  const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);
  await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);leaf.view.contentEl.dataset.hnFocusCheck='true';
  const a=await p.store.create(file.path,source,source.indexOf('第一段'),source.indexOf('第一段')+10,'评论一');
  const b=await p.store.create(file.path,source,source.indexOf('第二段'),source.indexOf('第二段')+10,'评论二');
  await p.showThread(a.id);
  const scope=document.querySelector('[aria-label="文档范围"]');scope.value='current';scope.dispatchEvent(new Event('change'));
  document.activeElement?.blur();return [a.id,b.id];
})()`);
const [first,second]=ids;
const card=id=>`[data-thread-id="${id}"]`;
const mark=id=>`[data-hn-thread="${id}"]`;
await until(`app.plugins.plugins['highnote'].canModify && document.querySelectorAll('.hn-card').length===2 && !!document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}') && !!document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(second)}')`);
function pointer(selector) {
  evaluate(`(()=>{document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));return true})()`);
}
function focused(id) {
  assert.equal(evaluate(`app.plugins.plugins['highnote'].focused`),id);
  assert.deepEqual(evaluate(`[...document.querySelectorAll('.hn-card-active')].map(e=>e.dataset.threadId)`),id?[id]:[]);
}
function styles(id) {
  return evaluate(`(()=>{const card=document.querySelector('${card(id)}');const quote=card.querySelector('.hn-quote');const mark=document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(id)}');return {card:getComputedStyle(card).backgroundColor,quote:getComputedStyle(quote).backgroundColor,line:getComputedStyle(quote,'::before').backgroundColor,top:getComputedStyle(card,'::before').content,mark:mark?getComputedStyle(mark).backgroundColor:null,underline:mark?getComputedStyle(mark).textDecorationLine:null}})()`);
}
pointer('.hn-tabs');focused('');
assert.equal(styles(first).quote,'rgba(0, 0, 0, 0)');assert.equal(styles(first).top,'none');
assert.equal(styles(first).mark,'rgba(0, 0, 0, 0)');assert.deepEqual(styles(first),styles(second));
assert.equal(styles(first).underline,'underline');
pointer(card(first));focused(first);
assert.notEqual(styles(first).mark,'rgba(0, 0, 0, 0)');assert.notEqual(styles(first).card,styles(second).card);
assert.equal(styles(first).underline,'underline');assert.equal(styles(second).underline,'underline');
assert.equal(styles(second).top,'none');assert.equal(styles(second).mark,'rgba(0, 0, 0, 0)');
pointer(card(second));focused(second);assert.equal(styles(first).mark,'rgba(0, 0, 0, 0)');
const scroll=evaluate(`(()=>{const e=document.querySelector('[data-hn-focus-check] .markdown-preview-view');e.scrollTop=350;return e.scrollTop})()`);
assert.ok(scroll>0);
pointer(card(first));focused(first);assert.equal(evaluate(`document.querySelector('[data-hn-focus-check] .markdown-preview-view').scrollTop`),scroll);
evaluate(`(()=>{document.querySelector('${card(first)} .hn-quote').click();return true})()`);
await until(`document.querySelector('[data-hn-focus-check] .markdown-preview-view').scrollTop<${scroll}`);focused(first);
pointer('.hn-tabs');focused('');
evaluate(`(()=>{const e=document.querySelector('[data-hn-focus-check] .markdown-preview-view');e.scrollTop=0;return true})()`);await pause(100);
pointer('[data-hn-focus-check] .markdown-preview-view');focused('');
pointer(card(first));pointer('[data-hn-focus-check] .markdown-preview-view');focused('');
pointer(mark(first));
evaluate(`(()=>{document.getSelection().removeAllRanges();document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}').click();return true})()`);
await until(`app.plugins.plugins['highnote'].focused==='${first}'`);focused(first);
evaluate(`(()=>{const field=document.querySelector('${card(first)} textarea');field.focus();field.value='回复时保留高亮';field.dispatchEvent(new Event('input'));return true})()`);
focused(first);
evaluate(`(()=>{document.activeElement?.blur();return true})()`);
pointer('.hn-thread-list');focused('');
evaluate(`(()=>{document.activeElement?.blur();return true})()`);
assert.equal(evaluate(`document.querySelector('${card(first)} textarea').value`),'回复时保留高亮');
evaluate(`(()=>{document.querySelector('${card(first)} textarea').focus();return true})()`);focused(first);
evaluate(`(()=>{document.querySelector('${card(first)} textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true})()`);focused('');
assert.equal(evaluate(`document.querySelector('${card(first)} textarea').value`),'回复时保留高亮');
assert.equal(styles(first).mark,'rgba(0, 0, 0, 0)');assert.equal(styles(first).underline,'underline');
evaluate(`(()=>{document.querySelector('${card(first)} .hn-inline-cancel').click();return true})()`);
evaluate(`(()=>{const scope=document.querySelector('[aria-label="文档范围"]');scope.value='all';scope.dispatchEvent(new Event('change'));return true})()`);
evaluate(`(()=>{const view=app.workspace.getLeavesOfType('highnote-comments')[0].view;view.page=Math.max(1,Math.ceil(view.visibleThreads.indexOf('${second}')/40)+1);view.render();return true})()`);
pointer(card(second));focused(second);
assert.equal(evaluate(`document.querySelector('${card(second)}').classList.contains('hn-summary')`),true);
evaluate(`(()=>{document.querySelector('${card(second)} .hn-summary-body').click();return true})()`);focused(second);
assert.equal(evaluate(`document.querySelector('${card(second)}').classList.contains('hn-summary')`),false);
assert.equal(evaluate(`!!document.querySelector('${card(second)} .hn-overview-collapse') && !!document.querySelector('${card(second)} .hn-inline-reply-input')`),true);
pointer('.hn-tabs');focused('');
evaluate(`(()=>{const scope=document.querySelector('[aria-label="文档范围"]');scope.value='current';scope.dispatchEvent(new Event('change'));return true})()`);
evaluate(`(async()=>{const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(name)});await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(l);l.view.contentEl.dataset.hnFocusCheck='true';return true})()`);
await until(`!!document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}')`);
pointer('.hn-tabs');focused('');
evaluate(`(()=>{document.getSelection().removeAllRanges();document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}').click();return true})()`);
await until(`app.plugins.plugins['highnote'].focused==='${first}'`);focused(first);
const selection=evaluate(`(()=>{const node=document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}');const r=document.createRange();r.selectNodeContents(node);const s=document.getSelection();s.removeAllRanges();s.addRange(r);window.hnFocusNode=node;return s.toString()})()`);
pointer(card(second));focused(second);
await pause(150);
assert.deepEqual(evaluate(`({text:document.getSelection().toString(),same:window.hnFocusNode.isConnected})`),{text:selection,same:true});
assert.equal(evaluate(`getComputedStyle(document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}')).backgroundColor`),'rgba(0, 0, 0, 0)');
assert.equal(styles(first).underline,'underline');assert.equal(styles(second).underline,'underline');
evaluate(`(()=>{document.getSelection().removeAllRanges();delete window.hnFocusNode;return true})()`);
const plain=evaluate(`[...document.querySelectorAll('[data-hn-focus-check] .markdown-preview-view p')].find(e=>e.textContent==='普通正文可以继续编辑。')?.textContent`);
assert.ok(plain);pointer('[data-hn-focus-check] .markdown-preview-view');focused('');
pointer(card(first));focused(first);
cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});focused(first);
if(screenshots)mkdirSync(screenshots,{recursive:true});
function screenshot(name) {
  if(!screenshots)return;
  const clip=evaluate(`(()=>{const r=document.querySelector('.workspace-split.mod-root').getBoundingClientRect();return {x:r.x,y:r.y,width:window.innerWidth-r.x,height:r.height,scale:1}})()`);
  writeFileSync(path.join(screenshots,name),Buffer.from(cdp('Page.captureScreenshot',{format:'png',clip}).data,'base64'));
}
screenshot('评论选中与原文高亮.png');
pointer('.hn-tabs');screenshot('评论未选中效果.png');
pointer(card(first));evaluate(`(()=>{document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');return true})()`);
assert.notEqual(evaluate(`getComputedStyle(document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}')).backgroundColor`),'rgba(0, 0, 0, 0)');
screenshot('评论选中深色效果.png');
evaluate(`(()=>{document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');return true})()`);
evaluate(`(async()=>{const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(name)});await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'source'},active:true});await app.workspace.revealLeaf(l);l.view.contentEl.dataset.hnFocusCheck='true';return true})()`);
await until(`!app.plugins.plugins['highnote'].canModify && !!document.querySelector('[data-hn-focus-check] .cm-content') && !!document.querySelector('.hn-sidebar.is-readonly') && document.querySelectorAll('.hn-card').length===2 && !document.querySelector('.hn-inline-reply,.hn-inline-reply-input,.hn-thread-more,.hn-message-more,.hn-resolve')`);
assert.equal(evaluate(`document.querySelectorAll('[data-hn-focus-check] .cm-editor .hn-mark,[data-hn-focus-check] .cm-editor .hn-highlight,.hn-selection-toolbar').length`),0);
pointer(card(second));focused(second);
assert.equal(evaluate(`document.querySelector('${card(second)} .hn-message-body').textContent`),'评论二');
pointer('[data-hn-focus-check] .cm-content');focused('');
evaluate(`(async()=>{const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(name)});await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(l);l.view.contentEl.dataset.hnFocusCheck='true';return true})()`);
await until(`app.plugins.plugins['highnote'].canModify && !!document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}') && !!document.querySelector('${card(first)} .hn-inline-reply-input')`);
evaluate(`(()=>{window.hnFocusPreviousPlugin=app.plugins.plugins['highnote'];return true})()`);
call('plugin:reload','id=highnote');await until(`!!app.plugins.plugins['highnote'].store.get('${first}')`);
await until(`!!document.querySelector('${card(first)}') && !!document.querySelector('[data-hn-focus-check] .markdown-preview-view ${mark(first)}')`);pointer(card(first));pointer('.hn-tabs');focused('');
assert.deepEqual(evaluate(`(()=>{const p=window.hnFocusPreviousPlugin;delete window.hnFocusPreviousPlugin;return {documents:p.interactionDocuments.size,reading:p.readingViews.size,editor:p.editorViews.size}})()`),{documents:0,reading:0,editor:0});
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
assert.equal(evaluate(`app.plugins.plugins['highnote'].interactionDocuments.size`),1);
console.log('PASS: neutral inactive cards/quotes, linked reading highlights and persistent underlines, single selection, outside-click/Escape clearing, preserved reply draft and reading selection, no reading card-click scrolling, overview expansion, source without decorations or reply/menu/resolve controls, hover persistence, light/dark screenshots, reload cleanup.');

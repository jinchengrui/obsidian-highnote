import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-selection-client.mjs /path/to/obsidian-cli test-vault-name');
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
const name = `Selection-check-${Date.now()}`;
call('create', `name=${name}`, 'content=# 浮动评论测试\n\n选中文字后自动浮出评论按钮。\n\n第二段用于重新选择。', 'open');
await pause(300);
evaluate(`(()=>{for(const el of document.querySelectorAll('[data-hn-selection-check]'))delete el.dataset.hnSelectionCheck;require('electron').remote.getCurrentWindow().focus();return true})()`);
await pause(150);
async function mode(value) {
  evaluate(`(async()=>{const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(name)});await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:${JSON.stringify(value)}},active:true});await app.workspace.revealLeaf(l);l.view.contentEl.dataset.hnSelectionCheck='true';return true})()`);
  await pause(200);
  await until(`app.plugins.plugins['highnote'].canModify===${value === 'preview'}`);
  if (value === 'preview') await until(`!!document.querySelector('[data-hn-selection-check] .markdown-preview-view p')`);
}
function selectEditor() {
  evaluate(`(()=>{const v=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(name)}).view;v.editor.focus();const s=v.editor.getValue();const from=s.indexOf('选中文字');v.editor.setSelection(v.editor.offsetToPos(from),v.editor.offsetToPos(s.indexOf('。',from)+1));v.contentEl.querySelector('.cm-editor').dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',shiftKey:true,bubbles:true}));return true})()`);
}
function selectReading() {
  evaluate(`(()=>{const p=[...document.querySelectorAll('[data-hn-selection-check] .markdown-preview-view p')].find(p=>p.textContent==='选中文字后自动浮出评论按钮。');const r=document.createRange();r.selectNodeContents(p);const s=document.getSelection();s.removeAllRanges();s.addRange(r);p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));return true})()`);
}
await mode('source');
selectEditor();
await pause(250);
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
assert.equal(evaluate(`document.querySelectorAll('[data-hn-selection-check] .cm-editor .hn-mark,[data-hn-selection-check] .cm-editor .hn-highlight').length`),0);
assert.equal(evaluate(`app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.basename===${JSON.stringify(name)}).view.editor.getSelection()`),'选中文字后自动浮出评论按钮。');
await mode('preview');
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
assert.deepEqual(evaluate(`(()=>{const root=document.querySelector('.hn-selection-toolbar');return {buttons:root.querySelectorAll('button').length,comment:!!root.querySelector('.hn-selection-comment'),highlight:!!root.querySelector('.hn-selection-highlight'),width:root.getBoundingClientRect().width,height:root.getBoundingClientRect().height,icons:[...root.querySelectorAll('svg')].map(svg=>({width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height}))}})()`),{buttons:2,comment:true,highlight:true,width:60,height:30,icons:[{width:18,height:18},{width:18,height:18}]});
const preserved=evaluate(`(()=>{const b=document.querySelector('.hn-selection-comment');const down=new PointerEvent('pointerdown',{bubbles:true,cancelable:true});const mouse=new MouseEvent('mousedown',{bubbles:true,cancelable:true});b.dispatchEvent(down);b.dispatchEvent(mouse);const text=document.getSelection().toString();b.click();return {text,pointerPrevented:down.defaultPrevented,mousePrevented:mouse.defaultPrevented}})()`);
assert.deepEqual(preserved,{text:'选中文字后自动浮出评论按钮。',pointerPrevented:true,mousePrevented:true});
await until(`!!document.querySelector('.hn-modal textarea')`);
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
evaluate(`(()=>{const t=document.querySelector('.hn-modal textarea');t.value='浮动按钮保存成功';t.dispatchEvent(new Event('input'));document.querySelector('.hn-modal .mod-cta').click();return true})()`);
await until(`app.plugins.plugins['highnote'].store.all().some(t=>t.filePath===${JSON.stringify(name+'.md')})`);
await until(`!document.querySelector('.hn-modal textarea')`);
const id=evaluate(`app.plugins.plugins['highnote'].store.all().find(t=>t.filePath===${JSON.stringify(name+'.md')}).id`);
assert.deepEqual(evaluate(`(()=>{const t=app.plugins.plugins['highnote'].store.get('${id}');return {quote:t.anchor.quote,body:t.messages[0].body}})()`),{quote:'选中文字后自动浮出评论按钮。',body:'浮动按钮保存成功'});
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
evaluate(`(()=>{document.querySelector('[data-hn-selection-check] .markdown-preview-view').dispatchEvent(new Event('scroll'));return true})()`);
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
await mode('source');
selectEditor();
await pause(250);
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar,[data-hn-selection-check] .cm-editor .hn-mark,[data-hn-selection-check] .cm-editor .hn-highlight').length`),0);
await mode('preview');
for (let i=0;i<3;i++) {
  selectReading();
  await pause(250);
  assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),1);
  evaluate(`(()=>{window.hnSelectionPreviousPlugin=app.plugins.plugins['highnote'];return true})()`);
  call('plugin:reload','id=highnote');
  await until(`!!app.plugins.plugins['highnote']?.store.get('${id}')`);
  await pause(250);
  assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
  assert.deepEqual(evaluate(`(()=>{const p=window.hnSelectionPreviousPlugin;delete window.hnSelectionPreviousPlugin;return {documents:p.interactionDocuments.size,reading:p.readingViews.size,editor:p.editorViews.size}})()`),{documents:0,reading:0,editor:0});
}
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
evaluate(`(()=>{document.querySelector('.hn-selection-comment').click();return true})()`);
await until(`!!document.querySelector('.hn-modal textarea')`);
evaluate(`(()=>{for(const m of app.plugins.plugins['highnote'].openModals)m.close();document.getSelection().removeAllRanges();return true})()`);
await pause(150);
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
assert.equal(evaluate(`document.querySelectorAll('.hn-reading-controls,.hn-reply-reference').length`),0);
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
evaluate(`(()=>{document.getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));return true})()`);
await until(`document.querySelectorAll('.hn-selection-toolbar').length===0`);
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
call('plugin:disable','id=highnote');
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar,.hn-mark').length`),0);
call('plugin:enable','id=highnote');
await until(`!!app.plugins.plugins['highnote'].store.get('${id}')`);
assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`),0);
await until(`[...app.plugins.plugins['highnote'].readingViews].some(v=>v.containerEl.closest('[data-hn-selection-check]'))`);
selectReading();
await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`);
evaluate(`(()=>{document.getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));return true})()`);
await until(`document.querySelectorAll('.hn-selection-toolbar').length===0`);
console.log('PASS: source selection without toolbar/decorations, reading automatic dual-button 60x30 toolbar and 18px icons, preserved selection, save, Escape, scroll, mode switch/repeated reload cleanup, selection collapse, disabled cleanup, no reply quote boxes.');

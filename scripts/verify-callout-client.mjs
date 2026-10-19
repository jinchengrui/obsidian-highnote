import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-callout-client.mjs obsidian-cli test-vault');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding: 'utf8', timeout: 15000});
const evaluate = code => {
  const output = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  const line = output.split('\n').find(value => value.startsWith('=> '));
  if (!line) throw new Error(output);
  return JSON.parse(line.slice(3));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 40; i++) { if (evaluate(code)) return; await pause(100); }
  throw new Error(`Timed out: ${code}`);
}
const name = `Highnote-callout-check-${Date.now()}.md`;
const source = '# 提示块选区回归\n\n> [!tip] 判断标准\n>\n> 一个真正有效的微习惯，是你**生病发烧时**也能完成的版本。\n>\n> 先说明**目标文字**，再说明**目标文字**。\n\n> [!note]+ 重复目标文字\n>\n> 目标文字之外的内容。\n\n> [!note]- 折叠提示块\n> 前文**加粗文字**后文。';
const paragraph = index => `[...window.hnCalloutCheck.leaf.view.contentEl.querySelectorAll('.markdown-preview-view .callout-content p')][${index}]`;
async function select(index, rangeCode) {
  evaluate(`(()=>{${paragraph(index)}.scrollIntoView({block:'center'});return true})()`);
  await pause(100);
  const selected = evaluate(`(()=>{const p=${paragraph(index)};p.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));const r=document.createRange();${rangeCode}const s=document.getSelection();s.removeAllRanges();s.addRange(r);p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));return s.toString()})()`);
  await until(`!!document.querySelector('.hn-selection-toolbar')`);
  return selected;
}
const marks = (id, type) => evaluate(`[...window.hnCalloutCheck.leaf.view.contentEl.querySelectorAll('.markdown-preview-view [data-hn-${type}="${id}"]')].map(e=>e.textContent).join('')`);
try {
  evaluate(`(async()=>{if(window.hnCalloutCheck)throw new Error('Callout check already running');const layout=app.workspace.getLayout();window.hnCalloutCheck={layout,path:${JSON.stringify(name)}};const file=await app.vault.create(${JSON.stringify(name)},${JSON.stringify(source)});const leaf=app.workspace.getLeaf('tab');window.hnCalloutCheck.leaf=leaf;await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);return true})()`);
  await until(`app.plugins.plugins.highnote.canModify && !!${paragraph(0)}`);
  // Simulate a still-pending cachedRead; selection must use the rendered snapshot.
  evaluate(`(()=>{for(const view of app.plugins.plugins.highnote.readingViews){if(window.hnCalloutCheck.leaf.view.contentEl.contains(view.containerEl))view.source='';}return true})()`);
  assert.equal(await select(0, 'r.selectNodeContents(p);'), '一个真正有效的微习惯，是你生病发烧时也能完成的版本。');
  evaluate(`(()=>{document.querySelector('.hn-selection-comment').click();return true})()`);
  await until(`!!document.querySelector('.hn-modal textarea')`);
  evaluate(`(()=>{const input=document.querySelector('.hn-modal textarea');input.focus();input.value='提示块评论';input.dispatchEvent(new Event('input'));document.querySelector('.hn-modal .mod-cta').click();return true})()`);
  await until(`!document.querySelector('.hn-modal textarea') && app.plugins.plugins.highnote.fileThreads(${JSON.stringify(name)}).length===1`);
  const thread = evaluate(`app.plugins.plugins.highnote.fileThreads(${JSON.stringify(name)})[0]`);
  assert.equal(thread.anchor.quote, '一个真正有效的微习惯，是你**生病发烧时**也能完成的版本。');
  assert.equal(source.slice(thread.anchor.from, thread.anchor.to), thread.anchor.quote);
  evaluate(`(()=>{document.getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));return true})()`);
  await until(`!!window.hnCalloutCheck.leaf.view.contentEl.querySelector('.markdown-preview-view .hn-mark')`);
  assert.equal(marks(thread.id, 'thread'), '一个真正有效的微习惯，是你生病发烧时也能完成的版本。');

  await select(1, 'r.selectNodeContents(p.querySelectorAll("strong")[1]);');
  evaluate(`(()=>{document.querySelector('.hn-selection-highlight').click();return true})()`);
  await until(`app.plugins.plugins.highnote.fileHighlights(${JSON.stringify(name)}).length===1`);
  const highlight = evaluate(`app.plugins.plugins.highnote.fileHighlights(${JSON.stringify(name)})[0]`);
  assert.equal(highlight.anchor.from, source.indexOf('再说明**') + 5);
  await until(`!!${paragraph(1)}.querySelectorAll('strong')[1].querySelector('.hn-highlight')`);
  assert.equal(evaluate(`${paragraph(1)}.querySelectorAll('strong')[0].querySelectorAll('.hn-highlight').length`), 0);

  // Text-node endpoints and the command route share the same source mapping.
  await select(2, 'r.setStart(p.firstChild,0);r.setEnd(p.firstChild,4);');
  evaluate(`(()=>{app.commands.executeCommandById('highnote:add-highlight');return true})()`);
  await until(`app.plugins.plugins.highnote.fileHighlights(${JSON.stringify(name)}).length===2`);
  const body = evaluate(`app.plugins.plugins.highnote.fileHighlights(${JSON.stringify(name)}).find(h=>h.id!==${JSON.stringify(highlight.id)})`);
  assert.equal(body.anchor.from, source.lastIndexOf('目标文字'));
  call('plugin:reload', 'id=highnote');
  await until(`!!app.plugins.plugins.highnote?.store.get(${JSON.stringify(thread.id)})`);
  await until(`!!window.hnCalloutCheck.leaf.view.contentEl.querySelector('.markdown-preview-view .hn-mark')`);
  assert.equal(marks(thread.id, 'thread'), '一个真正有效的微习惯，是你生病发烧时也能完成的版本。');
  assert.equal(marks(highlight.id, 'highlight'), '目标文字');
  assert.equal(marks(body.id, 'highlight'), '目标文字');

  // Expanded callouts with a collapse marker use the same mapping.
  evaluate(`(()=>{window.hnCalloutCheck.leaf.view.contentEl.querySelector('.markdown-preview-view .callout.is-collapsed .callout-title').click();return true})()`);
  await until(`${paragraph(3)}.getBoundingClientRect().height>0`);
  await select(3, 'r.setStart(p.firstChild,1);r.setEnd(p.lastChild,1);');
  evaluate(`(()=>{document.querySelector('.hn-selection-comment').click();return true})()`);
  await until(`!!document.querySelector('.hn-modal textarea')`);
  evaluate(`(()=>{for(const modal of app.plugins.plugins.highnote.openModals)modal.close();document.getSelection().removeAllRanges();return true})()`);

  evaluate(`(async()=>{const leaf=window.hnCalloutCheck.leaf;await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'source'},active:true});return true})()`);
  await until(`!app.plugins.plugins.highnote.canModify`);
  assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`), 0);
  console.log('PASS: callout bold selection, comment save, correct repeated highlight, title/body disambiguation, command route, reload decorations, folded callout partial range, edit-mode guard.');
} finally {
  evaluate(`(async()=>{const state=window.hnCalloutCheck;if(!state)return false;document.getSelection().removeAllRanges();const plugin=app.plugins.plugins.highnote;for(const modal of plugin.openModals)modal.close();for(const h of plugin.fileHighlights(state.path))await plugin.store.removeHighlight(h.id);for(const t of plugin.fileThreads(state.path))await plugin.store.remove(t.id);state.leaf?.detach();const file=app.vault.getFileByPath(state.path);if(file)await app.vault.delete(file);await app.workspace.changeLayout(state.layout);delete window.hnCalloutCheck;return true})()`);
}

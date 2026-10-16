import {execFileSync} from 'node:child_process';
import {writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli, vault, screenshots] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-personal-client.mjs /path/to/obsidian-cli test-vault-name [screenshots-directory]');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8'}).trim();
const evaluate = code => {
  const output = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  if (!output.startsWith('=> ')) throw new Error(output);
  return JSON.parse(output.slice(3));
};
const cdp = (method, params = {}) => JSON.parse(call('dev:cdp', `method=${method}`, `params=${JSON.stringify(params)}`));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i=0;i<60;i++) {if(evaluate(code))return;await pause(100);}
  throw new Error(`Timed out: ${code}`);
}
evaluate(`(async()=>{await app.plugins.plugins['highnote'].openSidebar();return true})()`);
const name = `Personal-check-${Date.now()}`;
const id = evaluate(`(async()=>{
  const p=app.plugins.plugins['highnote'];
  const file=await app.vault.create(${JSON.stringify(name+'.md')},'任务可逆。另一段原文。');
  const noteLeaf=app.workspace.getLeaf('tab');await noteLeaf.openFile(file);await noteLeaf.setViewState({type:'markdown',state:{...noteLeaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(noteLeaf);
  const first=await p.store.create(file.path,'任务可逆。另一段原文。',0,4,'评论1'+String.fromCharCode(10)+'评论2'+String.fromCharCode(10)+'评论3');
  await p.store.reply(first.id,'123');await p.store.reply(first.id,'456');await p.store.reply(first.id,'最后一条回复');
  await p.store.create(file.path,'任务可逆。另一段原文。',5,10,'下一条讨论');
  await p.showThread(first.id);
  const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;
  const scope=document.querySelector('[aria-label="文档范围"]');scope.value='current';scope.dispatchEvent(new Event('change'));document.activeElement?.blur();
  return first.id;
})()`);
await until(`document.querySelectorAll('.hn-card').length===2`);
await pause(200);
const selector = `[data-thread-id="${id}"]`;
let hoverNode = 0;
function hover(on) {
  const point = on ? evaluate(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()`) : {x:0,y:0};
  cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
}
function metrics() {
  return evaluate(`(()=>{
    const card=document.querySelector('${selector}');const reply=card.querySelector('.hn-inline-reply');
    const input=reply.querySelector('textarea');const body=card.querySelector('.hn-message-body');
    return {height:card.getBoundingClientRect().height,nextTop:card.nextElementSibling.getBoundingClientRect().top,
      replyHeight:reply.getBoundingClientRect().height,opacity:getComputedStyle(reply).opacity,
      border:getComputedStyle(reply).borderTopWidth,inputBorder:getComputedStyle(input).borderTopWidth,
      bodyLeft:body.getBoundingClientRect().left,inputLeft:input.getBoundingClientRect().left,
      expanded:reply.classList.contains('is-expanded'),overflow:card.scrollWidth>card.clientWidth+2};
  })()`);
}
cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
hover(false);
const idle=metrics();
assert.equal(idle.opacity,'0');assert.equal(idle.replyHeight,22);assert.equal(idle.border,'0px');
assert.equal(idle.inputBorder,'0px');assert.equal(idle.bodyLeft,idle.inputLeft);assert.equal(idle.expanded,false);
assert.equal(evaluate(`document.querySelectorAll('.hn-author,.hn-avatar').length`),0);
assert.equal(evaluate(`document.querySelector('${selector}').textContent.includes('我')`),false);
for (let i=0;i<6;i++) {
  hover(true);
  assert.deepEqual(metrics(),{...idle,opacity:'1'});
  hover(false);
  assert.deepEqual(metrics(),idle);
}
if (screenshots) mkdirSync(screenshots,{recursive:true});
function screenshot(name) {
  if (!screenshots) return;
  const clip=evaluate(`(()=>{const root=document.querySelector('.hn-sidebar').getBoundingClientRect();return {x:root.x,y:root.y,width:root.width,height:root.height,scale:1}})()`);
  writeFileSync(path.join(screenshots,name),Buffer.from(cdp('Page.captureScreenshot',{format:'png',clip}).data,'base64'));
}
const pointer=evaluate(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+40,y:r.y+45}})()`);
cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...pointer});
assert.deepEqual(metrics(),{...idle,opacity:'1'});
cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
assert.deepEqual(metrics(),idle);
await pause(150);screenshot('个人评论悬停前.png');
hover(true);await pause(150);screenshot('个人评论悬停后.png');
evaluate(`(()=>{document.querySelector('${selector} textarea').focus();return true})()`);
assert.equal(metrics().expanded,true);
evaluate(`(()=>{const field=document.querySelector('${selector} textarea');field.value='草稿保留';field.dispatchEvent(new Event('input'));field.blur();return true})()`);
hover(false);assert.equal(metrics().opacity,'1');
assert.equal(evaluate(`document.querySelector('${selector} textarea').value`),'草稿保留');
evaluate(`(()=>{document.querySelector('${selector} .hn-inline-cancel').click();document.activeElement?.blur();return true})()`);
hoverNode=0;
hover(false);assert.deepEqual(metrics(),idle);
evaluate(`(()=>{const view=app.workspace.getLeavesOfType('highnote-comments')[0].view;const scope=document.querySelector('[aria-label="文档范围"]');scope.value='all';scope.dispatchEvent(new Event('change'));view.page=Math.max(1,Math.ceil(view.visibleThreads.indexOf('${id}')/40)+1);view.render();document.querySelector('${selector} .hn-summary-body').click();document.querySelector('${selector}').scrollIntoView({block:'start'});document.activeElement?.blur();return !!view})()`);
hoverNode=0;
hover(false);const allIdle=metrics();hover(true);assert.deepEqual(metrics(),{...allIdle,opacity:'1'});hover(false);
assert.equal(evaluate(`document.querySelectorAll('.hn-author,.hn-avatar').length`),0);
evaluate(`(()=>{const scope=document.querySelector('[aria-label="文档范围"]');scope.value='current';scope.dispatchEvent(new Event('change'));const root=document.querySelector('.hn-sidebar');window.hnPersonalWidth=root.style.width;root.style.width='280px';document.querySelector('${selector}').scrollIntoView({block:'start'});document.activeElement?.blur();return true})()`);
hoverNode=0;
assert.equal(evaluate(`document.querySelector('.hn-sidebar').getBoundingClientRect().width`),280);
hover(false);const narrow=metrics();assert.equal(narrow.overflow,false);hover(true);assert.deepEqual(metrics(),{...narrow,opacity:'1'});
evaluate(`(()=>{document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');return true})()`);
hover(false);const dark=metrics();hover(true);assert.deepEqual(metrics(),{...dark,opacity:'1'});screenshot('个人评论深色效果.png');
evaluate(`(()=>{const root=document.querySelector('.hn-sidebar');root.style.width=window.hnPersonalWidth;delete window.hnPersonalWidth;document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');return true})()`);
hover(false);
const names=evaluate(`(async()=>{const {files}=await app.vault.adapter.list('.obsidian-highnote/annotations');return files.map(p=>p.split('/').at(-1)).filter(n=>/^note-[a-f0-9]{32}\\.json$/.test(n))})()`);
assert.ok(names.length>0);assert.ok(names.every(n=>n.length===42));
console.log(`PASS: no author/avatar, stable hover height ${idle.height}px and sibling position, borderless 22px reply prompt, click-to-expand, draft retention, overview details, 280px sidebar and dark theme, 42-character JSON names.`);

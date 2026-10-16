import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli,vault]=process.argv.slice(2);
if(!cli||!vault)throw new Error('需要CLI与测试库名称');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:30000}).trim();
const e=code=>{const raw=call('eval',`code=(async()=>JSON.stringify(await(${code})))()`),line=raw.split('\n').find(x=>x.startsWith('=> '));if(!line)throw new Error(raw);return JSON.parse(line.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<120;i++){if(e(code))return;await pause(80);}throw new Error('等待超时 '+code);}
const key=`实时回顾${Date.now()}`,p=`app.plugins.plugins.highnote`,v=`app.workspace.getLeavesOfType('highnote-review')[0].view`;
const t=e(`(async()=>{const p=${p};await p.openReview();const path='${key}.md';const file=await app.vault.create(path,'# 回顾'+String.fromCharCode(10,10)+'第一处原文。'+String.fromCharCode(10,10)+'第二处原文。');const source=await app.vault.read(file);const t=await p.store.create(path,source,source.indexOf('第一处'),source.indexOf('第一处')+6,'${key} 原评论');await p.store.update(t.id,t=>{t.messages.push(...Array.from({length:100},(_,i)=>({id:crypto.randomUUID(),body:'${key} 第'+i+'条补充',createdAt:new Date(Date.now()-100000+i*1000).toISOString(),updatedAt:new Date(Date.now()-100000+i*1000).toISOString(),deleted:false})));});await p.store.update(t.id,t=>{const old=new Date();old.setFullYear(old.getFullYear()-2);t.messages[0].createdAt=t.messages[0].updatedAt=old.toISOString()});const view=${v};view.kind='comments';view.viewScope='current';view.sourcePath=path;view.selectedDay='';view.includeReplies=true;view.query='${key}';view.search.value=view.query;view.page=0;p.syncReview();view.refresh(true);await app.workspace.revealLeaf(view.leaf);return {id:t.id,path,quote:t.originalQuote}})()`);
assert.equal(e(`document.querySelectorAll('.hn-review-card').length`),1);
assert.equal(e(`document.querySelectorAll('.hn-review-content-comments .hn-review-body').length`),40);
e(`(()=>{document.querySelector('.hn-review-details-link').click();return true})()`);
await until(`document.querySelectorAll('.hn-review-context-message').length>0 && document.querySelectorAll('.hn-review-context-message').length<=40`);
assert.ok(e(`document.querySelector('.hn-review-details .hn-review-pagination').textContent.includes('/ 101')`));
// Rerender on a saved comment edit preserves the visible card offset and expanded context.
const location=e(`(()=>{const view=${v};const card=view.feed.querySelectorAll('article')[0];view.contentEl.scrollTop=card.offsetTop-view.contentEl.offsetTop;const r=view.contentEl.getBoundingClientRect();return {key:card.dataset.reviewKey,offset:card.getBoundingClientRect().top-r.top}})()`);
e(`(async()=>{await ${p}.store.reply('${t.id}','${key} 新增后来的理解');return true})()`);
await until(`${v}.results.length===102`);
const after=e(`(()=>{const view=${v},card=[...view.feed.querySelectorAll('article')].find(c=>c.dataset.reviewKey===${JSON.stringify(location.key)});return {offset:card.getBoundingClientRect().top-view.contentEl.getBoundingClientRect().top,details:document.querySelectorAll('.hn-review-context-message').length}})()`);
assert.ok(Math.abs(after.offset-location.offset)<2);assert.equal(after.details,40);
await until(`document.querySelector('.hn-review-details h3').textContent.includes('102')`);
e(`(()=>{[...${p}.openModals].find(m=>m.contentEl.classList.contains('hn-review-details')).close();return true})()`);
e(`(async()=>{const query=${v}.query,scroll=${v}.contentEl.scrollTop;await ${p}.openReview();return {query:${v}.query===query,scroll:Math.abs(${v}.contentEl.scrollTop-scroll)<2}})()`);
// Include-replies filter never changes primary-comment identity.
e(`(()=>{const checkbox=document.querySelector('.hn-review-replies input');checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));return true})()`);
assert.equal(e(`document.querySelectorAll('.hn-review-card').length`),1);
assert.ok(e(`document.querySelector('.hn-review-body').textContent.includes('原评论')`));
e(`(()=>{const checkbox=document.querySelector('.hn-review-replies input');checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));return true})()`);
assert.equal(e(`${v}.results.length`),102);
// Date navigation retains the search and native keyboard arrows move among cells.
e(`(()=>{const view=${v};view.calendarOpen=true;view.renderCalendar();return true})()`);
const keyboard=e(`(()=>{const buttons=[...document.querySelectorAll('.hn-review-day')];buttons[10].focus();buttons[10].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return {from:buttons[10].dataset.reviewDay,to:document.activeElement.dataset.reviewDay}})()`);
assert.notEqual(keyboard.from,keyboard.to);
const scope=e(`${v}.heatRangeLabel.textContent`);
e(`(()=>{document.querySelector('[aria-label="查看上一段时间"]').click();return true})()`);
assert.notEqual(e(`${v}.heatRangeLabel.textContent`),scope);assert.equal(e(`${v}.results.length`),102);
e(`(()=>{document.querySelector('[aria-label="查看下一段时间"]').click();return true})()`);
assert.equal(e(`${v}.heatRangeLabel.textContent`),scope);
// Custom export modal validates names, cancels without writing, retries failure, and suppresses repeat saves.
e(`(()=>{document.querySelector('.hn-review-heading button').click();const f=document.querySelector('input[name="hn-review-format"][value="md"]');f.checked=true;f.dispatchEvent(new Event('change'));return true})()`);
await until(`!!document.querySelector('.hn-review-export')`);
e(`(()=>{const i=document.querySelector('[aria-label="回顾导出文件名"]');i.value='../无效';i.dispatchEvent(new Event('input'));return true})()`);
assert.equal(e(`document.querySelector('.hn-review-export .mod-cta').disabled`),true);
e(`(()=>{document.querySelector('.hn-review-export .hn-actions button').click();return true})()`);
assert.equal(e(`!!document.querySelector('.hn-review-export')`),false);
e(`(()=>{document.querySelector('.hn-review-heading button').click();const f=document.querySelector('input[name="hn-review-format"][value="md"]');f.checked=true;f.dispatchEvent(new Event('change'));const i=document.querySelector('[aria-label="回顾导出文件名"]');i.value='${key}-导出';i.dispatchEvent(new Event('input'));window.hnReviewVaultCreate=app.vault.create;app.vault.create=async()=>{throw new Error('回顾保存失败验收')};document.querySelector('.hn-review-export .mod-cta').click();return true})()`);
await until(`document.querySelector('.hn-review-export .hn-flomo-error').textContent.includes('回顾保存失败验收')`);
e(`(()=>{app.vault.create=window.hnReviewVaultCreate;delete window.hnReviewVaultCreate;const b=document.querySelector('.hn-review-export .mod-cta');b.click();b.click();return true})()`);
await until(`!document.querySelector('.hn-review-export') && !!app.vault.getFileByPath('${key}-导出.md')`);
assert.equal(e(`app.vault.getFiles().filter(f=>f.path.startsWith('${key}-导出')).length`),1);
assert.ok(e(`(async()=>{const text=await app.vault.read(app.vault.getFileByPath('${key}-导出.md'));return text.includes('1 处摘录 · 102 条记录')})()`));
// Live original source edits are observed; creation-time excerpt remains independently persisted.
e(`(async()=>{await app.workspace.revealLeaf(${v}.leaf);const entry=${p}.reviewIndex.search('comments','${key}')[0];await ${p}.openReviewSource(entry,${v}.leaf);const leaf=app.workspace.getMostRecentLeaf();await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'source'},active:true});await app.workspace.revealLeaf(leaf);const editor=leaf.view.editor;const source=editor.getValue();const from=source.indexOf('第一处')+2;editor.replaceRange('新',editor.offsetToPos(from),editor.offsetToPos(from+1));await ${p}.flushAnchors();return true})()`);
assert.equal(e(`${p}.store.get('${t.id}').originalQuote`),t.quote);
assert.notEqual(e(`${p}.store.get('${t.id}').anchor.quote`),t.quote);
e(`(async()=>{await app.workspace.revealLeaf(${v}.leaf);return true})()`);
await until(`${p}.reviewIndex.getThread('${t.id}').anchor.quote!==${JSON.stringify(t.quote)}`);
// Delete primary message: no ghost placeholder, remaining messages stay replies.
e(`(async()=>{const t=${p}.store.get('${t.id}');await ${p}.store.deleteMessage(t.id,t.messages[0].id,false);return true})()`);
await until(`${v}.results.length===101`);
assert.equal(e(`${v}.results.some(r=>r.kind==='comment')`),false);
assert.equal(e(`document.querySelector('.hn-review-feed').textContent.includes('该消息已删除')`),false);
// All-data old records use the current excerpt fallback; this does not mutate source files.
e(`(()=>{const view=${v};view.viewScope='all';view.query='';view.search.value='';view.refresh(true);return true})()`);
assert.ok(e(`${p}.reviewIndex.search('comments','').some(r=>!r.original)`));
console.log('通过：101条长讨论分批、详情实时更新、卡片位置保持、回复开关、日期键盘翻页、文件名与取消、失败重试和防重、102条完整导出、原文跟随与保存摘录独立、主评论删除与旧记录回退。');

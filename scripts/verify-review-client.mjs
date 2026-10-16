import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli,vault,screenshots]=process.argv.slice(2);
if(!cli||!vault)throw new Error('需要 CLI 和测试库名称');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:30000}).trim();
const e=code=>{const raw=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const l=raw.split('\n').find(x=>x.startsWith('=> '));if(!l)throw new Error(raw);return JSON.parse(l.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<100;i++){if(e(code))return;await pause(80);}throw new Error('等待超时 '+code);}
const p=`app.plugins.plugins.highnote`,v=`app.workspace.getLeavesOfType('highnote-review')[0].view`;
const folder=`回顾验收${Date.now()}`,filePath=`${folder}/原文.md`,otherPath=`${folder}/另一篇.md`;
const ids=e(`(async()=>{const p=${p};await p.openReview();await app.vault.createFolder('${folder}');const source='# 阅读回顾'+String.fromCharCode(10,10)+'第一处原文用于回读。'+String.fromCharCode(10,10)+'第二处原文用于标记。';await app.vault.create('${filePath}',source);await app.vault.create('${otherPath}',source);const t=await p.store.create('${filePath}',source,source.indexOf('第一处'),source.indexOf('第一处')+6,'**完整评论**'+String.fromCharCode(10)+'- 列表内容');await p.store.reply(t.id,'${folder}-跨天补充关键词');await p.store.reply(t.id,'第二次 ${folder}-跨天补充关键词');await p.store.update(t.id,t=>{t.resolved=true;t.createdAt='2026-09-08T10:00:00+08:00';t.messages[0].createdAt=t.createdAt;t.messages[0].updatedAt='2026-10-10T10:00:00+08:00';t.messages[1].createdAt='2026-10-14T09:00:00+08:00';t.messages[1].updatedAt=t.messages[1].createdAt;t.messages[2].createdAt='2026-10-15T11:00:00+08:00';t.messages[2].updatedAt=t.messages[2].createdAt;});const h=await p.store.createHighlight('${filePath}',source,source.indexOf('第二处'),source.indexOf('第二处')+6);const b=await p.store.create('${otherPath}',source,source.indexOf('第一处'),source.indexOf('第一处')+6,'${folder}-另一篇的完整评论');p.syncReview();const view=${v};view.kind='comments';view.viewScope='all';view.selectedDay='';view.includeReplies=true;view.calendarOpen=false;view.page=0;view.query='${folder}';view.search.value=view.query;view.refresh(true);await app.workspace.revealLeaf(view.leaf);return {t:t.id,h:h.id,b:b.id,source,quote:t.originalQuote}})()`);
await until(`document.querySelectorAll('.hn-review-card').length===2`);
assert.equal(e(`${v}.heatBody.hidden`),true);
assert.ok(e(`document.querySelector('.hn-review-count').textContent.includes('2 处摘录')`));
assert.equal(e(`document.querySelectorAll('.hn-review .hn-message-more,.hn-review .hn-inline-reply-input,.hn-review .hn-resolve').length`),0);
assert.equal(e(`document.querySelector('.hn-review-body').textContent`),`${folder}-另一篇的完整评论`);
assert.equal(e(`document.querySelectorAll('.hn-review-card time,.hn-review-card details,.hn-review-card .hn-review-meta').length`),0);
assert.ok(e(`[...document.querySelectorAll('.hn-review-context')].every(x=>x.parentElement.firstElementChild===x)`));
// Scope switches keep the correct source even when the review owns focus.
e(`(()=>{const view=${v};view.sourcePath='${filePath}';const select=view.scopeSelect;select.value='current';select.dispatchEvent(new Event('change'));return true})()`);
assert.equal(e(`${v}.groups.length`),1);
e(`(()=>{const select=${v}.scopeSelect;select.value='all';select.dispatchEvent(new Event('change'));return true})()`);
assert.equal(e(`${v}.groups.length`),2);
const search=async q=>{e(`(()=>{const i=document.querySelector('.hn-review-search');i.value=${JSON.stringify(q)};i.dispatchEvent(new Event('input'));return true})()`);await until(`${v}.query===${JSON.stringify(q)}`);};
await search(`${folder}-跨天补充关键词`);assert.equal(e(`document.querySelectorAll('.hn-review-card').length`),1);
assert.equal(e(`document.querySelectorAll('.hn-review-content-comments .hn-review-body').length`),3);
assert.ok(e(`document.querySelector('.hn-review-body').textContent.includes('完整评论')`));
e(`(()=>{document.querySelector('.hn-review-details-link').click();return true})()`);
await until(`document.querySelectorAll('.hn-review-context-message').length===3`);
assert.ok(e(`document.querySelector('.hn-review-context-message').textContent.includes('编辑过')`));
e(`(()=>{[...${p}.openModals].find(m=>m.contentEl.classList.contains('hn-review-details')).close();return true})()`);
e(`(()=>{${v}.calendarOpen=true;${v}.renderCalendar();return true})()`);
assert.equal(e(`document.querySelectorAll('.hn-review-day.level-1').length`),2);
assert.equal(e(`document.querySelectorAll('.hn-review-day.level-2,.hn-review-day.level-3').length`),0);
e(`(()=>{${v}.jumpDay('2026-09-08');return true})()`);
assert.equal(e(`document.querySelector('.hn-review-search').value`),`${folder}-跨天补充关键词`);
assert.ok(e(`document.querySelector('.hn-review-feedback').textContent.includes('没有匹配')`));
e(`(()=>{${v}.jumpDay('2026-10-14');return true})()`);
assert.equal(e(`document.querySelector('.hn-review-search').value`),`${folder}-跨天补充关键词`);
assert.equal(e(`document.querySelectorAll('.hn-review-card').length`),1);
assert.equal(e(`document.querySelectorAll('.hn-review-body.is-date-hit').length`),1);
// Export uses document scope and ignores the homepage's query/date/reply filter.
const exported=e(`(async()=>{const f=await ${p}.exportReview('comments','不存在',false,'${folder}-阅读','md','current','${filePath}');return {path:f.path,text:await app.vault.read(f)}})()`);
assert.ok(exported.text.includes('1 处摘录 · 3 条记录'));
assert.equal((exported.text.match(/> \[!info\]- 查看出处与记录/g)||[]).length,1);
assert.ok(exported.text.includes('完整评论'));assert.ok(!exported.text.includes(folder+'-另一篇的完整评论'));
e(`(async()=>{await app.workspace.revealLeaf(${v}.leaf);return true})()`);
const duplicate=e(`(async()=>{const f=await ${p}.exportReview('comments','',true,'${folder}-阅读','md','current','${filePath}');return f.path})()`);
assert.equal(duplicate,`${folder}-阅读(1).md`);
e(`(async()=>{await app.workspace.revealLeaf(${v}.leaf);return true})()`);
// Editing a current anchor does not change its creation-time excerpt; existing legacy records remain explicitly labeled.
e(`(async()=>{await ${p}.store.update('${ids.t}',t=>{t.anchor.quote='改变后的定位文字';t.anchor.state='detached'});return true})()`);
await until(`${v}.version===${p}.reviewIndex.version && ${p}.reviewIndex.getThread('${ids.t}').anchor.state==='detached'`);
assert.equal(e(`${p}.store.get('${ids.t}').originalQuote`),ids.quote);
assert.equal(e(`document.querySelector('.hn-review-card .hn-review-context').textContent`),ids.quote);
// Original excerpt survives disk reload without being replaced by the current anchor.
call('plugin:reload','id=highnote');await until(`!!${p}.store.get('${ids.t}') && !!document.querySelector('.hn-review-search')`);
assert.equal(e(`${p}.store.get('${ids.t}').originalQuote`),ids.quote);
assert.equal(e(`document.querySelector('.hn-review-search').value`),`${folder}-跨天补充关键词`);
// Highlight pane and reply toggle are independent from the readonly source/reading mode.
e(`(()=>{document.querySelector('[data-review-kind="highlights"]').click();return true})()`);await search(folder);
assert.equal(e(`document.querySelectorAll('.hn-review-card').length`),1);assert.ok(e(`document.querySelector('.hn-review-card .hn-review-context').textContent.includes('第二处')`));
assert.equal(e(`document.querySelector('.hn-review-replies').hidden`),true);
e(`(async()=>{const entry=${p}.reviewIndex.search('highlights','${folder}')[0];await ${p}.openReviewSource(entry,${v}.leaf);return true})()`);
await until(`app.workspace.getMostRecentLeaf().view.file?.path==='${filePath}' && app.workspace.getMostRecentLeaf().view.getMode()==='preview'`);
await until(`!!app.workspace.getMostRecentLeaf().view.contentEl.querySelector('[data-hn-highlight="${ids.h}"]')`);
e(`(()=>{window.hnReviewSourceLeaf=app.workspace.getMostRecentLeaf();return true})()`);
e(`(async()=>{await app.workspace.revealLeaf(${v}.leaf);const entry=${p}.reviewIndex.search('comments','${folder}-另一篇的完整评论')[0];await ${p}.openReviewSource(entry,${v}.leaf);return true})()`);
assert.equal(e(`app.workspace.getMostRecentLeaf().view.file.path`),otherPath);assert.equal(e(`app.workspace.getMostRecentLeaf()===window.hnReviewSourceLeaf`),true);
// Pinned / edited original panes must not be overwritten by the review's reuse rule.
e(`(async()=>{const l=app.workspace.getMostRecentLeaf();l.setPinned(true);await app.workspace.revealLeaf(${v}.leaf);const entry=${p}.reviewIndex.search('highlights','${folder}')[0];await ${p}.openReviewSource(entry,${v}.leaf);return true})()`);
assert.equal(e(`app.workspace.getMostRecentLeaf()===window.hnReviewSourceLeaf`),false);e(`(()=>{window.hnReviewSourceLeaf.setPinned(false);const created=app.workspace.getMostRecentLeaf();created.detach();delete window.hnReviewSourceLeaf;return true})()`);
e(`(async()=>{await app.workspace.revealLeaf(${v}.leaf);return true})()`);
// Bounded rendering, full-range search and remote-day loading with 20,000 entries, no vault writes.
const perf=e(`(()=>{const p=${p},index=p.reviewIndex;window.hnReviewRealIndex=index;const template=p.store.get('${ids.b}');const entries=Array.from({length:20000},(_,i)=>({...template,id:'perf-thread-'+i,filePath:'性能/笔记.md',revision:1,messages:[{...template.messages[0],id:'perf-message-'+i,createdAt:new Date(2026,0,1,0,i).toISOString(),updatedAt:new Date(2026,0,1,0,i).toISOString(),body:'性能正文 '.repeat(150)+(i===19999?'性能尾部命中':'')}]}));const next=new index.constructor();let start=performance.now();next.sync(entries,[]);const build=performance.now()-start;p.reviewIndex=next;const view=${v};view.kind='comments';view.viewScope='all';view.selectedDay='';view.query='';view.search.value='';start=performance.now();view.refresh(true);const render=performance.now()-start;start=performance.now();next.search('comments','性能尾部命中');const search=performance.now()-start;const groups=view.allGroups;view.query='性能尾部命中';start=performance.now();view.refresh(true);const filtered=performance.now()-start;const cached=groups===view.allGroups;view.query='';view.refresh(true);return {build,render,search,filtered,cached,count:view.results.length,cards:document.querySelectorAll('.hn-review-card').length,totalNodes:document.querySelector('.hn-review').querySelectorAll('*').length}})()`);
assert.equal(perf.count,20000);assert.equal(perf.cached,true);assert.equal(perf.cards,40);assert.ok(perf.totalNodes<2000);
await search('性能尾部命中');assert.equal(e(`document.querySelectorAll('.hn-review-card').length`),1);
const far=e(`(()=>{const d=new Date(${p}.reviewIndex.search('comments','')[19999].createdAt);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')})()`);
e(`(()=>{const view=${v};view.search.value='';view.query='';view.refresh(true);view.jumpDay(${JSON.stringify(far)});return true})()`);
assert.ok(e(`${v}.groups.length`)>0);assert.equal(e(`${v}.selectedDay`),far);assert.ok(e(`document.querySelectorAll('.hn-review-card').length`)<=40);
e(`(()=>{const p=${p};p.reviewIndex=window.hnReviewRealIndex;delete window.hnReviewRealIndex;const view=${v};view.kind='comments';view.viewScope='all';view.selectedDay='';view.includeReplies=true;view.calendarOpen=false;view.page=0;view.query='${folder}';view.search.value=view.query;view.calendarOpen=false;view.selectedDay='';view.page=0;view.refresh(true);return true})()`);
e(`(()=>{const origin=${v}.leaf;const targets=new Set(${p}.reviewSources.values());for(const leaf of targets)if(leaf!==origin){leaf.setPinned(false);leaf.detach();}${p}.reviewSources.clear();return true})()`);
if(screenshots){mkdirSync(screenshots,{recursive:true});for(const [theme,width,name] of [['theme-light','','阅读回顾浅色.png'],['theme-dark','','阅读回顾深色.png'],['theme-light','360px','阅读回顾窄栏.png']]){e(`(()=>{document.body.classList.remove('theme-light','theme-dark');document.body.classList.add('${theme}');const r=${v}.contentEl;r.style.width='${width}';r.scrollTop=0;return true})()`);await pause(120);const bytes=e(`(async()=>{const win=require('electron').remote.getCurrentWindow();return(await win.capturePage()).toPNG().toString('base64')})()`);writeFileSync(path.join(screenshots,name),Buffer.from(bytes,'base64'));assert.equal(e(`document.querySelector('.hn-review').scrollWidth>document.querySelector('.hn-review').clientWidth+2`),false);}}
e(`(()=>{document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');${v}.contentEl.style.width='';return true})()`);
console.log('通过：原文优先分组、全部状态、搜索与日期一致、全文和详情、保存摘录及重载、范围完整导出、来源分栏复用与固定保护、两万记录分批和缓存、浅深主题及窄栏。');
console.log(JSON.stringify(perf));

import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import pathModule from 'node:path';
import assert from 'node:assert/strict';
const [cli, vault, output = '/tmp/highnote-mobile-review'] = process.argv.slice(2);
if (!cli || !vault) throw new Error('Usage: node scripts/verify-mobile-review-client.mjs obsidian-cli test-vault [output-directory]');
mkdirSync(output, {recursive:true});
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:20000});
const ev=code=>{const out=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=out.split('\n').find(s=>s.startsWith('=> '));if(!line){if(out.trim()==='(no output)')return undefined;throw new Error(out);}return JSON.parse(line.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<40;i++){if(ev(code))return;await pause(100);}throw new Error(code);}
const path=`手机版回顾测试-${Date.now()}.md`, source='# 手机回顾\n\n桌面端保存的原文摘录。', now=new Date().toISOString();
const thread={schemaVersion:1,id:randomUUID(),revision:1,filePath:path,fileMissing:false,anchor:{from:source.indexOf('桌面'),to:source.length,quote:'桌面端保存的原文摘录。',before:'# 手机回顾\n\n',after:'',state:'attached'},originalQuote:'桌面端保存的原文摘录。',resolved:false,createdAt:now,updatedAt:now,messages:[{id:randomUUID(),body:'手机查看评论全文。**加粗重点**\n- 清单一\n- 清单二',deleted:false,createdAt:now,updatedAt:now},{id:randomUUID(),body:'手机查看回复全文。'+ '连续想法。'.repeat(30),deleted:false,createdAt:now,updatedAt:now}]};
const highlight={id:randomUUID(),revision:1,filePath:path,fileMissing:false,anchor:thread.anchor,originalQuote:thread.originalQuote,createdAt:now,updatedAt:now};
const note={schemaVersion:2,filePath:path,revision:1,threads:[thread],highlights:[highlight]};
const dataDirectory=ev('app.plugins.plugins.highnote.dataFolder');
const dataParents=dataDirectory.split('/').map((_,index,parts)=>parts.slice(0,index+1).join('/'));
const dataPath=dataDirectory+'/note-'+createHash('sha256').update(path).digest('hex').slice(0,32)+'.json';
const raw=JSON.stringify(note,null,2), results={};
assert.equal(ev('app.plugins.plugins.highnote.isMobileReview'),true,'Enable mobile emulation before running this script');
ev(`(()=>{window.hnMobileCheck={layout:app.workspace.getLayout(),dark:document.body.classList.contains('theme-dark'),settings:structuredClone(app.plugins.plugins.highnote.settings)};return true})()`);
try{
 await ev(`(async()=>{const a=app.vault.adapter;for(const p of ${JSON.stringify(dataParents)})if(!await a.exists(p))await a.mkdir(p);await a.write(${JSON.stringify(dataPath)},${JSON.stringify(raw)});await app.vault.create(${JSON.stringify(path)},${JSON.stringify(source)});await app.plugins.plugins.highnote.openReview();return true})()`);
 await until(`document.querySelectorAll('.hn-review-card').length===1`);
 ev(`(()=>{const v=app.workspace.getActiveViewOfType(app.plugins.plugins.highnote.app.workspace.getLeavesOfType('highnote-review')[0].view.constructor);v.calendarOpen=false;v.refresh(true);return true})()`);
 const state=ev(`(()=>{const p=app.plugins.plugins.highnote;return {mobile:p.isMobileReview,modify:p.canModify,reading:p.readingViews.size,editor:p.editorViews.size,watcher:p.dataWatcher,commands:Object.keys(app.commands.commands).filter(k=>k.startsWith('highnote:')),text:document.querySelector('.hn-review-card').textContent}})()`);
 assert.ok(state.mobile && !state.modify);assert.equal(state.reading,0);assert.equal(state.editor,0);assert.equal(state.watcher,null);
 assert.deepEqual(state.commands,['highnote:open-review','highnote:refresh-review']);assert.ok(state.text.includes('手机查看回复全文'));results.load=state;
 // Force the full viewport to a phone width, including touch-mode layout.
 call('dev:cdp','method=Emulation.setDeviceMetricsOverride','params='+JSON.stringify({width:390,height:844,deviceScaleFactor:1,mobile:true}));
 await pause(250);
 call('dev:screenshot','path='+pathModule.join(output,'mobile-review.png'));
 ev(`(()=>{document.querySelector('[aria-label="展开或收起热力图"]').click();return true})()`);
 await pause(150);
 results.layout=ev(`(()=>{const r=document.querySelector('.hn-review'),day=r.querySelector('.hn-review-day');return {width:r.clientWidth,scroll:r.scrollWidth,days:r.querySelectorAll('.hn-review-day').length,day:day.getBoundingClientRect().toJSON(),readOnly:r.querySelectorAll('textarea,.hn-message-more,.hn-selection-toolbar').length}})()`);
 assert.ok(results.layout.scroll<=results.layout.width+1);assert.ok(results.layout.day.width>=30);assert.equal(results.layout.readOnly,0);
 call('dev:screenshot','path='+pathModule.join(output,'mobile-heatmap.png'));
 // Search, tabs and date filtering.
 ev(`(()=>{const q=document.querySelector('.hn-review-search');q.value='没有匹配词';q.dispatchEvent(new Event('input'));return true})()`);
 await until(`document.querySelectorAll('.hn-review-card').length===0`);
 ev(`(()=>{const q=document.querySelector('.hn-review-search');q.value='手机查看';q.dispatchEvent(new Event('input'));return true})()`);
 await until(`document.querySelectorAll('.hn-review-card').length===1`);
 ev(`(()=>{const q=document.querySelector('.hn-review-search');q.value='';q.dispatchEvent(new Event('input'));document.querySelector('[data-review-kind="highlights"]').click();return true})()`);
 await until(`document.querySelectorAll('.hn-review-card').length===1`);
 ev(`(()=>{document.querySelector('[data-review-kind="comments"]').click();document.querySelector('.hn-review-day.level-3,.hn-review-day.level-2,.hn-review-day.level-1')?.click();return true})()`);
 assert.equal(ev(`document.querySelectorAll('.hn-review-card').length`),1);
 ev(`(()=>{document.querySelector('.hn-review-clear-date')?.click();document.querySelector('.hn-review-details-link').click();return true})()`);
 await until(`!!document.querySelector('.hn-review-details')`);
 assert.ok(ev(`document.querySelector('.hn-review-details').textContent.includes('手机查看回复全文')`));
 await pause(250);
 call('dev:screenshot','path='+pathModule.join(output,'mobile-details.png'));
 assert.ok(ev(`(()=>{const m=document.querySelector('.hn-review-details-modal');return m.scrollWidth<=m.clientWidth+1})()`));
 ev(`(()=>{document.querySelector('[aria-label="回到原文"]').click();return true})()`);
 await until(`app.workspace.getActiveFile()?.path===${JSON.stringify(path)}`);
 assert.equal(ev(`document.querySelectorAll('.hn-sidebar,.hn-selection-toolbar,.markdown-preview-view .hn-mark,.markdown-preview-view .hn-highlight').length`),0);
 results.source=true;
 // All phone-side annotation write paths must refuse before disk changes.
 assert.equal(ev(`(async()=>{try{await app.plugins.plugins.highnote.store.reply(${JSON.stringify(thread.id)},'禁止写入');return false}catch{return true}})()`),true);
 assert.equal(ev(`(async()=>{try{await app.plugins.plugins.highnote.highlight({filePath:${JSON.stringify(path)},source:${JSON.stringify(source)},from:8,to:10});return false}catch{return true}})()`),true);
 // Edit/delete the local source while its synchronized annotations remain untouched.
 ev(`(async()=>{await app.vault.modify(app.vault.getFileByPath(${JSON.stringify(path)}),'修改后的手机原文');await app.plugins.plugins.highnote.refreshMobileReview(true);return true})()`);
 assert.equal(ev(`app.vault.adapter.read(${JSON.stringify(dataPath)})`),raw);
 await ev(`app.plugins.plugins.highnote.openReview()`);
 results.readOnly=true;
 // External sync updates a record; unchanged reload must preserve index version.
 note.threads[0].messages[0].body='同步后的新评论';note.threads[0].revision++;note.revision++;
 const next=JSON.stringify(note,null,2);
 ev(`(async()=>{await app.vault.adapter.write(${JSON.stringify(dataPath)},${JSON.stringify(next)});await app.plugins.plugins.highnote.refreshMobileReview();return true})()`);
 await until(`document.querySelector('.hn-review-card').textContent.includes('同步后的新评论')`);
 const version=ev(`app.plugins.plugins.highnote.store.version`);
 ev(`app.plugins.plugins.highnote.refreshMobileReview()`);
 assert.equal(ev(`app.plugins.plugins.highnote.store.version`),version);results.refresh=true;
 // Phone export UI and small dark layout must not introduce horizontal scrolling.
 ev(`(()=>{document.querySelector('[aria-label="导出阅读回顾"]').click();return true})()`);
 await until(`!!document.querySelector('.hn-review-export-modal')`);await pause(250);
 call('dev:screenshot','path='+pathModule.join(output,'mobile-export.png'));
 assert.ok(ev(`(()=>{const m=document.querySelector('.hn-review-export-modal');return m.scrollWidth<=m.clientWidth+1})()`));
 ev(`(()=>{for(const m of app.plugins.plugins.highnote.openModals)m.close();document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');return true})()`);
 call('dev:cdp','method=Emulation.setDeviceMetricsOverride','params='+JSON.stringify({width:320,height:740,deviceScaleFactor:1,mobile:true}));await pause(200);
 assert.ok(ev(`(()=>{const r=document.querySelector('.hn-review');return r.scrollWidth<=r.clientWidth+1})()`));
 call('dev:screenshot','path='+pathModule.join(output,'mobile-dark-320.png'));
 results.smallDark=true;
 // Export every supported format on mobile without Electron shell.
 for(const format of ['md','html','flomo_csv']){
  const exported=ev(`(async()=>{const f=await app.plugins.plugins.highnote.exportReview('comments','',true,'手机导出验证',${JSON.stringify(format)});return f?.path})()`);
  assert.ok(exported.endsWith(format==='flomo_csv'?'.csv':'.'+format));
  const content=ev(`app.vault.read(app.vault.getFileByPath(${JSON.stringify(exported)}))`);assert.ok(content.includes('同步后的新评论'));
  ev(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(exported)});for(const l of app.workspace.getLeavesOfType('markdown'))if(l.view.file===f)l.detach();await app.vault.delete(f);return true})()`);
 }
 results.export=true;
 // Missing local source cannot detach or modify the synchronized annotation file.
 ev(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(path)});for(const l of app.workspace.getLeavesOfType('markdown'))if(l.view.file===f)l.detach();await app.vault.delete(f);await app.plugins.plugins.highnote.refreshMobileReview(true);await app.plugins.plugins.highnote.openReview();return true})()`);
 assert.equal(ev(`app.vault.adapter.read(${JSON.stringify(dataPath)})`),next);
 assert.ok(ev(`app.plugins.plugins.highnote.store.get(${JSON.stringify(thread.id)})?.anchor.state==='attached'`));
 results.missingSource=true;
 writeFileSync(pathModule.join(output,'client-results.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));
}finally{
 call('dev:cdp','method=Emulation.clearDeviceMetricsOverride');
 ev(`(async()=>{const s=window.hnMobileCheck,p=app.plugins.plugins.highnote;for(const m of p.openModals)m.close();const file=app.vault.getFileByPath(${JSON.stringify(path)});if(file){for(const l of app.workspace.getLeavesOfType('markdown'))if(l.view.file===file)l.detach();await app.vault.delete(file);}if(await app.vault.adapter.exists(${JSON.stringify(dataPath)}))await app.vault.adapter.remove(${JSON.stringify(dataPath)});document.body.classList.toggle('theme-dark',s.dark);document.body.classList.toggle('theme-light',!s.dark);p.settings=s.settings;await p.saveData(s.settings);await p.refreshMobileReview(true);await app.workspace.changeLayout(s.layout);delete window.hnMobileCheck;return true})()`);
}

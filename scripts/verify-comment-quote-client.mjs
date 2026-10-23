import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [cli,vault,output='/tmp/highnote-quote-check']=process.argv.slice(2);
if(!cli||!vault)throw new Error('需要 Obsidian CLI 和测试仓库。');
mkdirSync(output,{recursive:true});
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:20000}).trim();
const ev=code=>{const out=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=out.split('\n').find(l=>l.startsWith('=> '));if(!line){if(out==='(no output)')return;throw new Error(out);}return JSON.parse(line.slice(3));};
const q=JSON.stringify,pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<60;i++){if(ev(code))return;await pause(100);}throw new Error(code);}
ev(`(()=>{document.querySelectorAll('.hn-message-modal').forEach(m=>m.closest('.modal-container')?.remove());for(const m of app.plugins.plugins.highnote.openModals)m.close();return true})()`);await pause(350);
const root=`Highnote引用验收-${Date.now()}`,mobile=ev('app.plugins.plugins.highnote.isMobile'),results={mobile,layouts:[]};
ev(`(()=>{const p=app.plugins.plugins.highnote;window.hnQuoteCheck={layout:app.workspace.getLayout(),settings:structuredClone(p.settings),directory:p.dataFolder};app.setting.close();return true})()`);
function modal(code){return ev(`(()=>{const m=document.querySelector('.hn-message-modal');${code}})()`);}
try{
 ev(`(async()=>{const p=app.plugins.plugins.highnote;await p.setDataDirectory(${q(root+'/annotations')});await app.vault.createFolder(${q(root)});const quote=Array.from({length:18},(_,i)=>'第'+(i+1)+'句：先想清楚事情做与不做的影响，再行动。').join('\\n');const source='# 阅读后的想法\\n\\n'+quote+'\\n\\n尾部不属于选区。';const file=await app.vault.create(${q(root+'/笔记.md')},source);const leaf=app.workspace.getLeaf('tab');const s=window.hnQuoteCheck;Object.assign(s,{quote,source,file,leaf});await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);p.compose({filePath:file.path,source,from:source.indexOf(quote),to:source.indexOf(quote)+quote.length});return true})()`);
 await until(`!!document.querySelector('.hn-compose-quote') && document.activeElement?.tagName==='TEXTAREA'`);
 assert.equal(modal(`return m.querySelector('.hn-compose-quote').textContent;`),ev('window.hnQuoteCheck.quote'));
 assert.equal(modal(`return m.querySelector('textarea').value;`),'');
 assert.equal(modal(`return m.querySelector('.hn-compose-reference').nextElementSibling.className;`),'hn-format-toolbar');
 const layouts=mobile?[[440,956],[956,440],[744,1133],[1133,744],[360,744],[956,220]]:[[1280,900],[900,650]];
 modal(`const t=m.querySelector('textarea');t.value='我的评论草稿，引用不应写入评论。';t.dispatchEvent(new Event('input'));return true;`);
 for(const [width,height] of layouts){
  call('dev:cdp','method=Emulation.setDeviceMetricsOverride',`params=${q({width,height,deviceScaleFactor:1,mobile})}`);await pause(250);
  const metric=modal(`const b=m.querySelector('.hn-compose-quote'),t=m.querySelector('textarea');return {quoteHeight:b.getBoundingClientRect().height,scrollable:b.scrollHeight>b.clientHeight,overflow:m.scrollWidth>m.clientWidth+1,fullText:b.textContent===window.hnQuoteCheck.quote,draft:t.value};`);
  assert.ok(metric.quoteHeight<= (mobile?height<=500?50:74:102));assert.ok(metric.scrollable);assert.equal(metric.overflow,false);assert.equal(metric.fullText,true);assert.equal(metric.draft,'我的评论草稿，引用不应写入评论。');
  modal(`m.querySelector('.mod-cta').scrollIntoView({block:'nearest'});return true;`);await pause(80);
  const save=modal(`const r=m.querySelector('.mod-cta').getBoundingClientRect();return {top:r.top,bottom:r.bottom};`);
  assert.ok(save.top>=0 && save.bottom<=height+1,JSON.stringify({width,height,save}));results.layouts.push({width,height,...metric,save});
  if((mobile&&width===440)||(!mobile&&width===1280)){ev(`(()=>{document.querySelectorAll('.notice-container').forEach(e=>e.remove());return true})()`);call('dev:screenshot',`path=${output}/${mobile?'手机引用原文':'添加评论展示原文'}.png`);}
 }
 modal(`m.querySelector('.mod-cta').click();return true;`);
 await until(`app.plugins.plugins.highnote.store.viewAll().some(t=>t.filePath===${q(root+'/笔记.md')}) && !document.querySelector('.hn-message-modal')`);
 const thread=ev(`(()=>{const t=app.plugins.plugins.highnote.store.viewFile(${q(root+'/笔记.md')})[0];window.hnQuoteCheck.thread=t.id;return t})()`);
 assert.equal(thread.anchor.quote,ev('window.hnQuoteCheck.quote'));assert.equal(thread.messages[0].body,'我的评论草稿，引用不应写入评论。');results.savedSeparately=true;
 if(mobile){
  call('dev:cdp','method=Emulation.setDeviceMetricsOverride',`params=${q({width:956,height:440,deviceScaleFactor:1,mobile:true})}`);await pause(200);
  ev(`(()=>{document.querySelector('.hn-mobile-reply').click();return true})()`);await until(`!!document.querySelector('.hn-compose-quote')`);
  assert.equal(modal(`return m.querySelector('.hn-compose-quote').textContent;`),thread.anchor.quote);results.replyQuote=true;
 }
 console.log(JSON.stringify(results,null,2));writeFileSync(`${output}/${mobile?'移动端原文引用验证':'桌面原文引用验证'}.json`,JSON.stringify(results,null,2));
}finally{
 ev(`(()=>{for(const m of app.plugins.plugins.highnote.openModals)m.close();return true})()`);await pause(350);
 ev(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnQuoteCheck;for(const m of p.openModals)m.close();p.drafts.clear();await p.setDataDirectory(s.directory);p.settings=s.settings;await p.saveData(s.settings);s.leaf?.detach();const f=app.vault.getAbstractFileByPath(${q(root)});if(f)await app.vault.delete(f,true);await app.workspace.changeLayout(s.layout);delete window.hnQuoteCheck;return true})()`);
 call('dev:cdp','method=Emulation.clearDeviceMetricsOverride');
}

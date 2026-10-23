import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [cli,vault,output='/tmp/highnote-navigation-check']=process.argv.slice(2);
if(!cli||!vault)throw new Error('需要指定 Obsidian CLI 与测试仓库。');
mkdirSync(output,{recursive:true});
const call=(...a)=>execFileSync(cli,[`vault=${vault}`,...a],{encoding:'utf8',timeout:20000}).trim();
const ev=code=>{const raw=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=raw.split('\n').find(l=>l.startsWith('=> '));if(!line){if(raw==='(no output)')return;throw new Error(raw);}return JSON.parse(line.slice(3));};
const q=JSON.stringify,pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let n=0;n<60;n++){if(ev(code))return;await pause(100);}throw new Error(code);}
const mobile=ev('app.plugins.plugins.highnote.isMobile');
const folder=`Highnote导航验收-${Date.now()}`;
const results={mobile,viewports:[]};
ev(`(()=>{const p=app.plugins.plugins.highnote;window.hnCompactCheck={settings:structuredClone(p.settings),layout:app.workspace.getLayout(),directory:p.dataFolder};app.setting.close();return true})()`);
try {
  ev(`(async()=>{const p=app.plugins.plugins.highnote;await p.setDataDirectory(${q(folder+'/annotations')});await app.vault.createFolder(${q(folder)});const source='# 阅读与思考\\n\\n阅读时写下想法，可以帮助我们重新理解一句话，并在回顾时找到新的联系。\\n\\n一条清晰的评论，比重复收藏更有价值。';const file=await app.vault.create(${q(folder+'/阅读笔记.md')},source);const leaf=app.workspace.getLeaf('tab');window.hnCompactCheck.leaf=leaf;await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);const first=await p.store.create(file.path,source,source.indexOf('阅读时'),source.indexOf('\\n\\n一条'),'**读后的想法**\\n把想法留在原文旁边，之后回看也能理解当时为什么做这条批注。');const second=await p.store.create(file.path,source,source.indexOf('一条'),source.length,'保留对原文的解释。');window.hnCompactCheck.ids=[first.id,second.id];await p.showThread(first.id);await p.setCommentNavigation(false);return true})()`);
  await until(`document.querySelectorAll('.hn-card').length===2`);
  assert.equal(ev(`document.querySelectorAll('[data-hn-navigation]').length`),0);
  assert.equal(ev(`document.querySelectorAll('.hn-resolve').length`),2);
  const sizes=mobile?[[440,956],[956,440],[744,1133],[1133,744],[360,744]]:[[360,800],[280,800]];
  for(const [width,height] of sizes){
    if(mobile)call('dev:cdp','method=Emulation.setDeviceMetricsOverride',`params=${q({width,height,deviceScaleFactor:1,mobile:true})}`);
    else ev(`(()=>{document.querySelector('.hn-sidebar').style.width='${width}px';return true})()`);
    await pause(300);
    const geometry=()=>ev(`(()=>{const c=document.querySelector('.hn-card'),h=c.querySelector('.hn-card-header'),quote=h.querySelector('.hn-quote-block'),tools=h.querySelector('.hn-thread-tools'),b=h.querySelector('.hn-resolve'),r=x=>{const r=x.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,left:r.left,right:r.right,bottom:r.bottom}};return {header:r(h),quote:r(quote),tools:r(tools),button:r(b),border:getComputedStyle(b).borderLeftWidth,overflow:document.querySelector('.hn-sidebar').scrollWidth>document.querySelector('.hn-sidebar').clientWidth+1,children:tools.childElementCount}})()`);
    const compact=geometry();assert.equal(compact.children,1);assert.equal(compact.border,'0px');assert.equal(compact.overflow,false);assert.ok(Math.abs(compact.tools.top-compact.quote.top)<1);assert.ok(compact.button.right<=compact.header.right+7);
    if(mobile){assert.equal(compact.button.width,44);assert.equal(compact.button.height,44);}
    await ev(`app.plugins.plugins.highnote.setCommentNavigation(true)`);
    assert.equal(ev(`document.querySelectorAll('[data-hn-navigation]').length`),4);
    const expanded=geometry();assert.ok(compact.quote.width>expanded.quote.width||compact.header.height<expanded.header.height,JSON.stringify({compact,expanded}));
    await ev(`app.plugins.plugins.highnote.setCommentNavigation(false)`);
    results.viewports.push({width,height,compact,expanded});
    if(width===360&&!mobile||width===440&&mobile){
      ev(`(()=>{document.activeElement?.blur();document.querySelectorAll('.notice-container').forEach(e=>e.remove());return true})()`);
      const clip=ev(`(()=>{const r=document.querySelector('.hn-sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
      const shot=JSON.parse(call('dev:cdp','method=Page.captureScreenshot',`params=${q({format:'png',clip})}`));writeFileSync(`${output}/${mobile?'手机紧凑评论':'桌面紧凑评论'}.png`,Buffer.from(shot.data,'base64'));
    }
  }
  ev(`(()=>{app.setting.open();app.setting.openTabById('highnote');return true})()`);
  await until(`[...app.setting.tabContentContainer.querySelectorAll('.setting-item')].some(e=>e.textContent.includes('显示评论导航按钮'))`);
  const toggle=`[...app.setting.tabContentContainer.querySelectorAll('.setting-item')].find(e=>e.textContent.includes('显示评论导航按钮')).querySelector('.checkbox-container')`;
  ev(`(()=>{${toggle}.click();return true})()`);await until(`app.plugins.plugins.highnote.settings.showCommentNavigation===true`);results.settingUI=true;
  ev(`(()=>{app.setting.close();return true})()`);call('plugin:reload','id=highnote');await until(`app.plugins.plugins.highnote?.settings.showCommentNavigation===true`);results.restart=true;
  await ev(`app.plugins.plugins.highnote.setCommentNavigation(false)`);
  ev(`(async()=>{const s=window.hnCompactCheck;await s.leaf.setViewState({type:'markdown',state:{...s.leaf.view.getState(),mode:'source'},active:true});app.plugins.plugins.highnote.modeChanged();return true})()`);
  await until(`!app.plugins.plugins.highnote.canModify && !document.querySelector('.hn-thread-tools')`);results.readOnlyNoBlank=true;
  writeFileSync(`${output}/${mobile?'移动端布局验证':'桌面布局验证'}.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {
  ev(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnCompactCheck;app.setting.close();for(const m of p.openModals)m.close();p.drafts.clear();await p.setDataDirectory(s.directory);p.settings=s.settings;await p.saveData(s.settings);s.leaf.detach();const f=app.vault.getAbstractFileByPath(${q(folder)});if(f)await app.vault.delete(f,true);await app.workspace.changeLayout(s.layout);delete window.hnCompactCheck;return true})()`);
  call('dev:cdp','method=Emulation.clearDeviceMetricsOverride');
}

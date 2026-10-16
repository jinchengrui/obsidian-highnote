import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const [cli, vault, screenshots] = process.argv.slice(2);
if (!cli || !vault) throw new Error('需要 CLI 和可丢弃的测试库名称');
const e = code => {
  const raw = execFileSync(cli, [`vault=${vault}`, 'eval', `code=(async()=>JSON.stringify(await(${code})))()`], {encoding:'utf8', timeout:30000});
  const line = raw.split('\n').find(line => line.startsWith('=> '));
  if (!line) throw new Error(raw);
  return JSON.parse(line.slice(3));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i=0; i<100; i++) { if(e(code)) return; await pause(50); }
  throw new Error(`等待超时：${code}`);
}
const p = 'app.plugins.plugins.highnote', v = "app.workspace.getLeavesOfType('highnote-review')[0].view";
const key = `热力图验收${Date.now()}`, widths = [];
const data = e(`(async()=>{
  const p=${p};await p.openReview();const view=${v};for(const leaf of [...app.workspace.getLeavesOfType('markdown')])leaf.detach();p.reviewSources.clear();
  window.hnHeatOriginal={size:require('electron').remote.getCurrentWindow().getSize(),state:view.getState(),left:app.workspace.leftSplit.collapsed,theme:document.body.classList.contains('theme-dark'),right:app.workspace.rightSplit.collapsed};
  app.workspace.rightSplit.collapse();app.workspace.leftSplit.collapse();
  const source='# 热力图'+String.fromCharCode(10,10)+'原文上下文。';await app.vault.create('${key}.md',source);
  const t=await p.store.create('${key}.md',source,source.indexOf('原文'),source.length,'${key} 主评论');await p.store.reply(t.id,'${key} 回复');await p.store.reply(t.id,'${key} 补充');
  const today=new Date();const local=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  await p.store.update(t.id,t=>{const dates=[new Date(today.getFullYear()-2,today.getMonth(),today.getDate(),12),new Date(today.getFullYear(),today.getMonth(),today.getDate()-1,12),today];for(let i=0;i<3;i++)t.messages[i].createdAt=t.messages[i].updatedAt=dates[i].toISOString()});
  p.syncReview();view.kind='comments';view.viewScope='current';view.sourcePath='${key}.md';view.query='${key}';view.search.value=view.query;view.includeReplies=true;view.selectedDay='';view.calendarOpen=true;view.heatEndWeek='';view.refresh(true);await app.workspace.revealLeaf(view.leaf);
  return {id:t.id,today:local(today)};
})()`);
try {
  for (const width of [320,390,680,1024,1280,1920]) {
    e(`(()=>{require('electron').remote.getCurrentWindow().setSize(${width},960);return true})()`);
    await until(`window.innerWidth===${width} && ${v}.heatGrid.getBoundingClientRect().width>0 && ${v}.heatWeeks===Math.max(1,Math.floor(${v}.heatGrid.getBoundingClientRect().width/22))`);
    await pause(100);
    const layout = e(`(()=>{
      const view=${v},grid=view.heatGrid,r=grid.getBoundingClientRect(),cells=[...grid.querySelectorAll('.hn-review-day span')];
      const first=cells[0].getBoundingClientRect(),last=cells[(view.heatWeeks-1)*7].getBoundingClientRect();
      const labels=[...view.heatMonths.children].map(x=>{const r=x.getBoundingClientRect();return {left:r.left,right:r.right}});
      return {width:${width},grid:r.width,weeks:view.heatWeeks,days:grid.children.length,left:first.left-r.left,right:r.right-last.right,cell:first.width,height:r.height,
        overflow:view.contentEl.scrollWidth>view.contentEl.clientWidth+2,labelsFit:labels.every((x,i)=>x.left>=r.left-1&&x.right<=r.right+1&&(!i||x.left>=labels[i-1].right)),card:view.feed.querySelector('article').getBoundingClientRect().width};
    })()`);
    assert.equal(layout.days, layout.weeks*7);assert.equal(layout.height,154);
    assert.ok(layout.left<7 && layout.right<7,JSON.stringify(layout));assert.equal(layout.overflow,false,JSON.stringify(layout));
    assert.equal(layout.labelsFit,true,JSON.stringify(layout));assert.ok(layout.card<=882);
    assert.ok(layout.cell===14||layout.cell===16);
    widths.push(layout);
    if(screenshots && [390,1280,1920].includes(width)) {
      mkdirSync(screenshots,{recursive:true});
      const bytes=e(`(async()=>{return(await require('electron').remote.getCurrentWindow().capturePage()).toPNG().toString('base64')})()`);
      writeFileSync(path.join(screenshots,width===390?'热力图铺满窄屏.png':width===1920?'热力图铺满宽屏.png':'热力图铺满参考宽度.png'),Buffer.from(bytes,'base64'));
    }
  }
  // Resizing changes only heatmap nodes, with no review scan or feed rendering.
  const cached=e(`(()=>{const view=${v},groups=view.allGroups,card=view.feed.firstElementChild,index=${p}.reviewIndex;
    window.hnHeatScan=index.search;window.hnHeatScans=0;index.search=function(...args){window.hnHeatScans++;return window.hnHeatScan.apply(this,args)};
    window.hnHeatIdentity={groups,card};require('electron').remote.getCurrentWindow().setSize(1024,960);return true})()`);
  assert.equal(cached,true);await pause(200);
  assert.equal(e(`(()=>{const view=${v};return view.allGroups===window.hnHeatIdentity.groups&&view.feed.firstElementChild===window.hnHeatIdentity.card&&window.hnHeatScans===0})()`),true);
  e(`(()=>{${p}.reviewIndex.search=window.hnHeatScan;delete window.hnHeatScan;delete window.hnHeatScans;delete window.hnHeatIdentity;return true})()`);
  const recent=e(`${v}.heatRangeLabel.textContent`);
  e(`(()=>{${v}.heatOlder.click();return true})()`);
  assert.notEqual(e(`${v}.heatRangeLabel.textContent`),recent);assert.equal(e(`${v}.heatNewer.disabled`),false);
  const oldEnd=e(`${v}.heatEndWeek`);
  e(`(()=>{require('electron').remote.getCurrentWindow().setSize(680,960);return true})()`);await pause(150);
  assert.equal(e(`${v}.heatEndWeek`),oldEnd);
  e(`(()=>{${v}.heatLatest.click();return true})()`);assert.equal(e(`${v}.heatLatest.disabled`),true);assert.equal(e(`${v}.heatNewer.disabled`),true);
  e(`(()=>{${v}.heatGrid.querySelector('[data-review-day="${data.today}"]').click();return true})()`);
  assert.equal(e(`${v}.query`),key);assert.equal(e(`document.querySelectorAll('.hn-review-body.is-date-hit').length`),1);
  assert.equal(e(`document.querySelector('.hn-review-day.is-today').getAttribute('aria-pressed')`),'true');
  const keyboard=e(`(()=>{const view=${v},button=view.heatGrid.querySelector('.is-today');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));return {from:button.dataset.reviewDay,to:document.activeElement.dataset.reviewDay}})()`);
  assert.notEqual(keyboard.from,keyboard.to);
  const before=e(`${v}.heatWeeks`);
  e(`(()=>{${v}.heatToggle.click();require('electron').remote.getCurrentWindow().setSize(390,960);return true})()`);await pause(150);
  assert.equal(e(`${v}.heatWeeks`),before);assert.equal(e(`getComputedStyle(${v}.heatBody).display`),'none');
  assert.notEqual(e(`getComputedStyle(${v}.heatSparse).display`),'none');
  e(`(()=>{${v}.heatSparse.click();${v}.heatToggle.click();return true})()`);
  await until(`${v}.heatWeeks===Math.floor(${v}.heatGrid.getBoundingClientRect().width/22)`);
  // Hidden tabs retain width; revealing triggers the observer again.
  e(`(()=>{${v}.contentEl.style.display='none';require('electron').remote.getCurrentWindow().setSize(1280,960);return true})()`);await pause(150);
  e(`(()=>{${v}.contentEl.style.display='';return true})()`);
  await until(`${v}.heatWeeks===Math.floor(${v}.heatGrid.getBoundingClientRect().width/22)`);
  e(`(()=>{document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');return true})()`);
  if(screenshots){await pause(100);const bytes=e(`(async()=>{return(await require('electron').remote.getCurrentWindow().capturePage()).toPNG().toString('base64')})()`);writeFileSync(path.join(screenshots,'热力图铺满深色.png'),Buffer.from(bytes,'base64'));}
  assert.equal(e(`${p}.store.get('${data.id}').messages.filter(m=>!m.deleted).length`),3);
} finally {
  e(`(async()=>{const saved=window.hnHeatOriginal;if(!saved)return true;const view=${v};view.contentEl.style.display='';require('electron').remote.getCurrentWindow().setSize(...saved.size);if(!saved.right)app.workspace.rightSplit.expand();if(!saved.left)app.workspace.leftSplit.expand();document.body.classList.toggle('theme-dark',saved.theme);document.body.classList.toggle('theme-light',!saved.theme);
    if(window.hnHeatScan){${p}.reviewIndex.search=window.hnHeatScan;delete window.hnHeatScan}await view.setState(saved.state,{});delete window.hnHeatOriginal;return true})()`);
}
console.log('通过：六种实际窗口宽度铺满、月份与图例、桌面/窄栏格子、翻页与最近、搜索和日期、今天与选中、折叠和隐藏恢复、键盘、缩放不重扫评论、浅深主题。');
console.log(JSON.stringify(widths));

import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli, vault] = process.argv.slice(2);
if (!cli || !vault) throw new Error('需要 CLI 与可丢弃的测试库名称');
const e = code => {
  const raw = execFileSync(cli, [`vault=${vault}`, 'eval', `code=(async()=>JSON.stringify(await(${code})))()`], {encoding:'utf8', timeout:30000});
  const line = raw.split('\n').find(line => line.startsWith('=> '));
  if (!line) throw new Error(raw);
  return JSON.parse(line.slice(3));
};
// Replace read accessors temporarily; source records and JSON remain untouched.
let result;
try {
  result = e(`(async()=>{
    const p=app.plugins.plugins.highnote;await p.openReview();const v=app.workspace.getLeavesOfType('highnote-review')[0].view;
    await p.flushAnchors();await p.store.idle();p.syncReview();
    const saved={index:p.reviewIndex,version:p.reviewVersion,all:p.store.viewAll,file:p.store.viewFile,settings:structuredClone(p.settings)};
    window.hnFlomoPerformanceRestore=saved;
    const template=p.store.viewAll()[0];
    const threads=Array.from({length:20000},(_,i)=>({...template,id:'CSV-performance-thread-'+i,filePath:'性能演示.md',originalQuote:'完整原文上下文',revision:1,
      messages:[{...template.messages[0],id:'CSV-performance-message-'+i,deleted:false,body:'大量评论正文 '.repeat(150)+i,createdAt:new Date(2026,0,1,0,i).toISOString(),updatedAt:new Date(2026,0,1,0,i).toISOString()}]}));
    p.store.viewAll=()=>threads;p.store.viewFile=()=>threads;
    p.reviewIndex=new saved.index.constructor();let start=performance.now();p.reviewIndex.sync(threads,[]);const indexMs=performance.now()-start;
    p.reviewVersion=p.store.version;p.settings.reviewExportFormat='flomo_csv';p.settings.flomo={group:'thread',includeReplies:true,preset:'context',labels:true,source:false,separator:'blank',customSeparator:'',custom:false,template:'{评论}'};
    v.kind='comments';v.viewScope='all';v.query='';v.search.value='';v.selectedDay='';v.includeReplies=true;start=performance.now();v.refresh(true);const renderMs=performance.now()-start;
    const cards=v.feed.querySelectorAll('article').length;
    start=performance.now();p.openReviewExport('comments','',true,undefined,'all','');const modal=[...p.openModals].find(m=>m.contentEl.classList.contains('hn-review-export'));const previewMs=performance.now()-start;
    const count=modal.rows.length,groups=modal.groups,rows=modal.rows,nodes=modal.contentEl.querySelectorAll('*').length;
    start=performance.now();modal.update();const cachedMs=performance.now()-start,cached=groups===modal.groups&&rows===modal.rows;
    modal.close();start=performance.now();const file=await p.exportReview('comments','不存在',false,'flomo性能完整导出','flomo_csv','all','',p.settings.flomo);const exportMs=performance.now()-start;
    return {indexMs,renderMs,previewMs,cachedMs,cached,exportMs,cards,count,nodes,path:app.vault.adapter.getFullPath(file.path)};
  })()`);
  assert.equal(result.count,20000);assert.equal(result.cards,40);assert.ok(result.nodes<300);assert.equal(result.cached,true);
  const count = Number(execFileSync('python3',['-c',"import csv,sys;from pathlib import Path;p=Path(sys.argv[1]);assert p.read_bytes().startswith(b'\\xef\\xbb\\xbf');r=csv.DictReader(p.open(encoding='utf-8-sig',newline=''));assert r.fieldnames==['content','created_at'];print(sum(1 for _ in r))",result.path],{encoding:'utf8'}));
  assert.equal(count,20000);
} finally {
  e(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnFlomoPerformanceRestore;if(!s)return true;
    for(const m of p.openModals)m.close();p.store.viewAll=s.all;p.store.viewFile=s.file;p.reviewIndex=s.index;p.reviewVersion=s.version;p.settings=s.settings;await p.saveData(p.settings);delete window.hnFlomoPerformanceRestore;
    const v=app.workspace.getLeavesOfType('highnote-review')[0].view;v.query='';v.search.value='';v.refresh(true);return true})()`);
}
console.log('通过：两万条完整 CSV 实机写入和标准解析，40卡片首屏，导出窗口仅预览一条，未改配置时复用生成结果。');
console.log(JSON.stringify(result));

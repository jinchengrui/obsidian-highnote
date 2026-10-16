import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const [cli, vault, screenshots] = process.argv.slice(2);
if (!cli || !vault) throw new Error('需要 CLI 与可丢弃的测试库名称');
const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {encoding:'utf8', timeout:30000}).trim();
const e = code => {
  const raw = call('eval', `code=(async()=>JSON.stringify(await (${code})))()`);
  const line = raw.split('\n').find(line => line.startsWith('=> '));
  if (!line) throw new Error(raw);
  return JSON.parse(line.slice(3));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  for (let i = 0; i < 100; i++) { if (e(code)) return; await pause(80); }
  throw new Error(`等待超时：${code}`);
}
const p = 'app.plugins.plugins.highnote', v = "app.workspace.getLeavesOfType('highnote-review')[0].view";
const key = `flomo验收${Date.now()}`, sourcePath = `${key}.md`;
const config = {group:'thread', includeReplies:true, preset:'context', labels:true, source:false, separator:'blank', customSeparator:'\n\n', custom:false, template:'原文\n{上下文}\n\n想法\n{评论}'};
const data = e(`(async()=>{
  const p=${p}; for(const m of p.openModals)m.close(); await p.openReview(); window.hnFlomoOriginalSettings=structuredClone(p.settings);
  p.settings.flomo=${JSON.stringify(config)};p.settings.reviewExportFormat='md';
  const source='# flomo验收'+String.fromCharCode(10,10)+'原文一含逗号，双引号"与{来源}。'+String.fromCharCode(10,10)+'其他原文。';
  await app.vault.create(${JSON.stringify(sourcePath)},source);
  const ids=[];
  for(let i=0;i<5;i++){
    const t=await p.store.create(${JSON.stringify(sourcePath)},source,source.indexOf('原文一'),source.indexOf('原文一')+'原文一含逗号，双引号"与{来源}。'.length,'评论'+i+'，"引号"'+String.fromCharCode(10)+'**加粗** {评论} <script>保留</script>');
    for(let j=0;j<(i===0?2:1);j++)await p.store.reply(t.id,'回复'+i+'-'+j+'😀');
    await p.store.update(t.id,t=>{t.resolved=i===1;for(let j=0;j<t.messages.length;j++)t.messages[j].createdAt=t.messages[j].updatedAt=new Date(Date.UTC(2026,9,14,16+i,j)).toISOString()});ids.push(t.id);
  }
  p.syncReview();const view=${v};view.kind='comments';view.viewScope='current';view.sourcePath=${JSON.stringify(sourcePath)};view.query='不匹配';view.search.value=view.query;view.includeReplies=false;view.selectedDay='2000-01-01';view.refresh(true);await app.workspace.revealLeaf(view.leaf);
  return {ids,base:app.vault.adapter.getBasePath()};
})()`);
const root = '.hn-review-export', field = name => `[aria-label=${JSON.stringify(name)}]`;
const choose = (name, value, type='change') => name==='正文排版' ? e(`(()=>{const f=document.querySelector('input[name="hn-flomo-preset"][value="${value}"]');f.checked=true;f.dispatchEvent(new Event('change'));return true})()`) : e(`(()=>{const f=document.querySelector(${JSON.stringify(`${root} ${field(name)}`)});${typeof value==='boolean' ? `f.checked=${value}` : `f.value=${JSON.stringify(value)}`};f.dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true}));return true})()`);
const selectFormat = format => e(`(()=>{const f=document.querySelector('input[name="hn-review-format"][value="${format}"]');f.checked=true;f.dispatchEvent(new Event('change'));return true})()`);
const open = () => e(`(()=>{${p}.openReviewExport('comments','不匹配',false,${v}.exportButton,'current',${JSON.stringify(sourcePath)});return true})()`);
const cancel = () => e(`(()=>{document.querySelector('${root} .hn-actions button').click();return true})()`);
const preview = () => e(`document.querySelector('.hn-csv-content').textContent`);
const total = () => e(`[...${p}.openModals].find(m=>m.contentEl.classList.contains('hn-review-export')).rows.length`);
const parse = filename => JSON.parse(execFileSync('python3', ['-c',
  "import csv,json,sys;from pathlib import Path;p=Path(sys.argv[1]);b=p.read_bytes();assert b.startswith(b'\\xef\\xbb\\xbfcontent,created_at\\r\\n');r=list(csv.DictReader(p.open(encoding='utf-8-sig',newline='')));assert all(set(x)=={'content','created_at'} for x in r);print(json.dumps(r,ensure_ascii=False))",
  path.join(data.base, filename)], {encoding:'utf8'}));

open(); selectFormat('flomo_csv');
assert.equal(total(),5); // Ignores the homepage's search, date and reply switch.
const first = preview();
assert.ok(first.startsWith('原文\n'));assert.ok(first.includes('想法\n'));assert.ok(first.includes('回复'));
assert.ok(first.includes('**加粗** {评论} <script>保留</script>'));
assert.ok(e(`document.querySelector('.hn-review-export-description').textContent.includes(${JSON.stringify(sourcePath)})`));
assert.ok(e(`[...document.querySelectorAll('${root} input[type=radio]')].filter(x=>x.getBoundingClientRect().width).every(x=>x.getBoundingClientRect().width<24)`));
for (let i=1;i<5;i++) e(`(()=>{document.querySelector('[aria-label="下一条导出预览"]').click();return true})()`);
assert.equal(e(`document.querySelector('[aria-label="下一条导出预览"]').disabled`),true);
e(`(()=>{document.querySelector('[aria-label="上一条导出预览"]').click();return true})()`);
choose('保存方式','message');assert.equal(total(),11);
choose('包含回复',false);assert.equal(total(),5);
choose('包含回复',true);choose('保存方式','thread');
choose('正文排版','comments');assert.ok(!preview().includes('原文\n'));
choose('显示“原文／想法”',false);assert.ok(!preview().includes('想法\n'));
choose('附上来源文档',true);assert.ok(preview().includes(`来源：${sourcePath.split('/').at(-1)}`));
choose('正文排版','context');choose('显示“原文／想法”',true);choose('附上来源文档',false);
choose('多次评论之间','custom');choose('连接文字','\n下一次想法：\n','input');
await until(`document.querySelector('.hn-flomo-preview-content').textContent.includes('下一次想法：')`);
choose('使用自定义模板',true);
assert.equal(e(`document.querySelector('${root} [aria-label="显示“原文／想法”"]').disabled`),true);
choose('正文模板','{未知}','input');await until(`document.querySelector('${root} .mod-cta').disabled && document.querySelector('.hn-flomo-error').textContent.includes('不支持')`);
choose('正文模板','{评论}\n{来源}\n{记录日期}\n/n \\n','input');
await until(`!document.querySelector('${root} .mod-cta').disabled`);
assert.ok(preview().includes('{评论} <script>'));assert.ok(preview().includes('/n \\n'));
choose('使用自定义模板',false);choose('多次评论之间','blank');
if (screenshots) {
  mkdirSync(screenshots,{recursive:true});
  for (const [theme,width,name] of [['theme-light','920px','flomo导出浅色.png'],['theme-dark','920px','flomo导出深色.png'],['theme-light','360px','flomo导出窄屏.png']]) {
    e(`(()=>{document.body.classList.remove('theme-light','theme-dark');document.body.classList.add('${theme}');document.querySelector('.hn-review-export-modal').style.width='${width}';return true})()`);await pause(150);
    assert.equal(e(`(()=>{const el=document.querySelector('${root}');return el.scrollWidth>el.clientWidth+2})()`),false);
    const bytes=e(`(async()=>{const win=require('electron').remote.getCurrentWindow();return(await win.capturePage()).toPNG().toString('base64')})()`);
    writeFileSync(path.join(screenshots,name),Buffer.from(bytes,'base64'));
  }
  e(`(()=>{document.querySelector('.hn-review-export-modal').style.width='920px';document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');return true})()`);
}
const actual = preview(), stamp = e(`document.querySelector('.hn-flomo-preview-date').textContent`);
choose('回顾导出文件名',`${key}-默认.csv`,'input');
e(`(()=>{const b=document.querySelector('${root} .mod-cta');b.click();b.click();return true})()`);
await until(`!document.querySelector('${root}') && !!app.vault.getFileByPath('${key}-默认.csv')`);
const parsed = parse(`${key}-默认.csv`);assert.equal(parsed.length,5);assert.equal(parsed[0].content,actual);assert.equal(parsed[0].created_at,stamp);
assert.equal(e(`app.vault.getFiles().filter(f=>f.path.startsWith('${key}-默认')).length`),1);
// Cancel does not save draft settings; successful settings survive reload.
open();assert.equal(total(),5);choose('包含回复',false);cancel();
open();assert.equal(e(`document.querySelector('${root} [aria-label="包含回复"]').checked`),true);cancel();
call('plugin:reload','id=highnote');await until(`!!${p}.store.get('${data.ids[0]}')`);open();assert.equal(e(`document.querySelector('input[name="hn-review-format"][value="flomo_csv"]').checked`),true);
choose('回顾导出文件名','../无效','input');assert.equal(e(`document.querySelector('${root} .mod-cta').disabled`),true);
choose('回顾导出文件名',`${key}-重试`,'input');
e(`(()=>{window.hnFlomoVaultCreate=app.vault.create;app.vault.create=async()=>{throw new Error('CSV保存失败验收')};document.querySelector('${root} .mod-cta').click();return true})()`);
await until(`document.querySelector('.hn-flomo-error').textContent.includes('CSV保存失败验收')`);
e(`(()=>{app.vault.create=window.hnFlomoVaultCreate;delete window.hnFlomoVaultCreate;document.querySelector('${root} .mod-cta').click();return true})()`);
await until(`!document.querySelector('${root}') && !!app.vault.getFileByPath('${key}-重试.csv')`);
assert.equal(parse(`${key}-重试.csv`).length,5);
// Scope and all original formats export full messages. Deleting a primary never promotes replies.
const formats = e(`(async()=>{const p=${p};const m=await p.exportReview('comments','不匹配',false,'${key}-阅读','md','current',${JSON.stringify(sourcePath)});window.hnFlomoBrowserOpen=p.openExportInBrowser;p.openExportInBrowser=async()=>{};const h=await p.exportReview('comments','不匹配',false,'${key}-网页','html','current',${JSON.stringify(sourcePath)});p.openExportInBrowser=window.hnFlomoBrowserOpen;delete window.hnFlomoBrowserOpen;return {md:await app.vault.read(m),html:await app.vault.read(h)}})()`);
assert.ok(formats.md.includes('5 处摘录 · 11 条记录'));assert.ok(formats.html.includes('5 处摘录 · 11 条记录'));
assert.ok(formats.md.indexOf('> 原文')<formats.md.indexOf('评论'));assert.ok(formats.html.includes('<details>'));assert.ok(!formats.html.includes('<script>'));
e(`(async()=>{const t=${p}.store.get('${data.ids[0]}');await ${p}.store.deleteMessage(t.id,t.messages[0].id,false);await app.workspace.revealLeaf(${v}.leaf);return true})()`);
open();selectFormat('flomo_csv');choose('包含回复',false);assert.equal(total(),4);choose('包含回复',true);assert.equal(total(),5);cancel();
const duplicate = e(`(async()=>{const f=await ${p}.exportReview('comments','',true,'${key}-默认.csv','flomo_csv','current',${JSON.stringify(sourcePath)},${JSON.stringify(config)});return f.path})()`);
assert.equal(duplicate,`${key}-默认(1).csv`);
e(`(async()=>{const p=${p};p.settings=window.hnFlomoOriginalSettings;await p.saveData(p.settings);delete window.hnFlomoOriginalSettings;const view=${v};view.query=${JSON.stringify(key)};view.search.value=view.query;view.selectedDay='';view.includeReplies=true;view.refresh(true);await app.workspace.revealLeaf(view.leaf);return true})()`);
console.log('通过：三格式、5段/11消息、范围隔离、预览与标准CSV解析一致、时间、单次模板替换、连接符、校验、取消/保存/重载、失败重试、连点防重、重名、已删主评论、浅深主题与窄屏。');
console.log(JSON.stringify({csv:`${key}-默认.csv`,rows:parsed.length}));

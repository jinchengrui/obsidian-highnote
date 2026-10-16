import {execFileSync} from 'node:child_process';
import {writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [cli, vault, artifacts] = process.argv.slice(2);
if (!cli || !vault) throw new Error('需要 Obsidian CLI 与可丢弃测试库名称');
const e=code=>{const raw=execFileSync(cli,[`vault=${vault}`,'eval',`code=(async()=>JSON.stringify(await (${code})))()`],{encoding:'utf8',timeout:30000,maxBuffer:1e7});const line=raw.split('\n').find(l=>l.startsWith('=> '));if(!line)throw new Error(raw);return JSON.parse(line.slice(3));};
const key='CSV格式验收'+Date.now(),result={};
const original=e(`(()=>{return structuredClone(app.plugins.plugins.highnote.settings)})()`);
result.setup=e(`(async()=>{const p=app.plugins.plugins.highnote;for(const m of [...p.openModals])m.close();const text='只验证一个关键假设，双引号"原文"。';const file=await app.vault.create('${key}.md',text);const t=await p.store.create(file.path,text,0,text.length,'第一条，"想法"'+String.fromCharCode(10)+'第二行');await p.store.reply(t.id,'👌 哈哈');await p.openReview();const v=app.workspace.getLeavesOfType('highnote-review')[0].view;v.viewScope='current';v.sourcePath=file.path;v.kind='comments';v.query='';v.search.value='';v.selectedDay='';p.syncReview();v.refresh(true);v.exportButton.click();const m=[...p.openModals].find(m=>m.contentEl.classList.contains('hn-review-export'));m.contentEl.querySelector('input[value="flomo_csv"]').click();const custom=m.contentEl.querySelector('[aria-label="使用自定义模板"]');if(custom.checked)custom.click();return {id:t.id,path:file.path}})()`);
result.preview=e(`(()=>{const m=[...app.plugins.plugins.highnote.openModals].find(m=>m.contentEl.classList.contains('hn-review-export'));const row=m.rows[0];const content=m.contentEl.querySelector('.hn-csv-content').textContent;const table=m.contentEl.querySelectorAll('th');return {content,time:m.contentEl.querySelector('.hn-csv-created').textContent,headers:[...table].map(x=>x.textContent),rowContent:row.content,rowTime:row.created_at,extension:m.extension.textContent,presetHidden:m.presetOptions.hidden,templateHidden:m.templateOptions.hidden}})()`);
assert.deepEqual(result.preview.headers,['content','created_at']);assert.equal(result.preview.extension,'.csv');assert.equal(result.preview.content,result.preview.rowContent);assert.equal(result.preview.time,result.preview.rowTime);
result.full=e(`(()=>{const p=app.plugins.plugins.highnote;const m=[...p.openModals].find(m=>m.contentEl.classList.contains('hn-review-export'));m.fullPreview.click();const full=[...p.openModals].find(m=>m.contentEl.classList.contains('hn-full-preview'));const content=full.contentEl.querySelector('.hn-full-preview-text').textContent;full.close();m.name.value='${key}.csv';m.name.dispatchEvent(new Event('input'));m.submit.click();return {content}})()`);assert.equal(result.full.content,result.preview.content);
let filename;
for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,50));filename=e(`(()=>{return app.vault.getFileByPath('${key}.csv')?.path??null})()`);if(filename)break;}
assert.equal(filename,key+'.csv');
result.saved=JSON.parse(execFileSync('python3',['-c',"import csv,json,sys;from pathlib import Path;p=Path(sys.argv[1]);b=p.read_bytes();assert b.startswith(b'\\xef\\xbb\\xbfcontent,created_at\\r\\n');r=list(csv.DictReader(p.open(encoding='utf-8-sig',newline='')));print(json.dumps(r,ensure_ascii=False))",path.join(e('app.vault.adapter.getBasePath()'), filename)],{encoding:'utf8'}));
assert.deepEqual(result.saved,[{content:result.preview.content,created_at:result.preview.time}]);
result.details=e(`(async()=>{const p=app.plugins.plugins.highnote,v=app.workspace.getLeavesOfType('highnote-review')[0].view;v.feed.querySelector('.hn-review-details-link').click();const m=[...p.openModals].find(m=>m.contentEl.classList.contains('hn-review-details'));const buttons=m.contentEl.querySelectorAll('.hn-review-details-actions button');const labels=[...buttons].map(x=>x.getAttribute('aria-label'));const text=m.contentEl.textContent;const r=m.modalEl.getBoundingClientRect();m.close();return {labels,height:r.height,oldButtons:text.includes('打开原文')||text.includes('在原文查看讨论')}})()`);
assert.deepEqual(result.details.labels,['回到原文']);assert.equal(result.details.oldButtons,false);
e(`(async()=>{const p=app.plugins.plugins.highnote;p.settings=${JSON.stringify(original)};await p.saveData(p.settings);return true})()`);
if(artifacts){mkdirSync(artifacts,{recursive:true});writeFileSync(path.join(artifacts,'导出交互结果.json'),JSON.stringify(result,null,2));}
console.log('通过：真实CSV按钮保存.csv，BOM和两列标准解析与预览一致，完整内容读取、取消和唯一返回原文入口。');
console.log(JSON.stringify({file:filename,rows:result.saved.length,headers:result.preview.headers,details:result.details}));

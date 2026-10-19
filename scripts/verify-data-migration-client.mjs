import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli,vault] = process.argv.slice(2);
if(!cli || !vault)throw new Error('Usage: node scripts/verify-data-migration-client.mjs obsidian-cli test-vault');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:20000}).trim();
const ev=code=>{const out=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=out.split('\n').find(s=>s.startsWith('=> '));if(!line){if(out==='(no output)')return;throw new Error(out);}return JSON.parse(line.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<60;i++){if(ev(code))return;await pause(100);}throw new Error(code);}
const root=`Highnote迁移验收-${Date.now()}`,source=root+'/旧目录',sourceData=source+'/annotations',target=root+'/新目录/annotations',note=root+'/笔记.md';
const q=JSON.stringify,results={};
ev(`(()=>{const p=app.plugins.plugins.highnote;window.hnMigrationCheck={layout:app.workspace.getLayout(),settings:structuredClone(p.settings),initial:p.dataFolder};app.setting.close();return true})()`);
try{
 ev(`(async()=>{const p=app.plugins.plugins.highnote;await p.setDataDirectory(${q(sourceData)});await app.vault.createFolder(${q(root)});const file=await app.vault.create(${q(note)},'# 迁移验收\\n\\n这是需要保留的原始句子。');const leaf=app.workspace.getLeaf('tab');window.hnMigrationCheck.leaf=leaf;await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);const text=await app.vault.read(file),from=text.indexOf('这是');const thread=await p.store.create(file.path,text,from,text.length,'迁移前评论');await p.store.reply(thread.id,'需要保留的回复');const highlight=await p.store.createHighlight(file.path,text,from,text.length);window.hnMigrationCheck.thread=thread.id;window.hnMigrationCheck.highlight=highlight.id;await p.store.idle();return true})()`);
 const baseline=ev(`(async()=>{const s=window.hnMigrationCheck,files=(await app.vault.adapter.list(${q(sourceData)})).files;s.file=files.find(f=>f.endsWith('.json'));s.raw=await app.vault.adapter.read(s.file);return s.raw})()`);
 ev(`(()=>{app.setting.open();app.setting.openTabById('highnote');return true})()`);
 await until(`!!app.setting.tabContentContainer.querySelector('[aria-label="迁移源目录"]')`);
 const initial=ev(`(()=>{const r=app.setting.tabContentContainer;return {source:r.querySelector('[aria-label="迁移源目录"]').value,target:r.querySelector('[aria-label="迁移目标目录"]').value}})()`);
 assert.deepEqual(initial,{source:'.obsidian-highnote',target:'Highnote/annotations'});results.defaults=true;
 // Keeping the prefilled target is sufficient to migrate; no destination typing required.
 ev(`(()=>{const r=app.setting.tabContentContainer,input=r.querySelector('[aria-label="迁移源目录"]');input.value=${q(source)};input.dispatchEvent(new input.ownerDocument.defaultView.Event('input'));window.hnMigrationCheck.defaultFile='Highnote/annotations/'+window.hnMigrationCheck.file.split('/').at(-1);r.querySelector('.hn-migration-setting button').click();return true})()`);
 await until(`app.plugins.plugins.highnote.dataFolder==='Highnote/annotations' && !app.plugins.plugins.highnote.changingDataDirectory`);
 await until(`app.setting.tabContentContainer.querySelector('.hn-migration-setting .hn-directory-status')?.textContent.includes('迁移完成')`);
 assert.equal(ev('app.vault.adapter.read(window.hnMigrationCheck.defaultFile)'),baseline);results.prefilledTargetMigration=true;
 ev(`(async()=>{app.setting.close();await app.plugins.plugins.highnote.setDataDirectory(${q(sourceData)});await app.vault.adapter.remove(window.hnMigrationCheck.defaultFile);return true})()`);
 call('plugin:reload','id=highnote');ev(`(()=>{app.setting.open();app.setting.openTabById('highnote');return true})()`);
 await until(`!!app.setting.tabContentContainer.querySelector('[aria-label="迁移源目录"]')`);
 // Clearing a prefilled field reports the exact missing field without starting migration.
 for(const [label,value,message] of [['迁移目标目录','','请填写迁移目标目录'],['迁移目标目录','   ','请填写迁移目标目录'],['迁移源目录','   ','请填写迁移源目录']]) {
  ev(`(()=>{const r=app.setting.tabContentContainer,input=r.querySelector('[aria-label="'+${q(label)}+'"]');input.value=${q(value)};input.dispatchEvent(new input.ownerDocument.defaultView.Event('input'));r.querySelector('.hn-migration-setting button').click();return true})()`);
  await until(`app.setting.tabContentContainer.querySelector('.hn-migration-setting .hn-directory-status')?.textContent.includes(${q(message)})`);
  const validation=ev(`(()=>{const r=app.setting.tabContentContainer,input=r.querySelector('[aria-label="'+${q(label)}+'"]');return {focused:input.ownerDocument.activeElement===input,invalid:input.getAttribute('aria-invalid'),busy:app.plugins.plugins.highnote.changingDataDirectory,status:r.querySelector('.hn-migration-setting .hn-directory-status').textContent}})()`);
  assert.equal(validation.focused,true);assert.equal(validation.invalid,'true');assert.equal(validation.busy,false);assert.ok(!validation.status.includes('已复制'));
  assert.equal(ev('app.plugins.plugins.highnote.dataFolder'),sourceData);
 }
 results.emptyFieldValidation=true;
 ev(`(()=>{const r=app.setting.tabContentContainer;for(const [label,value] of [['迁移源目录',${q(source)}],['迁移目标目录',${q(target)}]]){const input=r.querySelector('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new input.ownerDocument.defaultView.Event('input'));}r.querySelector('.hn-migration-setting button').click();return true})()`);
 await until(`app.plugins.plugins.highnote.dataFolder===${q(target)} && !app.plugins.plugins.highnote.changingDataDirectory`);
 await until(`app.setting.tabContentContainer.querySelector('.hn-migration-setting .hn-directory-status')?.textContent.includes('迁移完成')`);
 const after=ev(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnMigrationCheck;const files=(await app.vault.adapter.list(${q(target)})).files;return {source:await app.vault.adapter.read(s.file),target:await app.vault.adapter.read(files.find(f=>f.endsWith('.json'))),replies:p.store.get(s.thread).messages.map(m=>m.body),highlight:!!p.store.getHighlight(s.highlight),setting:app.setting.tabContentContainer.querySelector('[aria-label="批注数据目录"]').value}})()`);
 assert.equal(after.source,baseline);assert.equal(after.target,baseline);assert.deepEqual(after.replies,['迁移前评论','需要保留的回复']);assert.ok(after.highlight);assert.equal(after.setting,target);results.oneClickMigration=true;results.exactPreservation=true;
 // Save failure cannot commit the directory change, and repeated clicks cannot start another migration.
 ev(`(async()=>{app.setting.close();await app.plugins.plugins.highnote.setDataDirectory(${q(sourceData)});return true})()`);
 const guarded=ev(`(async()=>{const p=app.plugins.plugins.highnote,save=p.saveData;let locked=false,saveFailed=false;p.saveData=async()=>{throw new Error('模拟设置写入失败');};try{await p.migrateDataDirectory(${q(source)},${q(target)},()=>{try{p.requireReadingMode()}catch{locked=true;}})}catch{saveFailed=true}finally{p.saveData=save}return {locked,saveFailed,current:p.dataFolder}})()`);
 assert.ok(guarded.locked&&guarded.saveFailed);assert.equal(guarded.current,sourceData);results.saveFailureRetained=true;
 const retry=ev(`(async()=>{const p=app.plugins.plugins.highnote;let concurrentBlocked=false,writeBlocked=false;const result=await p.migrateDataDirectory(${q(source)},${q(target)},()=>{if(!window.hnMigrationCheck.nested){window.hnMigrationCheck.nested=Promise.all([p.setDataDirectory('Forbidden').catch(()=>{concurrentBlocked=true}),p.store.reply(window.hnMigrationCheck.thread,'禁止写入').catch(()=>{writeBlocked=true})]);}});await window.hnMigrationCheck.nested;return {copied:result.copied,skipped:result.skipped,concurrentBlocked,writeBlocked}})()`);
 assert.deepEqual(retry,{copied:0,skipped:1,concurrentBlocked:true,writeBlocked:true});results.retryAndWriteLock=true;
 call('plugin:reload','id=highnote');await until(`app.plugins.plugins.highnote.dataFolder===${q(target)} && !!app.plugins.plugins.highnote.store.get(window.hnMigrationCheck.thread)`);results.restart=true;
 assert.equal(ev('app.vault.adapter.read(window.hnMigrationCheck.file)'),baseline);
 console.log(JSON.stringify(results,null,2));
}finally{
 ev(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnMigrationCheck;app.setting.close();for(const m of p.openModals)m.close();await p.setDataDirectory(s.initial);p.settings=s.settings;await p.saveData(s.settings);if(s.defaultFile && await app.vault.adapter.exists(s.defaultFile))await app.vault.adapter.remove(s.defaultFile);s.leaf?.detach();const folder=app.vault.getAbstractFileByPath(${q(root)});if(folder)await app.vault.delete(folder,true);else if(await app.vault.adapter.exists(${q(root)}))await app.vault.adapter.rmdir(${q(root)},true);await app.workspace.changeLayout(s.layout);delete window.hnMigrationCheck;return true})()`);
}

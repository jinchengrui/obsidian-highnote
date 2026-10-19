import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli,vault] = process.argv.slice(2);
if(!cli || !vault)throw new Error('Usage: node scripts/verify-data-directory-client.mjs obsidian-cli test-vault');
const call=(...args)=>execFileSync(cli,[`vault=${vault}`,...args],{encoding:'utf8',timeout:20000}).trim();
const ev=code=>{const out=call('eval',`code=(async()=>JSON.stringify(await (${code})))()`);const line=out.split('\n').find(s=>s.startsWith('=> '));if(!line){if(out==='(no output)')return;throw new Error(out);}return JSON.parse(line.slice(3));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<50;i++){if(ev(code))return;await pause(100);}throw new Error(code);}
const root=`Highnote目录配置验收-${Date.now()}`, a=root+'/甲/annotations', b=root+'/乙/annotations', note=root+'/笔记.md';
const results={};
ev(`(()=>{const p=app.plugins.plugins.highnote;window.hnDirectoryCheck={layout:app.workspace.getLayout(),settings:structuredClone(p.settings),initial:p.dataFolder};app.setting.close();return true})()`);
try{
 ev(`(async()=>{await app.plugins.plugins.highnote.setDataDirectory(${JSON.stringify(a)});await app.vault.createFolder(${JSON.stringify(root)});const file=await app.vault.create(${JSON.stringify(note)},'# 目录验收\\n\\n这是用于目录配置的原文。');const leaf=app.workspace.getLeaf('tab');window.hnDirectoryCheck.leaf=leaf;await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);return true})()`);
 ev(`(async()=>{const p=app.plugins.plugins.highnote,source=await app.vault.read(app.vault.getFileByPath(${JSON.stringify(note)}));const t=await p.store.create(${JSON.stringify(note)},source,source.indexOf('这是'),source.length,'甲目录评论');await p.store.createHighlight(${JSON.stringify(note)},source,source.indexOf('原文'),source.indexOf('原文')+2);window.hnDirectoryCheck.thread=t.id;window.hnDirectoryCheck.source=source;return true})()`);
 await until(`!!app.plugins.plugins.highnote.dataWatcher`);
 const baseline=ev(`(async()=>{const files=(await app.vault.adapter.list(${JSON.stringify(a)})).files;const raw=await app.vault.adapter.read(files.find(f=>f.endsWith('.json')));window.hnDirectoryCheck.file=files.find(f=>f.endsWith('.json'));return raw})()`);
 // Change via the actual settings input and Apply button.
 ev(`(()=>{app.setting.open();app.setting.openTabById('highnote');return true})()`);
 await until(`!!app.setting.tabContentContainer.querySelector('[aria-label="批注数据目录"]')`);
 ev(`(()=>{const r=app.setting.tabContentContainer.querySelector('.hn-directory-setting'),input=r.querySelector('input');input.value=${JSON.stringify(b)};input.dispatchEvent(new Event('input'));[...r.querySelectorAll('button')].find(b=>b.textContent==='应用').click();return true})()`);
 await until(`app.plugins.plugins.highnote.dataFolder===${JSON.stringify(b)} && !app.plugins.plugins.highnote.changingDataDirectory`);
 assert.equal(ev(`app.plugins.plugins.highnote.store.viewAll().length`),0);
 assert.equal(ev(`app.vault.adapter.read(window.hnDirectoryCheck.file)`),baseline);
 assert.equal(ev(`app.vault.adapter.exists(${JSON.stringify(b)})`),false);
 results.uiApply=true;results.oldPreserved=true;
 ev(`(async()=>{app.setting.close();const p=app.plugins.plugins.highnote,s=window.hnDirectoryCheck.source;const t=await p.store.create(${JSON.stringify(note)},s,s.indexOf('这是'),s.length,'乙目录评论');window.hnDirectoryCheck.second=t.id;return true})()`);
 await until(`!!app.plugins.plugins.highnote.dataWatcher`);
 const rawB=ev(`(async()=>{const files=(await app.vault.adapter.list(${JSON.stringify(b)})).files;window.hnDirectoryCheck.fileB=files.find(f=>f.endsWith('.json'));return app.vault.adapter.read(window.hnDirectoryCheck.fileB)})()`);
 assert.ok(rawB.includes('乙目录评论'));assert.ok(!rawB.includes('甲目录评论'));results.isolated=true;
 // Old stores cannot write into the new location; pending old watch callbacks must not act on it.
 const switched=ev(`(async()=>{const p=app.plugins.plugins.highnote;const old=p.store;await p.setDataDirectory(${JSON.stringify(a)});try{await old.reply(window.hnDirectoryCheck.second,'陈旧窗口回复');return false}catch{return true}})()`);
 assert.ok(switched);assert.equal(ev(`app.vault.adapter.read(window.hnDirectoryCheck.fileB)`),rawB);results.oldWriterBlocked=true;
 // A malformed target never replaces the working configuration or cached records.
 ev(`(async()=>{const bad=${JSON.stringify(root+'/损坏')};await app.vault.adapter.mkdir(bad);await app.vault.adapter.write(bad+'/note-'+ 'a'.repeat(32)+'.json','{bad');return true})()`);
 assert.ok(ev(`(async()=>{try{await app.plugins.plugins.highnote.setDataDirectory(${JSON.stringify(root+'/损坏')});return false}catch{return true}})()`));
 assert.equal(ev(`app.plugins.plugins.highnote.dataFolder`),a);
 assert.equal(ev(`app.plugins.plugins.highnote.store.get(window.hnDirectoryCheck.thread).messages[0].body`),'甲目录评论');
 const invalid=ev(`(async()=>{const p=app.plugins.plugins.highnote;const results=[];for(const path of ['../逃逸','/tmp/绝对路径','.obsidian/plugins/highnote']){try{await p.setDataDirectory(path);results.push(false)}catch{results.push(true)}}return results})()`);
 assert.deepEqual(invalid,[true,true,true]);results.rejections=true;
 const saveFailure=ev(`(async()=>{const p=app.plugins.plugins.highnote,save=p.saveData;p.saveData=async()=>{throw new Error('模拟设置写入失败');};try{await p.setDataDirectory(${JSON.stringify(b)});return false}catch{return true}finally{p.saveData=save}})()`);
 assert.ok(saveFailure);assert.equal(ev(`app.plugins.plugins.highnote.dataFolder`),a);
 assert.equal(ev(`app.plugins.plugins.highnote.store.get(window.hnDirectoryCheck.thread).messages[0].body`),'甲目录评论');results.saveFailureRetained=true;
 // Persisted settings survive plugin restart.
 call('plugin:reload','id=highnote');await until(`app.plugins.plugins.highnote.dataFolder===${JSON.stringify(a)} && !!app.plugins.plugins.highnote.store.get(window.hnDirectoryCheck.thread)`);
 results.restart=true;
 // External updates in the configured non-hidden directory refresh sidebar/review.
 ev(`(async()=>{const raw=JSON.parse(await app.vault.adapter.read(window.hnDirectoryCheck.file));raw.threads[0].messages[0].body='外部同步后的甲评论';raw.threads[0].revision++;raw.revision++;await app.vault.adapter.write(window.hnDirectoryCheck.file,JSON.stringify(raw,null,2));return true})()`);
 await until(`app.plugins.plugins.highnote.store.get(window.hnDirectoryCheck.thread)?.messages[0].body==='外部同步后的甲评论'`);
 results.watch=true;
 ev(`(()=>{app.plugins.plugins.highnote.drafts.set('test-draft','未发送');return true})()`);
 assert.ok(ev(`(async()=>{try{await app.plugins.plugins.highnote.setDataDirectory(${JSON.stringify(b)});return false}catch{return true}finally{app.plugins.plugins.highnote.drafts.delete('test-draft')}})()`));results.draftGuard=true;
 console.log(JSON.stringify(results,null,2));
}finally{
 ev(`(async()=>{const p=app.plugins.plugins.highnote,s=window.hnDirectoryCheck;app.setting.close();document.getSelection().removeAllRanges();for(const m of p.openModals)m.close();await p.setDataDirectory(s.initial);p.settings=s.settings;await p.saveData(s.settings);s.leaf?.detach();const folder=app.vault.getAbstractFileByPath(${JSON.stringify(root)});if(folder)await app.vault.delete(folder,true);else if(await app.vault.adapter.exists(${JSON.stringify(root)}))await app.vault.adapter.rmdir(${JSON.stringify(root)},true);await app.workspace.changeLayout(s.layout);delete window.hnDirectoryCheck;return true})()`);
}

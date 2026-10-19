import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [cli,vault]=process.argv.slice(2);
if(!cli||!vault)throw new Error('用法：node scripts/verify-recovery-client.mjs /path/to/obsidian-cli test-vault-name');
const evaluate=code=>{const raw=execFileSync(cli,[`vault=${vault}`,'eval',`code=(async()=>JSON.stringify(await (${code})))()`],{encoding:'utf8',timeout:20000}).trim();const line=raw.split('\n').find(l=>l.startsWith('=> '));if(!line)throw new Error(raw);return JSON.parse(line.slice(3));};
// 仅用于可丢弃的测试库。故意制造磁盘冲突，预期插件记录一次冲突错误。
const conflict=evaluate(`(async()=>{
 const p=app.plugins.plugins['highnote'];const path='冲突刷新验证'+Date.now()+'.md';const file=await app.vault.create(path,'前文目标原句后文');const l=app.workspace.getLeaf('tab');await l.openFile(file);await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:'source'},active:true});await app.workspace.revealLeaf(l);await new Promise(r=>setTimeout(r,100));
 const t=await p.store.create(path,'前文目标原句后文',2,6,'原评论');const h=await p.store.createHighlight(path,'前文目标原句后文',2,6);const entry=p.store.notes.get(path);const json=app.plugins.plugins.highnote.dataFolder+'/'+entry.key+'.json';
 p.drafts.set('inline:'+t.id,'保留输入草稿');p.pendingAnchors.set(t.id,{...t.anchor,before:'待保存上下文'});p.pendingHighlights.set(h.id,{...h.anchor,before:'待保存上下文'});
 const outside=JSON.parse(await app.vault.adapter.read(json));outside.threads[0].messages[0].body='磁盘最新评论';outside.threads[0].revision++;outside.revision++;await app.vault.adapter.write(json,JSON.stringify(outside,null,2));
 await p.refreshData();await p.flushAnchors();const latest=p.store.get(t.id);return {body:latest.messages[0].body,draft:p.drafts.get('inline:'+t.id),anchor:latest.anchor.state,highlight:p.store.getHighlight(h.id).anchor.state,pending:p.pendingAnchors.size+p.pendingHighlights.size};
})()`);
assert.deepEqual(conflict,{body:'磁盘最新评论',draft:'保留输入草稿',anchor:'attached',highlight:'attached',pending:0});
console.log('PASS: conflict refresh loads latest JSON, retains draft, recalculates both anchors, clears positional cache');

const stale=evaluate(`(async()=>{
 const p=app.plugins.plugins['highnote'];const text='# 同步基线\\n\\n前文。目标原句保持不变。后文。';const file=await app.vault.create('陈旧编辑器验证'+Date.now()+'.md',text);const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'preview'},active:true});await app.workspace.revealLeaf(leaf);await new Promise(r=>setTimeout(r,100));
 const from=text.indexOf('目标');const t=await p.store.create(file.path,text,from,from+10,'基线评论');const h=await p.store.createHighlight(file.path,text,from,from+10);p.knownSources.set(file.path,text);
 const stale='完全陈旧的旧窗口正文';const cm=[...p.editorViews][0];const makeChange=(old,next)=>cm.state.constructor.create({doc:old}).changes({from:0,to:old.length,insert:next});p.editorChanged(file.path,stale,text,makeChange(stale,text),false);await p.flushAnchors();await p.reconcileFile(file);
 const next='新增段落\\n\\n'+text;await app.vault.modify(file,next);await p.reconcileFile(file);const known=p.knownSources.get(file.path);p.editorChanged(file.path,stale,text,makeChange(stale,text),false);await p.flushAnchors();await p.reconcileFile(file);
 const ta=p.store.get(t.id).anchor;const ha=p.store.getHighlight(h.id).anchor;return {comment:ta.state,highlight:ha.state,from:ta.from,expected:next.indexOf('目标'),knownPreserved:p.knownSources.get(file.path)===known,pending:p.pendingAnchors.size+p.pendingHighlights.size};
})()`);
assert.equal(stale.comment,'attached');assert.equal(stale.highlight,'attached');assert.equal(stale.from,stale.expected);assert.equal(stale.knownPreserved,true);assert.equal(stale.pending,0);console.log('PASS: stale editor synchronization cannot overwrite reading source baseline or detach new comment/highlight');

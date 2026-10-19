import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DataAdapter} from 'obsidian';
import {migrateAnnotations} from '../src/data-migration';
import {directoryParents, savedDataDirectory, annotationDirectory} from '../src/data-directory';
import {DATA_FOLDER, LEGACY_DATA_ROOT} from '../src/model';
import {NoteFiles} from '../src/note-files';
import {noteKey, ThreadStore} from '../src/store';

function disk() {
  const data = new Map<string, string>(), folders = new Set<string>();
  const api = {
    async stat(path: string) { return data.has(path) ? {type:'file'} : folders.has(path) ? {type:'folder'} : null; },
    async exists(path: string) { return data.has(path) || folders.has(path); },
    async mkdir(path: string) { folders.add(path); },
    async list(path: string) { return {files:[...data.keys()].filter(key => key.startsWith(path+'/') && !key.slice(path.length+1).includes('/')), folders:[]}; },
    async read(path: string) { if (!data.has(path)) throw new Error('文件不存在'); return data.get(path)!; },
    async write(path: string, raw: string) { data.set(path, raw); },
    async remove(path: string) { data.delete(path); },
    async copy(from: string, to: string) { if (data.has(to)) throw new Error('目标已存在'); data.set(to, await api.read(from)); },
    async process(path: string, update: (raw: string) => string) { data.set(path, update(await api.read(path))); }
  };
  const adapter = api as unknown as DataAdapter;
  const put = (directory: string, key: string, raw: string) => {
    for (const parent of directoryParents(directory)) folders.add(parent);
    data.set(`${directory}/${key}.json`, raw);
  };
  const seed = async (directory: string, path = '笔记.md') => {
    const store = new ThreadStore(new NoteFiles(adapter, undefined, directory), () => {}, error => { throw error; });
    const thread = await store.create(path, '原始句子', 0, 4, '**评论**\n- 条目');
    await store.reply(thread.id, '二次回复');
    const highlight = await store.createHighlight(path, '原始句子', 0, 4);
    const key = await noteKey(path), file = `${directory}/${key}.json`;
    // Retain unknown fields and exact whitespace for forward compatibility.
    const raw = JSON.stringify({...JSON.parse(data.get(file)!), futureField: {value: '保留'}}, null, 2)+'\n';
    data.set(file, raw);
    return {key, file, raw, thread, highlight};
  };
  return {data, folders, api, adapter, seed, put};
}
const options = {configDirectory: '.obsidian'};
async function migrate(state: ReturnType<typeof disk>, source = LEGACY_DATA_ROOT, target = DATA_FOLDER) {
  const result = await migrateAnnotations(state.adapter, source, target, options);
  await result.verify();
  return result;
}

test('new installs use the visible default and explicit existing directories remain unchanged', () => {
  assert.equal(savedDataDirectory(undefined), 'Highnote/annotations');
  assert.equal(savedDataDirectory('.obsidian-highnote/annotations'), '.obsidian-highnote/annotations');
  assert.equal(savedDataDirectory('自定义/批注'), '自定义/批注');
  assert.equal(LEGACY_DATA_ROOT, '.obsidian-highnote');
});

test('legacy root and annotations child migrate byte-for-byte including replies, highlights and future fields', async () => {
  for (const source of [LEGACY_DATA_ROOT, LEGACY_DATA_ROOT+'/annotations']) {
    const state = disk(), entry = await state.seed(source);
    state.put(LEGACY_DATA_ROOT+'/exports', entry.key, 'not annotation data');
    state.data.set(LEGACY_DATA_ROOT+'/settings.json','{other}');
    const before = [...state.data], result = await migrate(state);
    assert.equal(result.copied, 1); assert.equal(result.skipped, 0);
    assert.equal(state.data.get(DATA_FOLDER+'/'+entry.key+'.json'), entry.raw);
    for (const [path, raw] of before) assert.equal(state.data.get(path), raw);
    const errors: unknown[] = [], loaded = new ThreadStore(new NoteFiles(state.adapter), () => {}, e => errors.push(e));
    await loaded.load(); assert.deepEqual(errors, []);
    assert.equal(loaded.get(entry.thread.id)?.messages[1]?.body, '二次回复');
    assert.equal(loaded.getHighlight(entry.highlight.id)?.id, entry.highlight.id);
  }
});

test('direct custom source works and root/child duplicates are copied only once', async () => {
  const state = disk(), first = await state.seed('自定义源'), second = await state.seed('自定义源/annotations','第二篇.md');
  state.put('自定义源/annotations',first.key,first.raw);
  const result = await migrate(state, '自定义源', '自定义目标/批注');
  assert.equal(result.copied, 2);assert.equal(result.total, 2);
  assert.equal(state.data.get('自定义目标/批注/'+second.key+'.json'),second.raw);
});

test('existing independent target notes survive and identical retry does not duplicate records', async () => {
  const state = disk(), existing = await state.seed(DATA_FOLDER, '目标已有.md');
  const source = await state.seed(LEGACY_DATA_ROOT);
  assert.equal((await migrate(state)).copied, 1);
  const second = await migrate(state);
  assert.equal(second.copied,0); assert.equal(second.skipped,1);
  assert.equal(state.data.get(existing.file),existing.raw);assert.equal(state.data.get(source.file),source.raw);
});

test('a conflicting target or duplicate source stops before any destination writes', async () => {
  for (const conflict of [DATA_FOLDER, LEGACY_DATA_ROOT+'/annotations']) {
    const state = disk(), first = await state.seed(LEGACY_DATA_ROOT);
    await state.seed(LEGACY_DATA_ROOT,'另一篇.md');state.put(conflict,first.key,first.raw+' ');
    const before = [...state.data];
    await assert.rejects(migrate(state), /同名不同|不同内容/u);
    assert.deepEqual([...state.data],before);
  }
});

test('malformed JSON, unsupported schema, wrong filename and duplicate IDs are rejected before copy', async () => {
  for (const bad of ['json','schema','filename','duplicate','target','bad-name']) {
    const state = disk(), entry = await state.seed(LEGACY_DATA_ROOT);
    const data = JSON.parse(entry.raw);
    if (bad === 'json') state.data.set(entry.file,'{broken');
    if (bad === 'schema') state.data.set(entry.file,JSON.stringify({...data,schemaVersion:500}));
    if (bad === 'filename') {state.data.delete(entry.file);state.put(LEGACY_DATA_ROOT,'note-'+'b'.repeat(32),entry.raw);}
    if (bad === 'duplicate') {
      const path = '重复标识.md';data.filePath=path;
      for (const item of [...data.threads,...data.highlights])item.filePath=path;
      state.put(LEGACY_DATA_ROOT,await noteKey(path),JSON.stringify(data));
    }
    if (bad === 'target') state.put(DATA_FOLDER,'note-'+'c'.repeat(32),'{broken');
    if (bad === 'bad-name') state.put(LEGACY_DATA_ROOT,'note-short',entry.raw);
    const before = [...state.data];await assert.rejects(migrate(state));assert.deepEqual([...state.data],before);
  }
});

test('missing source, empty source, invalid directories, nesting and configuration paths cannot start migration', async () => {
  const state = disk();
  for (const [source,target] of [[LEGACY_DATA_ROOT,DATA_FOLDER],['..',DATA_FOLDER],['/source',DATA_FOLDER],
    ['a','a'],['A','a/b'],['a/b','A'],['.obsidian',DATA_FOLDER],[LEGACY_DATA_ROOT,'.OBSIDIAN/plugins/highnote']]) {
    await assert.rejects(migrate(state, source, target));
  }
  state.folders.add(LEGACY_DATA_ROOT);await assert.rejects(migrate(state),/没有找到/u);
  assert.equal(state.data.size,0);
  assert.throws(() => annotationDirectory('.MyConfig/plugins',' .MyConfig'.trim()));
});

test('occupied target ancestor does not overwrite the file', async () => {
  const state=disk();await state.seed(LEGACY_DATA_ROOT);state.data.set('Highnote','ordinary file');
  await assert.rejects(migrate(state), /同名文件/u);assert.equal(state.data.get('Highnote'),'ordinary file');
});

test('copy interruption leaves sources intact and the next attempt reuses completed files', async () => {
  const state=disk();await state.seed(LEGACY_DATA_ROOT);await state.seed(LEGACY_DATA_ROOT,'第二篇.md');
  const before=[...state.data], copy=state.api.copy;let count=0;
  state.api.copy=async(from,to)=>{if(++count===2)throw new Error('模拟磁盘写入失败');await copy(from,to);};
  await assert.rejects(migrate(state),/模拟磁盘/u);
  for(const [path,raw] of before)assert.equal(state.data.get(path),raw);
  assert.equal([...state.data.keys()].filter(p=>p.startsWith(DATA_FOLDER+'/')).length,1);
  state.api.copy=copy;
  const result=await migrate(state);assert.equal(result.copied,1);assert.equal(result.skipped,1);
});

test('concurrent destination arrival cannot be overwritten by copying', async () => {
  const state=disk(), source=await state.seed(LEGACY_DATA_ROOT), copy=state.api.copy;
  state.api.copy=async(from,to)=>{state.data.set(to,'concurrent data');await copy(from,to);};
  await assert.rejects(migrate(state),/目标已存在/u);
  assert.equal(state.data.get(DATA_FOLDER+'/'+source.key+'.json'),'concurrent data');
  assert.equal(state.data.get(source.file),source.raw);
});

test('source edits during preflight and cancellation stop copying', async () => {
  for(const cancel of [true,false]) {
    const state=disk(),entry=await state.seed(LEGACY_DATA_ROOT);let stopped=false;
    await assert.rejects(migrateAnnotations(state.adapter,LEGACY_DATA_ROOT,DATA_FOLDER,{
      ...options,checkActive:()=>{if(stopped)throw new Error('已关闭');},
      progress:p=>{if(p.phase==='copying' && p.completed===0){if(cancel)stopped=true;else state.data.set(entry.file,entry.raw+' ');}}
    }),cancel?/已关闭/u:/发生变化/u);
    assert.ok(!state.folders.has(DATA_FOLDER));
  }
});

test('final verification detects source/target edits, removal and added files', async () => {
  for(const change of ['source-edit','target-edit','source-delete','target-delete','source-add','target-add']) {
    const state=disk(),entry=await state.seed(LEGACY_DATA_ROOT);
    const result=await migrateAnnotations(state.adapter,LEGACY_DATA_ROOT,DATA_FOLDER,options);
    const target=DATA_FOLDER+'/'+entry.key+'.json';
    if(change==='source-edit')state.data.set(entry.file,entry.raw+' ');
    if(change==='target-edit')state.data.set(target,entry.raw+' ');
    if(change==='source-delete')state.data.delete(entry.file);
    if(change==='target-delete')state.data.delete(target);
    if(change==='source-add')await state.seed(LEGACY_DATA_ROOT,'新增.md');
    if(change==='target-add')await state.seed(DATA_FOLDER,'新增.md');
    await assert.rejects(result.verify());
  }
});

test('many note files are processed sequentially with bounded progress notifications', async () => {
  const state=disk();
  for(let i=0;i<200;i++)state.put(LEGACY_DATA_ROOT,await noteKey(`${i}.md`),JSON.stringify({schemaVersion:2,filePath:`${i}.md`,revision:1,threads:[],highlights:[]}));
  const read=state.api.read;let active=0,peak=0,updates=0;
  state.api.read=async path=>{active++;peak=Math.max(peak,active);await Promise.resolve();try{return await read(path);}finally{active--;}};
  const result=await migrateAnnotations(state.adapter,LEGACY_DATA_ROOT,DATA_FOLDER,{...options,progress:()=>updates++});await result.verify();
  assert.equal(result.copied,200);assert.equal(peak,1);assert.ok(updates<40);
});

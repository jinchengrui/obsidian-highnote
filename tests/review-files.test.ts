import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DataAdapter} from 'obsidian';
import {ReviewFiles} from '../src/review-files';
import {ThreadStore} from '../src/store';
import {DATA_ROOT, DATA_FOLDER} from '../src/model';

function disk() {
  const data = new Map<string, {raw: string; mtime: number}>();
  let reads = 0;
  const adapter = {
    stat: async (path: string) => path === DATA_ROOT || path === DATA_FOLDER ? {type: 'folder'}
      : data.has(path) ? {type: 'file', ctime: 1, mtime: data.get(path)!.mtime, size: data.get(path)!.raw.length} : null,
    exists: async (path: string) => path === DATA_ROOT || path === DATA_FOLDER || data.has(path),
    list: async () => ({files: [...data.keys()], folders: []}),
    read: async (path: string) => { reads++; return data.get(path)!.raw; },
    write: () => { throw new Error('unexpected write'); },
    process: () => { throw new Error('unexpected process'); },
    mkdir: () => { throw new Error('unexpected mkdir'); },
    remove: () => { throw new Error('unexpected remove'); }
  } as unknown as DataAdapter;
  return {data, adapter, reads: () => reads};
}

test('mobile files cache unchanged data, reload external updates, and force refresh preserved timestamps', async () => {
  const state = disk(), files = new ReviewFiles(state.adapter), key = `note-${'a'.repeat(32)}`, path = `${DATA_FOLDER}/${key}.json`;
  state.data.set(path, {raw: 'first', mtime: 1});
  assert.deepEqual(await files.list(), [key]);
  assert.equal(await files.read(key), 'first');
  assert.equal(await files.read(key), 'first'); assert.equal(state.reads(), 1);
  state.data.set(path, {raw: 'other', mtime: 2});
  assert.equal(await files.read(key), 'other'); assert.equal(state.reads(), 2);
  state.data.set(path, {raw: 'third', mtime: 2});
  files.invalidate(); assert.equal(await files.read(key), 'third');
  state.data.delete(path); assert.deepEqual(await files.list(), []);
  state.data.set(path, {raw: 'again', mtime: 2}); assert.equal(await files.read(key), 'again');
  await assert.rejects(files.create(), /不能修改/u); await assert.rejects(files.compareAndWrite(), /不能修改/u);
});

test('mobile reads from the configured directory and does not fall back to default data', async () => {
  const state = disk(), key = `note-${'a'.repeat(32)}`;
  state.data.set(`${DATA_FOLDER}/${key}.json`, {raw:'default data',mtime:1});
  state.data.set(`Custom/annotations/${key}.json`, {raw:'custom data',mtime:1});
  const files = new ReviewFiles(state.adapter, 'Custom/annotations');
  assert.equal(await files.read(key), 'custom data');
  assert.equal(await new ReviewFiles(state.adapter).read(key), 'default data');
  await assert.rejects(files.compareAndWrite(), /不能修改/u);
  assert.equal(state.data.get(`Custom/annotations/${key}.json`)?.raw, 'custom data');
});

test('mobile load needs no source files and never repairs or writes annotations; unchanged load retains record identity', async () => {
  const state = disk();
  const writer = new ThreadStore({list: async () => [], read: async key => {
    const entry = state.data.get(`${DATA_FOLDER}/${key}.json`);
    if (!entry) throw new Error('不存在');
    return entry.raw;
  },
    create: async (key, raw) => { state.data.set(`${DATA_FOLDER}/${key}.json`, {raw, mtime: 1}); },
    compareAndWrite: async () => {}}, () => {}, error => { throw error; });
  const thread = await writer.create('尚未同步的笔记.md', '原文摘录', 0, 4, '已保存评论');
  // Empty files retained after deletion must not trigger fresh review renders.
  const {createHash} = await import('node:crypto');
  const emptyKey = createHash('sha256').update('空笔记.md').digest('hex').slice(0,32);
  state.data.set(`${DATA_FOLDER}/note-${emptyKey}.json`, {raw: JSON.stringify({schemaVersion:2,filePath:'空笔记.md',revision:1,threads:[],highlights:[]}), mtime:1});
  const before = structuredClone([...state.data]);
  let changed = 0;
  const reader = new ThreadStore(new ReviewFiles(state.adapter), () => { changed++; }, error => { throw error; });
  await reader.load();
  const first = reader.viewAll()[0];
  assert.equal(first?.id, thread.id); assert.equal(first?.fileMissing, false);
  await reader.load(); assert.equal(changed, 1); assert.equal(reader.viewAll()[0], first); assert.equal(state.reads(), 2);
  assert.deepEqual([...state.data], before);
  await assert.rejects(reader.reply(thread.id, '手机不应能回复'), /不能修改/u);
  assert.equal(reader.get(thread.id)?.messages.length, 1);
  assert.deepEqual([...state.data], before);
});

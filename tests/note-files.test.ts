import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DataAdapter} from 'obsidian';
import {NoteFiles} from '../src/note-files';
import {DATA_FOLDER, DATA_ROOT} from '../src/model';
import {ThreadStore} from '../src/store';

const key = 'note-' + 'a'.repeat(32);
function disk() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let beforeProcess: ((path: string) => void) | undefined;
  const api = {
    async stat(path: string) { return files.has(path) ? {type: 'file'} : folders.has(path) ? {type: 'folder'} : null; },
    async exists(path: string) { return files.has(path) || folders.has(path); },
    async mkdir(path: string) {
      if (files.has(path)) throw new Error('file');
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent && !folders.has(parent)) throw new Error('parent directory missing');
      folders.add(path);
    },
    async list(path: string) {
      return {files: [...files.keys()].filter(file => file.startsWith(path + '/') && !file.slice(path.length + 1).includes('/')),
        folders: [...folders].filter(folder => folder.startsWith(path + '/'))};
    },
    async read(path: string) { if (!files.has(path)) throw new Error('不存在'); return files.get(path)!; },
    async write(path: string, raw: string) { files.set(path, raw); },
    async remove(path: string) { files.delete(path); },
    async copy(from: string, to: string) {
      if (files.has(to)) throw new Error('destination exists');
      if (!files.has(from)) throw new Error('不存在');
      files.set(to, files.get(from)!);
    },
    async process(path: string, edit: (raw: string) => string) {
      beforeProcess?.(path);
      if (!files.has(path)) throw new Error('不存在');
      const next = edit(files.get(path)!); files.set(path, next); return next;
    }
  };
  return {files, folders, api, adapter: api as unknown as DataAdapter, inject(callback: (path: string) => void) { beforeProcess = callback; }};
}

test('annotations are stored below the visible root and directories are only created when saving', async () => {
  assert.equal(DATA_ROOT, 'Highnote');
  assert.equal(DATA_FOLDER, 'Highnote/annotations');
  const state = disk(), files = new NoteFiles(state.adapter);
  assert.deepEqual(await files.list(), []); assert.equal(state.folders.size, 0);
  await files.create(key, 'saved');
  assert.equal(state.files.get(`${DATA_FOLDER}/${key}.json`), 'saved');
  assert.deepEqual(await files.list(), [key]);
  assert.deepEqual([...state.folders], [DATA_ROOT, DATA_FOLDER]);
  assert.equal(state.files.size, 1);
});

test('configured directories create ancestors on first save and isolate same-key data from the default', async () => {
  const state = disk(), old = new NoteFiles(state.adapter);
  await old.create(key, 'old record');
  const custom = new NoteFiles(state.adapter, undefined, 'Custom/批注/annotations');
  assert.deepEqual(await custom.list(), []);
  assert.equal(state.folders.has('Custom'), false);
  await custom.create(key, 'custom record');
  assert.deepEqual(await custom.list(), [key]);
  assert.equal(await old.read(key), 'old record');
  assert.equal(await custom.read(key), 'custom record');
  await custom.compareAndWrite(key, 'custom record', 'edited custom record');
  assert.equal(await old.read(key), 'old record');
  assert.ok(state.folders.has('Custom/批注/annotations'));
});

test('a file occupying a custom parent blocks both loading and saving without overwrites', async () => {
  const state = disk(); state.files.set('Highnote', 'existing note');
  const files = new NoteFiles(state.adapter, undefined, 'Highnote/annotations');
  await assert.rejects(files.list(), /同名文件/u);
  await assert.rejects(files.create(key, 'record'), /同名文件/u);
  assert.equal(state.files.get('Highnote'), 'existing note');
  assert.equal(state.folders.size, 0);
});

test('old test directories or files are ignored and never prevent saving new data', async () => {
  for (const oldIsFolder of [true, false]) {
    const state = disk();
    if (oldIsFolder) {
      state.folders.add('Highnote Data'); state.folders.add('Highnote Data/backup');
      state.files.set(`Highnote Data/${key}.json`, ' {"retained":"🍊"}\n');
      state.files.set('Highnote Data/backup/manual.json', '{bad');
    } else state.files.set('Highnote Data', 'not a directory');
    const beforeFiles = [...state.files], beforeFolders = [...state.folders];
    let ready = 0;
    const files = new NoteFiles(state.adapter, () => ready++);
    assert.deepEqual(await files.list(), []);
    assert.equal(ready, 0); assert.equal(state.folders.has(DATA_FOLDER), false);
    await assert.rejects(files.read(key), /不存在/u);
    await files.create(key, 'new');
    assert.equal(await files.read(key), 'new');
    assert.deepEqual(await files.list(), [key]);
    assert.deepEqual([...state.files].filter(([path]) => !path.startsWith(DATA_FOLDER + '/')), beforeFiles);
    assert.deepEqual([...state.folders].filter(path => path !== DATA_FOLDER && path !== DATA_ROOT), beforeFolders);
    assert.ok(ready >= 1);
  }
});

test('existing annotations directory loads and saves independently of an old directory', async () => {
  const state = disk(); state.folders.add('Highnote Data'); state.folders.add(DATA_ROOT); state.folders.add(DATA_FOLDER);
  state.files.set(`Highnote Data/${key}.json`, 'old'); state.files.set(`${DATA_FOLDER}/${key}.json`, 'new');
  const files = new NoteFiles(state.adapter);
  assert.deepEqual(await files.list(), [key]);
  assert.equal(await files.read(key), 'new');
  await files.compareAndWrite(key, 'new', 'changed');
  assert.equal(await files.read(key), 'changed');
  assert.equal(state.files.get(`Highnote Data/${key}.json`), 'old');
  assert.deepEqual([...state.folders], ['Highnote Data', DATA_ROOT, DATA_FOLDER]);
});

test('a file occupying the root or annotations directory blocks loading and saving without overwriting it', async () => {
  for (const path of [DATA_ROOT, DATA_FOLDER]) {
    const state = disk();
    if (path === DATA_FOLDER) state.folders.add(DATA_ROOT);
    state.files.set(path, 'not a directory');
    const folders = [...state.folders], files = new NoteFiles(state.adapter);
    await assert.rejects(files.list(), /同名文件/u);
    await assert.rejects(files.create(key, 'new'), /同名文件/u);
    assert.deepEqual([...state.files], [[path, 'not a directory']]);
    assert.deepEqual([...state.folders], folders);
  }
});

test('flat root records and other subdirectories are ignored while new annotations save independently', async () => {
  const state = disk(); state.folders.add(DATA_ROOT); state.folders.add(DATA_ROOT + '/exports');
  state.files.set(`${DATA_ROOT}/${key}.json`, 'flat test record');
  state.files.set(`${DATA_ROOT}/exports/${key}.json`, 'unrelated result');
  const before = [...state.files], files = new NoteFiles(state.adapter);
  assert.deepEqual(await files.list(), []);
  assert.equal(state.folders.has(DATA_FOLDER), false);
  await assert.rejects(files.read(key), /不存在/u);
  await files.create(key, 'new annotation');
  assert.deepEqual(await files.list(), [key]);
  assert.equal(await files.read(key), 'new annotation');
  assert.deepEqual([...state.files].filter(([path]) => !path.startsWith(DATA_FOLDER + '/')), before);
});

test('only direct valid note files load; temporary, malformed and nested entries are ignored', async () => {
  const state = disk(); state.folders.add(DATA_ROOT); state.folders.add(DATA_FOLDER);
  for (const name of [key + '.json', 'note-short.json', '.create-temp.tmp', 'README.md', 'nested/' + key + '.json']) state.files.set(`${DATA_FOLDER}/${name}`, 'data');
  assert.deepEqual(await new NoteFiles(state.adapter).list(), [key]);
});

test('hidden data uses atomic process and preserves a concurrent write', async () => {
  const state = disk(); const files = new NoteFiles(state.adapter);
  await files.create(key, 'before');
  await files.compareAndWrite(key, 'before', 'first change');
  state.inject(path => state.files.set(path, 'concurrent change'));
  await assert.rejects(files.compareAndWrite(key, 'first change', 'overwritten'), /停止保存/u);
  assert.equal(await files.read(key), 'concurrent change');
});

test('exclusive creation never overwrites a same-name record and removes temporary files', async () => {
  const state = disk(); const files = new NoteFiles(state.adapter);
  const results = await Promise.allSettled([files.create(key, 'first'), files.create(key, 'second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(['first', 'second'].includes(await files.read(key)));
  assert.equal(state.files.size, 1); assert.deepEqual(await files.list(), [key]);
});

test('temporary cleanup failure keeps the committed note successful and cleanup retries on load', async () => {
  const state = disk(); const files = new NoteFiles(state.adapter);
  const remove = state.api.remove;
  state.api.remove = async () => { throw new Error('temporary cleanup unavailable'); };
  await files.create(key, 'saved successfully');
  assert.equal(await files.read(key), 'saved successfully');
  assert.equal(state.files.size, 2);
  state.api.remove = remove;
  assert.deepEqual(await files.list(), [key]);
  assert.equal(state.files.size, 1);
});

test('invalid keys cannot escape the hidden data directory', async () => {
  const state = disk(); const files = new NoteFiles(state.adapter);
  for (const name of ['../escape', 'a/b', 'note-' + 'b'.repeat(64)]) {
    await assert.rejects(files.create(name, 'bad'), /标识无效/u);
    await assert.rejects(files.read(name), /标识无效/u);
  }
  assert.equal(state.files.size, 0); assert.equal(state.folders.size, 0);
});

test('hidden store records retain stable IDs across reload, note rename, deletion and path reuse', async () => {
  const state = disk(); const original = new NoteFiles(state.adapter);
  const store = new ThreadStore(original, () => {}, error => { throw error; });
  const thread = await store.create('笔记.md', '原文', 0, 2, '评论');
  const highlight = await store.createHighlight('笔记.md', '原文', 0, 2);
  await store.reply(thread.id, '回复');
  const reloaded = new ThreadStore(new NoteFiles(state.adapter), () => {}, error => { throw error; });
  await reloaded.load();
  assert.deepEqual(reloaded.get(thread.id)?.messages.map(message => message.body), ['评论', '回复']);
  assert.equal(reloaded.getHighlight(highlight.id)?.id, highlight.id);
  await reloaded.moveFile('笔记.md', '新名.md'); await reloaded.load();
  assert.equal(reloaded.get(thread.id)?.filePath, '新名.md');
  await reloaded.remove(thread.id); await reloaded.removeHighlight(highlight.id); await reloaded.load();
  assert.deepEqual(reloaded.paths(), []);
  const recreated = await reloaded.create('新名.md', '原文', 0, 2, '新评论');
  assert.equal(reloaded.get(recreated.id)?.messages[0]?.body, '新评论');
  assert.deepEqual([...state.folders], [DATA_ROOT, DATA_FOLDER]);
});
